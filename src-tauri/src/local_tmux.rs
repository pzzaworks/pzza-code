// The per-user service lives while an app or terminal session needs it.
// Its signed owner preserves the app's Local Network choice across UI restarts.
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
static APP_LEASE: Mutex<Option<File>> = Mutex::new(None);

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
<key>RunAtLoad</key><false/>\n\
<key>KeepAlive</key><false/>\n\
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
    let lease = app_lease(socket.parent().unwrap())?;
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
    }
    // Never boot out a loaded job during an update: it owns live terminals.
    // An idle helper unregisters itself; the next launch reads the current plist.
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut next_start = Instant::now();
    loop {
        if UnixStream::connect(&socket).is_ok() && set_exit_empty(&socket, false).is_ok() {
            *APP_LEASE
                .lock()
                .map_err(|_| io::Error::other("Local terminal ownership interrupted"))? =
                Some(lease);
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other("The local terminal service is unavailable. Check that background activity for PzzaCode is enabled and tmux is installed."));
        }
        if UnixStream::connect(&socket).is_err() && Instant::now() >= next_start {
            // No -k: opening a UI must never kill existing terminal sessions.
            // Retry if the previous helper was still exiting on the first probe.
            let _ = bounded_output(Command::new("/bin/launchctl").args(["kickstart", &target]));
            next_start = Instant::now() + Duration::from_millis(500);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn lease_file(directory: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join("app.lock"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Local terminal ownership file is not private",
        ));
    }
    Ok(file)
}

fn app_lease(directory: &Path) -> io::Result<File> {
    let file = lease_file(directory)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

struct IdleLease<'a>(&'a File);

impl Drop for IdleLease<'_> {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn idle_lease(file: &File) -> io::Result<Option<IdleLease<'_>>> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok(Some(IdleLease(file)))
}

fn set_exit_empty(socket: &Path, enabled: bool) -> io::Result<()> {
    let output = bounded_output(
        Command::new("tmux")
            .args(["-N", "-S"])
            .arg(socket)
            .args([
                "set-option",
                "-s",
                "exit-empty",
                if enabled { "on" } else { "off" },
            ])
            .env("PATH", crate::agent::login_path())
            .env_remove("TMUX"),
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            "Local terminal server did not accept its lifetime setting",
        ))
    }
}

