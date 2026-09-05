mod agent;
mod forward;
mod pty;
mod rdp;
mod sys;
mod tmux;

use agent::AgentState;
use forward::ForwardState;
use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Signed in-app updates from GitHub Releases (latest.json), plus
        // relaunch after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PtyState::default())
        .manage(ForwardState::default())
        .manage(AgentState::default())
        .setup(|app| {
            // Launch the local device agent (server/index.js) as a managed sidecar.
            agent::start(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            tmux::tmux_list_sessions,
            forward::forward_scan,
            forward::forward_set,
            forward::forward_reconcile,
            rdp::rdp_status,
            rdp::rdp_launch,
            rdp::rdp_provision,
            rdp::keychain_set,
            agent::agent_token,
            agent::agent_instance,
            sys::open_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building pzza console")
        .run(|app, event| {
            // Tear the agent down with the app so no orphan Node process lingers.
            if let tauri::RunEvent::Exit = event {
                agent::stop(app);
            }
        });
}
