mod agent;
mod bridge_consent;
mod terminal_drop;
mod shutdown;
mod menu;
mod appearance;
mod forward;
mod pty;
mod rdp;
mod speech;
mod speech_model;
mod sshmux;
mod sys;
mod tmux;
#[cfg(target_os = "macos")]
pub mod local_tmux;

use agent::AgentState;
use forward::ForwardState;
use pty::PtyState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Signed in-app updates from GitHub Releases (latest.json), plus
        // relaunch after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(terminal_drop::init())
        .manage(speech::SpeechState::default())
        .manage(speech_model::SpeechModelState::default())
        .manage(PtyState::default())
        .manage(ForwardState::default())
        .manage(AgentState::default())
        .manage(shutdown::ShutdownState::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            menu::install(app.handle())?;
            #[cfg(target_os = "macos")]
            if let Err(error) = local_tmux::start() {
                eprintln!("PzzaCode local terminals: {error}");
            }
            // Launch the local device agent (server/index.js) as a managed sidecar.
            agent::start(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            forward::forward_scan,
            forward::forward_set,
            forward::forward_reconcile,
            rdp::rdp_launch,
            rdp::rdp_is_open,
            agent::agent_token,
            agent::agent_instance,
            bridge_consent::bridge_local_decide,
            terminal_drop::read_dropped_file,
            terminal_drop::release_drop,
            sys::open_url,
            appearance::set_desktop_blur,
        ])
        .build(tauri::generate_context!())
        .expect("error while building pzza console")
        .run(|app, event| {
            // Closing the last window uses the same managed exit as Quit.
            if let tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Destroyed, .. } = &event {
                if app.webview_windows().is_empty() {
                    app.exit(0);
                }
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let shutdown = app.state::<shutdown::ShutdownState>();
                if shutdown.complete() {
                    return;
                }
                api.prevent_exit();
                let cleanup_app = app.clone();
                let exit_app = app.clone();
                shutdown.start(move || {
                    agent::stop(&cleanup_app);
                    cleanup_app.state::<PtyState>().shutdown();
                }, move || exit_app.exit(code.unwrap_or(0)));
            }
        });
}
