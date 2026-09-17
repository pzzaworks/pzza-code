// App-owned ssh connection multiplexing.
//
// Every ssh the app runs to a device - tile shells (built in the frontend),
// tmux scans, and the port-forward control commands - shares one real master
// connection through the control socket below. Two things fall out of that:
//
//  1. The app never depends on the user having ControlMaster in ~/.ssh/config.
//     A command-line `-o` overrides the user's config, so the app manages its
//     own master regardless of what is (or is not) configured.
//  2. Opening several tiles at once reuses a single connection instead of
//     firing a burst of independent ssh connections, each of which would have
//     to re-resolve the host - an mDNS storm that could fail with
//     "connect to host ...: Undefined error: 0".
//
// The RDP tunnel deliberately opts out (ControlMaster=no): it needs its own
// dedicated connection on a private local port.
//
// The frontend tile spawns (src/connection.ts) must use the SAME ControlPath
// string, or they would not share this master. Keep the two in sync.

// `%C` hashes local host + remote host + port + user, so every ssh with the
// same target lands on the same short, unique socket name (well under macOS's
// 104-char unix-socket limit).
pub const CONTROL_PATH: &str = "~/.ssh/pzza-mux-%C";
const CONTROL_PERSIST: &str = "120"; // keep the master warm 2 min after last use

// Bound the initial TCP/SSH handshake so a command to an unreachable device
// fails in seconds instead of blocking on the OS default (~75s+). This only
// caps opening a fresh connection; an established master is unaffected, and a
// silently dropped master is still caught by the ServerAlive probes below.
const CONNECT_TIMEOUT: &str = "8";

// ssh options that put a connection on the shared master. Safe to pass to
// `ssh -O check|forward|cancel` too: those only read ControlPath.
pub fn control_args() -> Vec<String> {
    vec![
        "-o".into(),
        "ControlMaster=auto".into(),
        "-o".into(),
        format!("ControlPath={CONTROL_PATH}"),
        "-o".into(),
        format!("ControlPersist={CONTROL_PERSIST}"),
        "-o".into(),
        format!("ConnectTimeout={CONNECT_TIMEOUT}"),
        "-o".into(),
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    // A missing ConnectTimeout is what froze the window on a dropped device:
    // ssh to an unreachable host blocks on the OS default (~75s+). Keep the
    // bound in place so a forward/tmux scan can never hang unboundedly again.
    #[test]
    fn control_args_bound_the_connect() {
        let args = control_args();
        assert!(
            args.iter().any(|a| a.starts_with("ConnectTimeout=")),
            "control_args must set a ConnectTimeout: {args:?}"
        );
    }
}
