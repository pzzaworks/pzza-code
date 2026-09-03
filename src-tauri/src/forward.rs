use std::collections::HashSet;
use std::process::Command;
use std::sync::Mutex;

// Port forwarding over the devbox's multiplexed ssh master, mirroring the
// devbox-autoforward logic: scan the remote's listening TCP ports and keep a
// matching set of -L forwards. Console tracks the forwards it added itself in
// `active`, so it never fights over ports another manager owns.
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
    forwarded: Vec<u16>, // ports console is currently forwarding
}

fn master_up(host: &str) -> bool {
    Command::new("ssh")
        .args(["-O", "check", host])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// Listening TCP ports on the devbox, IPv4 and IPv6, deduplicated and sorted.
fn remote_ports(host: &str) -> Vec<u16> {
    let out = Command::new("ssh")
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
    let up = master_up(host);
    let remote = if up { remote_ports(host) } else { Vec::new() };
    let wanted = wanted_from(&remote, skip, min_port);
    let mut forwarded: Vec<u16> = state.active.lock().unwrap().iter().copied().collect();
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
    if master_up(&host) {
        let remote = remote_ports(&host);
        let wanted = wanted_from(&remote, &skip, min_port);
        let current: Vec<u16> = state.active.lock().unwrap().iter().copied().collect();

        for p in &wanted {
            if !current.contains(p) && do_forward(&host, *p) {
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
