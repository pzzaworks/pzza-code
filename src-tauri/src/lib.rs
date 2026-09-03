mod forward;
mod pty;
mod rdp;
mod sys;
mod tmux;

use forward::ForwardState;
use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState::default())
        .manage(ForwardState::default())
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
            sys::open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pzza console");
}
