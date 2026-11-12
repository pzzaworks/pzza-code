mod agent;
mod agent_catalog;
mod terminal_drop;
mod shutdown;
mod menu;
mod pane_mode;
mod appearance;
mod forward;
mod permissions;
mod pty;
mod rdp;
mod speech;
mod speech_model;
mod sshmux;
mod sys;
mod session_refresh;
mod setup;
mod tmux;
mod voice_io;
mod voice_vad;
mod voice_log;
#[cfg(target_os = "macos")]
pub mod local_tmux;

use agent::AgentState;
use forward::ForwardState;
use pty::PtyState;
use tauri::Manager;

// Two copies of the app (one in Applications and an older one left in
// Downloads, say) share the bundle id, so the webview storage and the app data
// folder too: each would overwrite the other's tiles, workspaces, snapshots,
// prompts and tasks. A second copy hands over to the running one and exits,
// unless the running one is quitting: then it waits and takes over.
#[cfg(target_os = "macos")]
mod instance {
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, PoisonError};
    use std::time::{Duration, Instant};

    // How long a new copy waits for the running one to let go. A restart
    // starts the new process while the old one is still exiting.
    const HANDOVER_PATIENCE: Duration = Duration::from_secs(2);
    // How long a new copy waits for a running copy that is quitting (or whose
    // process id cannot be read yet) to exit: longer than its whole bounded
    // cleanup (see shutdown.rs).
    const QUIT_PATIENCE: Duration = Duration::from_secs(180);
    // How long an unreadable process id is read again: the owner writes it
    // right after taking the lock.
    const PID_PATIENCE: Duration = Duration::from_millis(500);
    // Written after the owner's process id while it is quitting.
    const QUITTING: &str = "quitting";

    // Held for the life of the process. The lock belongs to the open file, so
    // a copy that crashed or was killed never leaves a stale lock behind, and
    // the descriptor is closed in every child process the app starts.
    static HELD: Mutex<Option<File>> = Mutex::new(None);

    /// The running copy as its lock file describes it.
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Holder {
        // Its process id, when it could be read.
        pub pid: Option<libc::pid_t>,
        // It started quitting and will let go once its cleanup is done.
        pub quitting: bool,
    }

    pub enum Claim {
        Owner(File),
        Running(Holder),
    }

    fn holder(text: &str) -> Holder {
        let mut words = text.split_whitespace();
        let pid = words.next().and_then(|word| word.parse::<libc::pid_t>().ok()).filter(|pid| *pid > 0);
        Holder { pid, quitting: words.next() == Some(QUITTING) }
    }

    fn read_holder(file: &File) -> Holder {
        let mut bytes = [0u8; 64];
        let read = file.read_at(&mut bytes, 0).unwrap_or(0);
        holder(&String::from_utf8_lossy(&bytes[..read]))
    }

    /// Writes this process id (and whether it is quitting) over the file in
    /// one write, then cuts off whatever was longer: a reader never sees an
    /// empty file from an owner that already wrote its id.
    fn publish(file: &File, quitting: bool) -> io::Result<()> {
        let text = if quitting { format!("{} {QUITTING}", std::process::id()) } else { std::process::id().to_string() };
        file.write_all_at(text.as_bytes(), 0)?;
        file.set_len(text.len() as u64)
    }

    fn try_lock(file: &File) -> io::Result<bool> {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Ok(false)
        } else {
            Err(error)
        }
    }

    fn lock_file(directory: &Path) -> io::Result<File> {
        std::fs::create_dir_all(directory)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join("instance.lock"))?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "The running copy lock is not this user's file",
            ));
        }
        Ok(file)
    }

    pub fn claim(directory: &Path, patience: Duration) -> io::Result<Claim> {
        let file = lock_file(directory)?;
        let deadline = Instant::now() + patience;
        loop {
            if try_lock(&file)? {
                publish(&file, false)?;
                return Ok(Claim::Owner(file));
            }
            if Instant::now() >= deadline {
                // An owner that has just taken the lock writes its id next.
                let deadline = Instant::now() + PID_PATIENCE;
                let mut running = read_holder(&file);
                while running.pid.is_none() && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(50));
                    if try_lock(&file)? {
                        publish(&file, false)?;
                        return Ok(Claim::Owner(file));
                    }
                    running = read_holder(&file);
                }
                return Ok(Claim::Running(running));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Waits up to `patience` for a running copy that is quitting (or whose
    /// id cannot be read) to let go, and takes over once it does. Gives up
    /// early when it turns out to keep running: its quit was called off, or
    /// its id became readable without a quit.
    pub fn take_over(directory: &Path, patience: Duration) -> io::Result<Claim> {
        let file = lock_file(directory)?;
        let deadline = Instant::now() + patience;
        loop {
            if try_lock(&file)? {
                publish(&file, false)?;
                return Ok(Claim::Owner(file));
            }
            let running = read_holder(&file);
            if (running.pid.is_some() && !running.quitting) || Instant::now() >= deadline {
                return Ok(Claim::Running(running));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// Returns when this copy may run, or exits after bringing the running
    /// copy to the front. A copy that is quitting is waited for instead, so
    /// launching during its quit never ends with no app at all. Any trouble
    /// with the lock file lets the app start.
    pub fn hand_over_to_running(identifier: &str) {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        // Tauri's app data folder for this bundle id.
        let directory = PathBuf::from(home)
            .join("Library/Application Support")
            .join(identifier);
        let claimed = match claim(&directory, HANDOVER_PATIENCE) {
            Ok(Claim::Running(running)) if running.quitting || running.pid.is_none() => {
                eprintln!("PzzaCode is quitting; starting once it has exited");
                take_over(&directory, QUIT_PATIENCE)
            }
            claimed => claimed,
        };
        match claimed {
            Ok(Claim::Owner(file)) => {
                *HELD.lock().unwrap_or_else(PoisonError::into_inner) = Some(file);
            }
            Ok(Claim::Running(running)) => {
                eprintln!("PzzaCode is already running; switching to it");
                if let Some(pid) = running.pid {
                    activate(pid, identifier);
                }
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("PzzaCode could not check for another running copy: {error}");
            }
        }
    }

    /// Notes in the lock file whether this copy is quitting, so a copy
    /// launched meanwhile waits for it to exit instead of handing over.
    pub fn quitting(quitting: bool) {
        if let Some(file) = HELD.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            if let Err(error) = publish(file, quitting) {
                eprintln!("PzzaCode could not note its quit for other copies: {error}");
            }
        }
    }

    /// Lets go before the process ends, so a restart's new process takes over.
    pub fn release() {
        HELD.lock().unwrap_or_else(PoisonError::into_inner).take();
    }

    fn activate(pid: libc::pid_t, identifier: &str) {
        use objc2::runtime::{AnyClass, AnyObject};
        let Some(class) = AnyClass::get(c"NSRunningApplication") else {
            return;
        };
        objc2::rc::autoreleasepool(|_| unsafe {
            let app: *mut AnyObject =
                objc2::msg_send![class, runningApplicationWithProcessIdentifier: pid];
            let Some(app) = app.as_ref() else {
                return;
            };
            // Only ever another copy of this app, never whatever reused the id.
            let bundle: *mut AnyObject = objc2::msg_send![app, bundleIdentifier];
            let Some(bundle) = bundle.as_ref() else {
                return;
            };
            let name: *const std::ffi::c_char = objc2::msg_send![bundle, UTF8String];
            if name.is_null() || std::ffi::CStr::from_ptr(name).to_bytes() != identifier.as_bytes() {
                return;
            }
            // NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps
            let options: usize = (1 << 0) | (1 << 1);
            let _: bool = objc2::msg_send![app, activateWithOptions: options];
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn directory(name: &str) -> PathBuf {
            let directory = std::env::temp_dir().join(format!("pzza-instance-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&directory);
            directory
        }

        #[test]
        fn a_second_copy_finds_the_running_one() {
            let directory = directory("second");
            let Claim::Owner(owner) = claim(&directory, Duration::ZERO).unwrap() else {
                panic!("The first copy must own the lock");
            };
            let start = Instant::now();
            let Claim::Running(running) = claim(&directory, Duration::from_millis(120)).unwrap() else {
                panic!("A second copy must not own the lock");
            };
            assert!(start.elapsed() >= Duration::from_millis(100));
            assert_eq!(running, Holder { pid: Some(std::process::id() as libc::pid_t), quitting: false });
            drop(owner);
            std::fs::remove_dir_all(&directory).unwrap();
        }

        #[test]
        fn the_lock_file_says_who_runs_and_whether_it_is_quitting() {
            assert_eq!(holder("123"), Holder { pid: Some(123), quitting: false });
            assert_eq!(holder("123 quitting"), Holder { pid: Some(123), quitting: true });
            assert_eq!(holder(""), Holder { pid: None, quitting: false });
            assert_eq!(holder("0"), Holder { pid: None, quitting: false });
            assert_eq!(holder("abc quitting"), Holder { pid: None, quitting: true });
            let directory = directory("publish");
            let file = lock_file(&directory).unwrap();
            // A longer earlier text is cut off, never left behind.
            file.write_all_at(b"99999999999 quitting extra", 0).unwrap();
            publish(&file, false).unwrap();
            assert_eq!(read_holder(&file), Holder { pid: Some(std::process::id() as libc::pid_t), quitting: false });
            publish(&file, true).unwrap();
            assert!(read_holder(&file).quitting);
            std::fs::remove_dir_all(&directory).unwrap();
        }

        #[test]
        fn a_copy_launched_while_the_running_one_quits_takes_over_once_it_exits() {
            let directory = directory("quitting");
            let Claim::Owner(owner) = claim(&directory, Duration::ZERO).unwrap() else {
                panic!("The first copy must own the lock");
            };
            publish(&owner, true).unwrap();
            let Claim::Running(running) = claim(&directory, Duration::from_millis(50)).unwrap() else {
                panic!("The quitting copy still holds the lock");
            };
            assert!(running.quitting);
            let releaser = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                drop(owner);
            });
            let start = Instant::now();
            assert!(matches!(take_over(&directory, Duration::from_secs(5)).unwrap(), Claim::Owner(_)));
            assert!(start.elapsed() >= Duration::from_millis(150), "it waited for the quit");
            releaser.join().unwrap();
            std::fs::remove_dir_all(&directory).unwrap();
        }

        #[test]
        fn a_quit_that_is_called_off_is_handed_over_to() {
            let directory = directory("called-off");
            let Claim::Owner(owner) = claim(&directory, Duration::ZERO).unwrap() else {
                panic!("The first copy must own the lock");
            };
            publish(&owner, true).unwrap();
            let resumer = {
                let owner = owner.try_clone().unwrap();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(150));
                    publish(&owner, false).unwrap();
                })
            };
            let start = Instant::now();
            let Claim::Running(running) = take_over(&directory, Duration::from_secs(5)).unwrap() else {
                panic!("A copy that keeps running is not taken over");
            };
            assert!(!running.quitting && running.pid.is_some());
            assert!(start.elapsed() < Duration::from_secs(2));
            // A copy that never exits is handed over to at the limit.
            publish(&owner, true).unwrap();
            assert!(matches!(take_over(&directory, Duration::from_millis(200)).unwrap(), Claim::Running(Holder { quitting: true, .. })));
            resumer.join().unwrap();
            drop(owner);
            std::fs::remove_dir_all(&directory).unwrap();
        }

        #[test]
        fn a_lock_left_by_an_ended_copy_never_blocks_launch() {
            let directory = directory("stale");
            std::fs::create_dir_all(&directory).unwrap();
            // An old process id stays in the file after its copy ended.
            std::fs::write(directory.join("instance.lock"), "999999").unwrap();
            let Claim::Owner(owner) = claim(&directory, Duration::ZERO).unwrap() else {
                panic!("A file nobody holds must not block launch");
            };
            drop(owner);
            assert!(matches!(claim(&directory, Duration::ZERO).unwrap(), Claim::Owner(_)));
            std::fs::remove_dir_all(&directory).unwrap();
        }

        #[test]
        fn a_restart_takes_over_once_the_old_process_lets_go() {
            let directory = directory("restart");
            let Claim::Owner(owner) = claim(&directory, Duration::ZERO).unwrap() else {
                panic!("The first copy must own the lock");
            };
            let releaser = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                drop(owner);
            });
            assert!(matches!(claim(&directory, Duration::from_secs(2)).unwrap(), Claim::Owner(_)));
            releaser.join().unwrap();
            std::fs::remove_dir_all(&directory).unwrap();
        }
    }
}

