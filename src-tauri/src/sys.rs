// Open a URL in the user's default browser. Forwarded devbox ports become
// http://localhost:<port> on this machine, so opening one is a plain URL open.
// Keep URLs as data, never shell source, and check the launcher's exit status.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid website address")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Use an HTTP or HTTPS website address without credentials".into());
    }
    tauri::async_runtime::spawn_blocking(move || launch_browser(parsed.as_str()))
        .await
        .map_err(|error| error.to_string())?
}

fn launch_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:PZZA_OPEN_URL",
        ]);
        c.env("PZZA_OPEN_URL", url);
        c
    };

    #[cfg(not(target_os = "windows"))]
    cmd.arg(url);
    let mut child = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start the browser launcher: {error}"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err("The system could not open the default browser".into())
                }
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if result.is_err() {
                    "Could not check browser launch status"
                } else {
                    "Browser launcher timed out"
                }
                .into());
            }
        }
    }
}