pub fn stop() {
    let Ok(mut lease) = APP_LEASE.lock() else {
        return;
    };
    if lease.take().is_none() {
        return;
    }
    let socket = socket_path();
    let result = (|| -> io::Result<()> {
        let observer = lease_file(socket.parent().unwrap())?;
        if let Some(_idle) = idle_lease(&observer)? {
            if UnixStream::connect(&socket).is_ok() {
                set_exit_empty(&socket, true)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("PzzaCode local terminal idle cleanup: {error}");
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
    run_service_at(&socket_path(), LABEL, Command::new("tmux"))
}

fn run_service_at(socket: &Path, label: &str, command: Command) -> io::Result<i32> {
    let code = run_server_at(socket, command)?;
    let observer = lease_file(socket.parent().unwrap())?;
    if let Some(_idle) = idle_lease(&observer)? {
        if UnixStream::connect(&socket).is_err() {
            // Also removes a previously loaded KeepAlive definition after its
            // sessions end. Holding the idle lease keeps a new app from racing
            // this removal; it will register the current on-demand definition.
            let target = format!("gui/{}/{label}", unsafe { libc::geteuid() });
            let _ = bounded_output(Command::new("/bin/launchctl").args(["bootout", &target]));
        }
    }
    Ok(code)
}

fn run_server_at(socket: &Path, mut command: Command) -> io::Result<i32> {
    let directory = socket.parent().unwrap();
    private_directory(directory)?;
    let _lock = server_lock(directory)?;
    let lease = lease_file(directory)?;
    if UnixStream::connect(&socket).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "Refusing to replace an existing terminal server",
        ));
    }
    // Keep this signed helper alive as the responsible process. tmux must not
    // daemonize, and must not inherit a server selection from another terminal.
    let mut child = command
        .args(["-D", "-S"])
        .arg(&socket)
        .env_remove("TMUX")
        .env_remove("PZZA_TMUX_SOCKET")
        .stdin(Stdio::null())
        .spawn()?;
    // File locks disappear on normal exit, crashes and force-quit, and cannot
    // confuse a reused PID with a live app. Only ownership transitions issue
    // a tmux command; otherwise the check is two local system calls.
    let mut owner = None;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.code().unwrap_or(1));
        }
        // Hold exclusive ownership until the idle setting is applied, so an
        // opening app cannot race an idle decision made just before its lease.
        let idle = idle_lease(&lease)?;
        let running = idle.is_none();
        if owner != Some(running) && UnixStream::connect(socket).is_ok() {
            if set_exit_empty(socket, !running).is_ok() {
                owner = Some(running);
            }
        }
        drop(idle);
        std::thread::sleep(Duration::from_millis(500));
    }
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
        assert!(content.contains("AssociatedBundleIdentifiers"));
        assert!(content.contains("<key>KeepAlive</key><false/>"));
        assert!(content.contains("<key>RunAtLoad</key><false/>"));
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
        // A concurrent fork can briefly retain the descriptor until exec.
        let deadline = Instant::now() + Duration::from_secs(1);
        while let Err(error) = server_lock(&directory) {
            assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
            assert!(
                Instant::now() < deadline,
                "Server ownership was not released"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
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

    #[test]
    fn ownership_ends_only_after_the_last_app_exits() {
        let directory = directory();
        let observer = lease_file(&directory).unwrap();
        assert!(idle_lease(&observer).unwrap().is_some());
        let first = app_lease(&directory).unwrap();
        let second = app_lease(&directory).unwrap();
        assert!(idle_lease(&observer).unwrap().is_none());
        drop(first);
        assert!(idle_lease(&observer).unwrap().is_none());
        drop(second);
        assert!(idle_lease(&observer).unwrap().is_some());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn helper_exits_when_unused_and_preserves_sessions_across_app_exit() {
        let directory = directory();
        let socket = directory.join("server.sock");
        let lease = app_lease(&directory).unwrap();
        let helper_socket = socket.clone();
        let helper = std::thread::spawn(move || {
            let mut command = Command::new("tmux");
            command.args(["-f", "/dev/null"]);
            run_server_at(&helper_socket, command)
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while UnixStream::connect(&socket).is_err() {
            assert!(
                Instant::now() < deadline,
                "Private terminal helper did not start"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let command = |args: &[&str]| {
            bounded_output(
                Command::new("tmux")
                    .args(["-N", "-S"])
                    .arg(&socket)
                    .args(args)
                    .env_remove("TMUX"),
            )
            .unwrap()
        };
        assert!(
            command(&["new-session", "-d", "-s", "survivor", "/bin/sleep 30"])
                .status
                .success()
        );
        drop(lease);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let output = command(&["show-option", "-sv", "exit-empty"]);
            if output.stdout.starts_with(b"on") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Helper did not release idle ownership"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(command(&["has-session", "-t", "survivor"]).status.success());
        assert!(!helper.is_finished());
        let reopened = app_lease(&directory).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if command(&["show-option", "-sv", "exit-empty"])
                .stdout
                .starts_with(b"off")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Reopened app did not reclaim its helper"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(command(&["kill-session", "-t", "survivor"])
            .status
            .success());
        assert!(command(&["show-option", "-sv", "exit-empty"])
            .status
            .success());
        assert!(!helper.is_finished(), "The app still owns the empty helper");
        drop(reopened);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !helper.is_finished() {
            assert!(
                Instant::now() < deadline,
                "Unused terminal helper did not exit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(helper.join().unwrap().unwrap(), 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "Requires a macOS login session to register an isolated launchd job"]
    fn launchd_reloads_idle_service_without_interrupting_sessions() {
        const CHILD_DIRECTORY: &str = "PZZA_LAUNCHD_LIFECYCLE_TEST_DIRECTORY";
        const TEST_FILTER: &str =
            "local_tmux::tests::launchd_reloads_idle_service_without_interrupting_sessions";
        let child_directory = std::env::var_os(CHILD_DIRECTORY);
        let directory = child_directory
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(format!(
                    "/private/tmp/pzza-launchd-test-{}",
                    crate::agent::random_hex(8).unwrap()
                ))
            });
        assert_eq!(directory.parent(), Some(Path::new("/private/tmp")));
        let name = directory.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("pzza-launchd-test-"));
        let label = format!("com.pzzacode.tmux.lifecycle.{name}");
        let socket = directory.join("server.sock");
        assert_ne!(label, LABEL);
        assert_ne!(socket, socket_path());
        private_directory(&directory).unwrap();
        if child_directory.is_some() {
            let mut command = Command::new("tmux");
            command.args(["-f", "/dev/null"]);
            assert_eq!(run_service_at(&socket, &label, command).unwrap(), 0);
            return;
        }

        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let target = format!("{domain}/{label}");
        struct Service {
            target: String,
            directory: PathBuf,
            socket: PathBuf,
        }
        impl Drop for Service {
            fn drop(&mut self) {
                let _ =
                    bounded_output(Command::new("/bin/launchctl").args(["bootout", &self.target]));
                let _ = bounded_output(
                    Command::new("tmux")
                        .args(["-N", "-S"])
                        .arg(&self.socket)
                        .arg("kill-server")
                        .env("PATH", crate::agent::login_path())
                        .env_remove("TMUX"),
                );
                let _ = fs::remove_dir_all(&self.directory);
            }
        }
        let _service = Service {
            target: target.clone(),
            directory: directory.clone(),
            socket: socket.clone(),
        };
        let plist = directory.join("service.plist");
        let executable = std::env::current_exe().unwrap();
        let contents = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
            <key>Label</key><string>{}</string>\
            <key>ProgramArguments</key><array><string>{}</string><string>--exact</string><string>{TEST_FILTER}</string><string>--include-ignored</string><string>--nocapture</string></array>\
            <key>EnvironmentVariables</key><dict><key>{CHILD_DIRECTORY}</key><string>{}</string><key>PATH</key><string>{}</string></dict>\
            <key>KeepAlive</key><false/><key>RunAtLoad</key><false/>\
            <key>ThrottleInterval</key><integer>1</integer>\
            </dict></plist>\n",
            xml(&label), xml(executable.to_str().unwrap()), xml(directory.to_str().unwrap()), xml(crate::agent::login_path()),
        );
        let launchctl =
            |args: &[&str]| bounded_output(Command::new("/bin/launchctl").args(args)).unwrap();
        let tmux = |args: &[&str]| {
            bounded_output(
                Command::new("tmux")
                    .args(["-N", "-S"])
                    .arg(&socket)
                    .args(args)
                    .env("PATH", crate::agent::login_path())
                    .env_remove("TMUX"),
            )
            .unwrap()
        };
        let wait_for = |description: &str, condition: &dyn Fn() -> bool| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !condition() {
                assert!(Instant::now() < deadline, "{description}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let start = || {
            assert!(launchctl(&["bootstrap", &domain, plist.to_str().unwrap()])
                .status
                .success());
            let _ = launchctl(&["kickstart", &target]);
            wait_for("Isolated launchd helper did not start", &|| {
                UnixStream::connect(&socket).is_ok()
            });
        };
        let loaded_keepalive = || {
            let loaded = launchctl(&["print", &target]);
            assert!(
                loaded.status.success(),
                "Isolated launchd job is not loaded"
            );
            String::from_utf8_lossy(&loaded.stdout)
                .to_ascii_lowercase()
                .contains("keepalive")
        };
        let wait_unloaded = || {
            wait_for("Idle helper did not unregister its launchd job", &|| {
                !launchctl(&["print", &target]).status.success()
            })
        };

        let lease = app_lease(&directory).unwrap();
        write_service(
            &plist,
            &contents.replace(
                "<key>KeepAlive</key><false/>",
                "<key>KeepAlive</key><true/>",
            ),
        )
        .unwrap();
        start();
        assert!(loaded_keepalive());
        assert!(
            tmux(&["new-session", "-d", "-s", "survivor", "/bin/sleep 60"])
                .status
                .success()
        );
        write_service(&plist, &contents).unwrap();
        assert!(
            loaded_keepalive(),
            "Writing the plist must not replace the running job"
        );
        drop(lease);
        wait_for("Closed app did not release its terminal helper", &|| {
            tmux(&["show-option", "-sv", "exit-empty"])
                .stdout
                .starts_with(b"on")
        });
        assert!(tmux(&["has-session", "-t", "survivor"]).status.success());
        assert!(
            loaded_keepalive(),
            "A live session must retain the loaded job"
        );
        assert!(tmux(&["kill-session", "-t", "survivor"]).status.success());
        wait_unloaded();

        let lease = app_lease(&directory).unwrap();
        start();
        assert!(
            !loaded_keepalive(),
            "Fresh startup must use the current on-demand definition"
        );
        assert!(tmux(&["show-option", "-sv", "exit-empty"]).status.success());
        drop(lease);
        wait_unloaded();
        assert!(UnixStream::connect(&socket).is_err());
    }
}
