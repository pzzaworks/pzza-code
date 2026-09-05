use std::collections::HashSet;
use std::net::TcpStream;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use crate::sshmux;

// Port forwarding over the remote's multiplexed ssh master: scan the remote's
// listening TCP ports and keep a matching set of -L forwards. Console tracks the
// forwards it added itself in `active`, so it never fights over ports another
// manager owns.
#[derive(Default)]
pub struct ForwardState {
    active: Mutex<HashSet<u16>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    master_up: bool,
    remote: Vec<u16>,    // every listening port on the devbox
    wanted: Vec<u16>,    // remote ports minus skip / below min_port
    forwarded: Vec<u16>, // wanted ports reachable on localhost right now
}

// Whether a wanted port is already reachable on this Mac's loopback - either
// because we forwarded it, or because another ssh tunnel (a leftover master, a
// separate tool) already mirrors it. Either way the user can open it, so it
// counts as forwarded and we never fight to re-bind a port that is already up.
fn local_listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(120),
    )
    .is_ok()
}

fn master_up(host: &str) -> bool {
    Command::new("ssh")
        .args(sshmux::control_args())
        .args(["-O", "check", host])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// Bring the shared ssh master up if it is not already. Port forwarding rides
// this master, so rather than passively report "master down" when no tile to
// the host happens to be open, the forwarding panel opens the connection
// itself. Returns whether a master is up afterwards.
fn ensure_master(host: &str) -> bool {
    if master_up(host) {
        return true;
    }
    // `-N -f` backgrounds a session with no command; with ControlMaster=auto and
    // no existing master it becomes the master, and ControlPersist keeps it warm.
    let _ = Command::new("ssh")
        .args(sshmux::control_args())
        .args(["-o", "BatchMode=yes", "-N", "-f", host])
        .status();
    master_up(host)
}

// Listening TCP ports on the devbox, IPv4 and IPv6, deduplicated and sorted.
fn remote_ports(host: &str) -> Vec<u16> {
    let out = Command::new("ssh")
        .args(sshmux::control_args())
        .args([
            "-o",
            "BatchMode=yes",
            host,
            "ss -tlnH 2>/dev/null | awk '{print $4}'",
        ])
        .output();

    let mut ports: Vec<u16> = Vec::new();
    if let Ok(out) = out {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if let Some(idx) = line.rfind(':') {
                    if let Ok(p) = line[idx + 1..].trim().parse::<u16>() {
                        ports.push(p);
                    }
                }
            }
        }
    }
    ports.sort_unstable();
    ports.dedup();
    ports
}

fn wanted_from(remote: &[u16], skip: &[u16], min_port: u16) -> Vec<u16> {
    remote
        .iter()
        .copied()
        .filter(|p| *p >= min_port && !skip.contains(p))
        .collect()
}

fn do_forward(host: &str, port: u16) -> bool {
    Command::new("ssh")
        .args(sshmux::control_args())
        .args([
            "-O",
            "forward",
            "-L",
            &format!("{port}:127.0.0.1:{port}"),
            host,
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn do_cancel(host: &str, port: u16) -> bool {
    Command::new("ssh")
        .args(sshmux::control_args())
        .args([
            "-O",
            "cancel",
            "-L",
            &format!("{port}:127.0.0.1:{port}"),
            host,
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn status(state: &ForwardState, host: &str, skip: &[u16], min_port: u16) -> ForwardStatus {
    let up = ensure_master(host);
    let remote = if up { remote_ports(host) } else { Vec::new() };
    let wanted = wanted_from(&remote, skip, min_port);
    // Report every wanted port that is actually reachable on localhost now,
    // whoever forwarded it - so the panel shows what the user can open, not just
    // what this process bound. Union with `active` covers the brief gap between
    // do_forward returning and the socket accepting connections.
    let active = state.active.lock().unwrap();
    let mut forwarded: Vec<u16> = wanted
        .iter()
        .copied()
        .filter(|&p| active.contains(&p) || local_listening(p))
        .collect();
    forwarded.sort_unstable();
    ForwardStatus {
        master_up: up,
        remote,
        wanted,
        forwarded,
    }
}

// Observe only: report the master state, the remote's listening ports, and what
// console is currently forwarding. Changes nothing.
#[tauri::command]
pub fn forward_scan(
    state: tauri::State<'_, ForwardState>,
    host: String,
    skip: Vec<u16>,
    min_port: u16,
) -> ForwardStatus {
    status(&state, &host, &skip, min_port)
}

// Manually forward or cancel a single port.
#[tauri::command]
pub fn forward_set(
    state: tauri::State<'_, ForwardState>,
    host: String,
    port: u16,
    enable: bool,
) -> Result<(), String> {
    if enable {
        // Already reachable (another tunnel owns it): nothing to do, and not
        // ours to track for cancel. Success either way.
        if local_listening(port) {
            return Ok(());
        }
        if do_forward(&host, port) {
            state.active.lock().unwrap().insert(port);
            Ok(())
        } else {
            Err(format!("could not forward {port} (already bound locally?)"))
        }
    } else {
        do_cancel(&host, port);
        state.active.lock().unwrap().remove(&port);
        Ok(())
    }
}

// One auto-forward reconcile cycle: add every wanted port not yet forwarded,
// cancel every forwarded port the remote no longer listens on.
#[tauri::command]
pub fn forward_reconcile(
    state: tauri::State<'_, ForwardState>,
    host: String,
    skip: Vec<u16>,
    min_port: u16,
) -> ForwardStatus {
    if ensure_master(&host) {
        let remote = remote_ports(&host);
        let wanted = wanted_from(&remote, &skip, min_port);
        let current: Vec<u16> = state.active.lock().unwrap().iter().copied().collect();

        for p in &wanted {
            // Skip ports another tunnel already mirrors; only bind the missing ones.
            if !current.contains(p) && !local_listening(*p) && do_forward(&host, *p) {
                state.active.lock().unwrap().insert(*p);
            }
        }
        for p in &current {
            if !wanted.contains(p) {
                do_cancel(&host, *p);
                state.active.lock().unwrap().remove(p);
            }
        }
    }
    status(&state, &host, &skip, min_port)
}
