//! The contract between PzzaCode and its privileged power helper
//! (`src/bin/pzzacode-power-helper.rs`), shared by both so they cannot drift.
//!
//! The app holds "stay awake with the lid closed" over one connection to the
//! helper's socket:
//! 1. The app sends `HELLO`. The helper then checks the code signature of the
//!    process that wrote it and answers with one line: `REPLY_HELD`, or
//!    `REPLY_ERROR` and a reason.
//! 2. While holding, the app writes a heartbeat byte every `HEARTBEAT_SECS`.
//! 3. The helper lets go when the connection closes (the app quit, crashed or
//!    was killed) or when no heartbeat arrives for three intervals (the app is
//!    stopped or hung), so the Mac never stays awake for an app that is gone.

/// Unix socket the root helper listens on.
pub const SOCKET_PATH: &str = "/var/run/com.pzzacode.app.power.sock";

/// The first line the app sends on a new connection.
pub const HELLO: &str = "hold";
/// Reply when the flag is now held for this connection.
pub const REPLY_HELD: &str = "held";
/// Reply prefix when the request was refused; the rest of the line is the reason.
pub const REPLY_ERROR: &str = "error";

/// How often the app proves it is alive while holding. The helper releases
/// after three missed intervals.
pub const HEARTBEAT_SECS: u64 = 30;