/// Recreates lost local sessions once the terminal service, started off the
/// main thread at launch, is up. Without the wait the launch check could find
/// no server yet, and tiles would then attach to nothing.
#[tauri::command(rename = "local_tmux_restore_sessions")]
async fn restore_local_sessions(
    app: tauri::AppHandle,
    agents: Vec<session_refresh::AgentResume>,
) -> Result<session_refresh::RefreshReport, String> {
    #[cfg(target_os = "macos")]
    {
        let waiter = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            waiter
                .state::<shutdown::TerminalStartup>()
                .wait(shutdown::LAUNCH_WAIT)
        })
        .await
        .map_err(|error| error.to_string())?;
    }
    session_refresh::local_tmux_restore_sessions(app, agents).await
}

// Marks the terminal service start finished however its thread ends.
#[cfg(target_os = "macos")]
struct StartupDone(tauri::AppHandle);

#[cfg(target_os = "macos")]
impl Drop for StartupDone {
    fn drop(&mut self) {
        self.0.state::<shutdown::TerminalStartup>().finish();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    // Before anything is built, so a second copy never shows a window.
    #[cfg(target_os = "macos")]
    if !tauri::is_dev() {
        instance::hand_over_to_running(&context.config().identifier);
    }
    #[cfg(target_os = "macos")]
    shutdown::observe_quitting(instance::quitting);
    tauri::Builder::default()
        // Signed in-app updates from GitHub Releases (latest.json), plus
        // relaunch after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(terminal_drop::init())
        .manage(speech::SpeechState::default())
        .manage(speech_model::SpeechModelState::default())
        .manage(PtyState::default())
        .manage(ForwardState::default())
        .manage(AgentState::default())
        .manage(shutdown::ShutdownState::default())
        .manage(shutdown::TerminalStartup::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                menu::install(app.handle())?;
                let handle = app.handle().clone();
                shutdown::install_native_quit(move || {
                    if let Some(window) = handle.get_webview_window("main") {
                        if let Err(error) = window.close() {
                            eprintln!("PzzaCode could not request window close: {error}");
                        }
                    } else {
                        handle.exit(0);
                    }
                })?;
            }
            // Setup runs on the main thread: nothing here may wait on the
            // user's shell, launchctl or tmux, or the window would not respond.
            #[cfg(target_os = "macos")]
            {
                let done = StartupDone(app.handle().clone());
                let started = std::thread::Builder::new()
                    .name("local-terminals-start".into())
                    .spawn(move || {
                        let _done = done;
                        if let Err(error) = local_tmux::start() {
                            eprintln!("PzzaCode local terminals: {error}");
                        }
                    });
                // A thread that never ran drops `done` with it, so nothing waits.
                if let Err(error) = started {
                    eprintln!("PzzaCode local terminals could not start: {error}");
                }
            }
            // Launch the local device agent (server/index.js) as a managed sidecar.
            agent::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            shutdown::app_restart,
            shutdown::app_quit_cancelled,
            speech::speech_prepare,
            speech::speech_input_devices,
            speech::speech_start,
            speech::speech_stop,
            speech_model::speech_model_status,
            speech_model::speech_model_download,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_ack,
            pty::pty_resize,
            pty::pty_kill,
            tmux::tmux_list_sessions,
            pane_mode::tmux_pane_mode,
            pane_mode::tmux_pane_lines,
            session_refresh::local_tmux_refresh_sessions,
            restore_local_sessions,
            session_refresh::local_tmux_record_sessions,
            setup::setup_status,
            setup::setup_install,
            forward::forward_scan,
            forward::forward_set,
            forward::forward_reconcile,
            forward::forward_release,
            rdp::rdp_launch,
            rdp::rdp_is_open,
            rdp::rdp_focus,
            agent::agent_token,
            agent::agent_instance,
            agent::agent_restart_required,
            terminal_drop::read_dropped_file,
            terminal_drop::release_drop,
            sys::open_url,
            sys::reveal_path,
            sys::system_languages,
            sys::app_bundle_writable,
            permissions::permissions_status,
            permissions::permission_request,
            permissions::permission_open_settings,
            appearance::set_desktop_blur,
        ])
        .build(context)
        .expect("error while building pzza console")
        .run(|app, event| {
            // The restart's new process starts before this one ends.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Exit) {
                instance::release();
            }
            shutdown::handle_event(app, event);
        });
}
