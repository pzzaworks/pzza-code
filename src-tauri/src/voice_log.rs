// A small diagnostic log for dictation in the app's log directory
// (~/Library/Logs/com.pzzacode.app/voice.log). It records errors and
// fallbacks so a silent recording can be traced. It never records
// transcripts or anything secret.
use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MAX_BYTES: u64 = 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

/// Collapses a message to one bounded line without control characters.
fn line(message: &str) -> String {
    message.chars().map(|c| if c.is_control() { ' ' } else { c }).take(400).collect()
}

pub fn log(app: &AppHandle, message: impl AsRef<str>) {
    let Ok(directory) = app.path().app_log_dir() else { return };
    let Ok(_guard) = LOCK.lock() else { return };
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join("voice.log");
    // Keep one previous file; the log never grows past about 2 MB.
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
        let _ = std::fs::rename(&path, directory.join("voice.log.1"));
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{stamp} {}", line(message.as_ref()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_single_bounded() {
        assert_eq!(line("a\nb\tc"), "a b c");
        assert_eq!(line(&"x".repeat(1000)).len(), 400);
    }
}
