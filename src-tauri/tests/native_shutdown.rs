// Opt-in native lifecycle regression. Each child uses a nonpersistent webview,
// an isolated sidecar port/config root, and an explicitly private tmux socket.
#[cfg(target_os = "macos")]
#[path = "../src/agent.rs"]
mod agent;
#[cfg(target_os = "macos")]
#[path = "../src/bridge_consent.rs"]
mod bridge_consent;
#[cfg(target_os = "macos")]
#[path = "../src/local_tmux.rs"]
mod local_tmux;
#[cfg(target_os = "macos")]
#[path = "../src/pty.rs"]
mod pty;
#[cfg(target_os = "macos")]
#[path = "../src/shutdown.rs"]
mod shutdown;
#[cfg(target_os = "macos")]
#[path = "../src/speech.rs"]
mod speech;
#[cfg(target_os = "macos")]
#[path = "../src/speech_model.rs"]
mod speech_model;

#[cfg(target_os = "macos")]
fn main() {
    use std::os::unix::{fs::PermissionsExt, process::ExitStatusExt};
    use std::{
        fs,
        path::PathBuf,
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    let Ok(model) = std::env::var("PZZA_SHUTDOWN_MODEL") else {
        println!("Native shutdown regression skipped: set PZZA_SHUTDOWN_MODEL to an existing local speech model.");
        return;
    };
    assert!(PathBuf::from(&model).is_file());
    if let Ok(mode) = std::env::var("PZZA_SHUTDOWN_CASE") {
        if mode.starts_with("restart-") {
            let root = PathBuf::from(std::env::var_os("PZZA_SHUTDOWN_ROOT").unwrap());
            if root.join("restart-requested").exists() {
                use std::io::Write;
                assert!(root.join("restart-cleanup").is_file(), "Restart ran before cleanup finished");
                let mut successor = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(root.join("restart-successor"))
                    .expect("Restart must launch exactly one successor");
                writeln!(successor, "{}", std::process::id()).unwrap();
                return;
            }
        }
        run_child(model.into(), mode);
        return;
    }
    let root = std::env::temp_dir().join(format!("pzza-native-shutdown-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = root.join("server.sock");
    assert!(Command::new("tmux")
        .args(["-f", "/dev/null", "-S"])
        .arg(&socket)
        .args(["new-session", "-d", "-s", "shutdown-survivor", "-c"])
        .arg(&root)
        .arg("/bin/sleep 240")
        .env_remove("TMUX")
        .status()
        .unwrap()
        .success());
    struct Server(std::path::PathBuf);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = Command::new("tmux")
                .args(["-N", "-S"])
                .arg(&self.0)
                .arg("kill-server")
                .env_remove("TMUX")
                .status();
        }
    }
    let _server = Server(socket.clone());
    let mut cases = vec![
        "quit-warm",
        "quit-active",
        "close-warm",
        "close-active",
        "cancel-then-quit",
        "restart-warm",
        "restart-active",
    ];
    if std::env::var_os("PZZA_SHUTDOWN_REPRODUCE").is_some() {
        cases.insert(0, "baseline-leak");
    }
    for mode in cases {
        let case_root = root.join(mode);
        fs::create_dir(&case_root).unwrap();
        let log = fs::File::create(case_root.join("native.log")).unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .env("PZZA_SHUTDOWN_CASE", mode)
            .env("PZZA_SHUTDOWN_ROOT", &case_root)
            .env("PZZA_SHUTDOWN_SOCKET", &socket)
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap();
        let start = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if start.elapsed() > Duration::from_secs(45) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!(
                    "Native shutdown exceeded deadline: {mode}; evidence {}",
                    case_root.display()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if mode.starts_with("restart-") {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let successor = fs::read_to_string(case_root.join("restart-successor"))
                    .ok()
                    .and_then(|pid| pid.trim().parse::<i32>().ok());
                if let Some(pid) = successor {
                    if unsafe { libc::kill(pid, 0) } == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                    {
                        break;
                    }
                }
                assert!(Instant::now() < deadline, "Restart successor did not finish: {mode}");
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let log = fs::read_to_string(case_root.join("native.log")).unwrap();
        if mode == "baseline-leak" {
            assert_eq!(
                status.signal(),
                Some(libc::SIGABRT),
                "Expected the original native resource assertion"
            );
            assert!(
                log.contains("GGML_ASSERT([rsets->data count] == 0)"),
                "Wrong baseline failure; evidence {}",
                case_root.display()
            );
        } else {
            assert!(
                status.success(),
                "Native case {mode} failed: {status}; evidence {}",
                case_root.display()
            );
            assert!(
                log.contains("managed cleanup verified"),
                "Managed cleanup did not finish"
            );
            let port: u16 = fs::read_to_string(case_root.join("port"))
                .unwrap()
                .parse()
                .unwrap();
            assert!(
                std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
                "Sidecar still listens after exit"
            );
        }
        assert!(Command::new("tmux")
            .args(["-N", "-S"])
            .arg(&socket)
            .args(["has-session", "-t", "shutdown-survivor"])
            .env_remove("TMUX")
            .status()
            .unwrap()
            .success());
        let clients = Command::new("tmux")
            .args(["-N", "-S"])
            .arg(&socket)
            .args(["list-clients", "-F", "#{client_pid}"])
            .env_remove("TMUX")
            .output()
            .unwrap();
        assert!(
            clients.status.success() && clients.stdout.is_empty(),
            "PTY attachment survived app exit"
        );
        println!(
            "{mode}: {status}, {:.2}s, private terminal session survived, no attached clients",
            start.elapsed().as_secs_f64()
        );
    }
    println!("Native shutdown evidence: {}", root.display());
}

#[cfg(target_os = "macos")]
fn run_child(model: std::path::PathBuf, mode: String) {
    use objc2::{class, msg_send, runtime::AnyObject, sel};
    use std::{
        fs,
        net::TcpListener,
        path::PathBuf,
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, Instant},
    };
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    let root = PathBuf::from(std::env::var_os("PZZA_SHUTDOWN_ROOT").unwrap());
    let socket = PathBuf::from(std::env::var_os("PZZA_SHUTDOWN_SOCKET").unwrap());
    let active = mode.ends_with("active");
    let baseline = mode == "baseline-leak";
    let cancelled = mode == "cancel-then-quit";
    let restarts = mode.starts_with("restart-");
    let closes = Arc::new(AtomicUsize::new(0));
    let mut context = tauri::generate_context!();
    context.config_mut().identifier =
        format!("com.pzzacode.shutdown-regression-{}", std::process::id());
    context.config_mut().app.windows.clear();
    let observed = closes.clone();
    let setup_root = root.clone();
    let app = tauri::Builder::default()
        .manage(agent::AgentState::default())
        .manage(pty::PtyState::default())
        .manage(speech::SpeechState::default())
        .manage(shutdown::ShutdownState::default())
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("about:blank".parse().unwrap()),
            )
            .incognito(true)
            .visible(false)
            .build()?;
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let count = observed.fetch_add(1, Ordering::AcqRel);
                    if cancelled && count == 0 {
                        api.prevent_close();
                    }
                }
            });
            if !baseline {
                let handle = app.handle().clone();
                shutdown::install_native_quit(move || {
                    if let Some(window) = handle.get_webview_window("main") {
                        window.close().unwrap();
                    } else {
                        handle.exit(0);
                    }
                })?;
                let listener = TcpListener::bind(("127.0.0.1", 0))?;
                let port = listener.local_addr()?.port();
                drop(listener);
                fs::write(setup_root.join("port"), port.to_string())?;
                let token = agent::random_hex(32).unwrap();
                let child = Command::new("node")
                    .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../server/index.js"))
                    .env("PORT", port.to_string())
                    .env("XDG_CONFIG_HOME", setup_root.join("config"))
                    .env("HOME", &setup_root)
                    .env("PZZA_AGENT_TOKEN", &token)
                    .env("PZZA_AGENT_ID", "native-shutdown-regression")
                    .env("PZZA_MANAGED_AGENT", "1")
                    .env("PZZA_SERVER_HOST", "")
                    .env("PZZA_TMUX_SOCKET", &socket)
                    .env_remove("TMUX")
                    .stdin(Stdio::piped())
                    .spawn()?;
                *app.state::<agent::AgentState>().child.lock().unwrap() = Some(child);
                let deadline = Instant::now() + Duration::from_secs(5);
                while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
                    assert!(Instant::now() < deadline, "Isolated sidecar did not listen");
                    std::thread::sleep(Duration::from_millis(20));
                }
                pty::pty_spawn(
                    app.state(),
                    "tmux".into(),
                    vec![
                        "-N".into(),
                        "-S".into(),
                        socket.to_string_lossy().into_owned(),
                        "attach-session".into(),
                        "-t".into(),
                        "shutdown-survivor".into(),
                    ],
                    None,
                    80,
                    24,
                    tauri::ipc::Channel::new(|_| Ok(())),
                    tauri::ipc::Channel::new(|_| Ok(())),
                )?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                speech::prepare_shutdown_regression(&handle, &model, active);
                println!("native speech ready; active={active}");
                if cancelled {
                    request_native_quit(&handle);
                    let deadline = Instant::now() + Duration::from_secs(3);
                    while closes.load(Ordering::Acquire) == 0 {
                        assert!(Instant::now() < deadline);
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    assert!(!handle.state::<shutdown::ShutdownState>().complete());
                    // A cancelled close must still allow actual engine use.
                    speech::assert_cancelled_quit_regression(&handle);
                    println!("cancelled native Quit retained usable speech");
                }
                if restarts {
                    fs::write(root.join("restart-requested"), std::process::id().to_string()).unwrap();
                    tauri::async_runtime::block_on(shutdown::app_restart(handle.clone())).unwrap();
                } else if mode.starts_with("close-") {
                    handle.get_webview_window("main").unwrap().close().unwrap();
                } else {
                    request_native_quit(&handle);
                    if !baseline {
                        request_native_quit(&handle);
                    }
                }
            });
            Ok(())
        })
        .build(context)
        .unwrap();
    let mut destroyed_empty = false;
    app.run(move |handle, event| {
        if !baseline {
            if matches!(
                event,
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::Destroyed,
                    ..
                }
            ) {
                destroyed_empty = handle.webview_windows().is_empty();
                println!("Destroyed observed after window removal: {destroyed_empty}");
            }
            if matches!(event, tauri::RunEvent::Exit) {
                if !restarts {
                    assert!(destroyed_empty, "Exit must follow actual last-window removal");
                }
                assert!(handle.state::<shutdown::ShutdownState>().complete());
                speech::assert_shutdown_regression(handle, active);
                assert!(handle
                    .state::<agent::AgentState>()
                    .child
                    .lock()
                    .unwrap()
                    .is_none());
                println!("managed cleanup verified");
                if restarts {
                    fs::write(
                        PathBuf::from(std::env::var_os("PZZA_SHUTDOWN_ROOT").unwrap()).join("restart-cleanup"),
                        std::process::id().to_string(),
                    ).unwrap();
                }
            }
            shutdown::handle_event(handle, event);
        }
    });
    fn request_native_quit(handle: &tauri::AppHandle) {
        handle.run_on_main_thread(|| unsafe {
            let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            // Deliver like an OS menu/Dock action, outside the runtime callback.
            // Synchronous terminate: here re-enters Tao's locked event handler.
            let _: () = msg_send![application, performSelector: sel!(terminate:), withObject: std::ptr::null::<AnyObject>(), afterDelay: 0.0f64];
        }).unwrap();
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("Native shutdown regression is macOS-only.");
}
