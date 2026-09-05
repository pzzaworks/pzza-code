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
        "ServerAliveInterval=30".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ]
}
