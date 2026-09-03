// Open a URL in the user's default browser. Forwarded devbox ports become
// http://localhost:<port> on this machine, so opening one is a plain URL open.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };

    cmd.arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
