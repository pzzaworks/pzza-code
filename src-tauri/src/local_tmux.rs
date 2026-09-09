// A persistent, per-user service owns the server. Associating the service with
// the app lets macOS apply the app's Local Network choice after UI restarts.
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LABEL: &str = "com.pzzacode.tmux";
const BUNDLE_ID: &str = "com.pzzacode.app";
const SERVER_ARGUMENT: &str = "--local-tmux-server";
static START_LOCK: Mutex<()> = Mutex::new(());

pub fn socket_path() -> PathBuf {
    // Keep the Unix socket comfortably below macOS's 104-byte limit, even
    // with a long home directory. The directory is private to this user.
    PathBuf::from(format!("/private/tmp/pzzacode-tmux-{}", unsafe {
        libc::geteuid()
    }))
    .join("server.sock")
}

fn private_directory(path: &Path) -> io::Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "The local terminal socket directory must be a private directory owned by this user",
        ));
    }
    Ok(())
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn service_plist(executable: &Path, path: &str) -> io::Result<String> {
    let executable = executable.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "The application path is not UTF-8",
        )
    })?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\"><dict>\n\
<key>Label</key><string>{LABEL}</string>\n\
<key>ProgramArguments</key><array><string>{}</string><string>{SERVER_ARGUMENT}</string></array>\n\
<key>AssociatedBundleIdentifiers</key><array><string>{BUNDLE_ID}</string></array>\n\
<key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string><key>LANG</key><string>en_US.UTF-8</string></dict>\n\
<key>RunAtLoad</key><true/>\n\
<key>KeepAlive</key><true/>\n\
<key>ThrottleInterval</key><integer>10</integer>\n\
<key>ProcessType</key><string>Interactive</string>\n\
</dict></plist>\n",
        xml(executable),
        xml(path),
    ))
}

fn write_service(path: &Path, contents: &str) -> io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    use std::io::Write;
    let suffix = crate::agent::random_hex(8)
        .ok_or_else(|| io::Error::other("Could not allocate a service configuration file"))?;
    let temporary = path.with_extension(format!("{suffix}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn bounded_output(command: &mut Command) -> io::Result<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Local terminal service command timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn client_command() -> Command {
    let mut command = Command::new("tmux");
    command
        .args(["-N", "-S"])
        .arg(socket_path())
        .env("PATH", crate::agent::login_path())
        .env_remove("TMUX");
    command
}

pub fn start() -> io::Result<()> {
    let _guard = START_LOCK
        .lock()
        .map_err(|_| io::Error::other("Local terminal startup interrupted"))?;
    let socket = socket_path();
    private_directory(socket.parent().unwrap())?;
    let home = std::env::var_os("HOME")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Home directory unavailable"))?;
    let directory = PathBuf::from(home).join("Library/LaunchAgents");
    fs::create_dir_all(&directory)?;
    let plist = directory.join(format!("{LABEL}.plist"));
    write_service(
        &plist,
        &service_plist(&std::env::current_exe()?, crate::agent::login_path())?,
    )?;
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    let target = format!("{domain}/{LABEL}");
    let loaded = bounded_output(Command::new("/bin/launchctl").args(["print", &target]))?;
    if !loaded.status.success() {
        let result = bounded_output(
            Command::new("/bin/launchctl")
                .args(["bootstrap", &domain])
                .arg(&plist),
        )?;
        if !result.status.success() {
            // Another app instance can register the same job concurrently.
            let loaded = bounded_output(Command::new("/bin/launchctl").args(["print", &target]))?;
            if !loaded.status.success() {
                return Err(io::Error::other(
                    "Could not register the local terminal service with the user login session",
                ));
            }
        }
    } else if UnixStream::connect(&socket).is_err() {
        // Start a stopped job without -k: an already running service and its
        // sessions must never be killed just because another UI opens.
        let result = bounded_output(Command::new("/bin/launchctl").args(["kickstart", &target]))?;
        if !result.status.success() {
            return Err(io::Error::other(
                "Could not start the local terminal service",
            ));
        }
    }
    // Never boot out a loaded job during an update: it owns live terminals.
    // launchd reuses the installed executable path on its next start.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if UnixStream::connect(&socket).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other("The local terminal service is unavailable. Check that background activity for PzzaCode is enabled and tmux is installed."));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn server_lock(directory: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("server.lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

fn run_server() -> io::Result<i32> {
    let socket = socket_path();
    let directory = socket.parent().unwrap();
    private_directory(directory)?;
    let _lock = server_lock(directory)?;
    if UnixStream::connect(&socket).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Refusing to replace an existing terminal server",
        ));
    }
    // Keep this signed helper alive as the responsible process. tmux must not
    // daemonize, and must not inherit a server selection from another terminal.
    let mut child = Command::new("tmux")
        .args(["-D", "-S"])
        .arg(&socket)
        .env_remove("TMUX")
        .env_remove("PZZA_TMUX_SOCKET")
        .stdin(Stdio::null())
        .spawn()?;
    let status = child.wait()?;
    Ok(status.code().unwrap_or(1))
}

pub fn headless_exit_code() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(SERVER_ARGUMENT)) {
        return None;
    }
    Some(match run_server() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("PzzaCode local terminal service: {error}");
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pzza-tmux-test-{}",
            crate::agent::random_hex(8).unwrap()
        ));
        private_directory(&path).unwrap();
        path
    }

    #[test]
    fn service_preserves_app_identity_and_escapes_paths() {
        let content = service_plist(
            Path::new("/Applications/Berke's & <App>.app/Contents/MacOS/app"),
            "/bin:&<tools>",
        )
        .unwrap();
        let directory = directory();
        let file = directory.join("job.plist");
        write_service(&file, &content).unwrap();
        assert!(Command::new("/usr/bin/plutil")
            .arg("-lint")
            .arg(&file)
            .status()
            .unwrap()
            .success());
        for key in ["AssociatedBundleIdentifiers", "KeepAlive", "RunAtLoad"] {
            assert!(content.contains(key));
        }
        assert!(content.contains("Berke&apos;s &amp; &lt;App&gt;"));
        assert!(content.contains(SERVER_ARGUMENT));
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_shared_and_symlinked_socket_directories() {
        let directory = directory();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            private_directory(&directory).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let link = directory.with_extension("link");
        symlink(&directory, &link).unwrap();
        assert!(private_directory(&link).is_err());
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn only_one_service_can_own_the_server() {
        let directory = directory();
        let first = server_lock(&directory).unwrap();
        assert!(server_lock(&directory).is_err());
        drop(first);
        assert!(server_lock(&directory).is_ok());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clients_cannot_start_an_unmanaged_server() {
        let command = client_command();
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args[0], "-N");
        assert_eq!(args[1], "-S");
        assert_eq!(args[2], socket_path());
        assert!(socket_path().as_os_str().len() < 100);
    }
}
