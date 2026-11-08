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

// Resolves a terminal path ("/abs/path" or "~/rel") to an existing location
// on this Mac. Text from the terminal is untrusted: bounded, no control
// characters, and it must exist.
fn resolve_reveal_path(path: &str, home: Option<&str>) -> Result<std::path::PathBuf, String> {
    if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        return Err("This is not a path PzzaCode can open".into());
    }
    let expanded = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let home = home.ok_or("Home folder unavailable")?;
            format!("{home}{rest}")
        }
        Some(_) => return Err("This is not a path PzzaCode can open".into()),
        None => path.to_string(),
    };
    if !expanded.starts_with('/') {
        return Err("Only absolute paths open in Finder".into());
    }
    std::fs::canonicalize(&expanded).map_err(|_| format!("{path} does not exist on this Mac"))
}

// Shows a terminal path in Finder: a folder opens, a file is selected in its
// folder. The path goes to `open` as an argument, never through a shell.
#[tauri::command]
pub async fn reveal_path(path: String) -> Result<(), String> {
    let resolved = resolve_reveal_path(&path, std::env::var("HOME").ok().as_deref())?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let mut command = std::process::Command::new("/usr/bin/open");
            if !resolved.is_dir() {
                command.arg("-R");
            }
            // The canonical path always starts with "/", so it is never read as an option.
            let status = command.arg(&resolved).status().map_err(|_| "Finder could not be opened".to_string())?;
            if status.success() { Ok(()) } else { Err("Finder could not open this path".into()) }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = resolved;
            Err("Revealing paths is only available on macOS".to_string())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod reveal_tests {
    use super::resolve_reveal_path;

    #[test]
    fn resolves_existing_absolute_and_home_paths_only() {
        let dir = std::env::temp_dir();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(resolve_reveal_path(dir.to_str().unwrap(), None).unwrap(), canonical);
        let home = dir.to_str().unwrap().trim_end_matches('/');
        assert_eq!(resolve_reveal_path("~", Some(home)).unwrap(), canonical);
        assert_eq!(resolve_reveal_path("~/", Some(home)).unwrap(), canonical);
        assert!(resolve_reveal_path("~other/x", Some(home)).is_err(), "other users' homes are not expanded");
        assert!(resolve_reveal_path("relative/path", Some(home)).is_err());
        assert!(resolve_reveal_path("/definitely/not/here/pzza", None).is_err());
        assert!(resolve_reveal_path("/tmp/\nx", None).is_err());
        assert!(resolve_reveal_path("", None).is_err());
        assert!(resolve_reveal_path(&format!("/{}", "a".repeat(5000)), None).is_err());
    }
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

/// The languages set in System Settings, in order ("en-TR", "tr-TR"). The web
/// view reports only its own UI language, so the region that makes "en-TR"
/// mean an English user in Turkey was lost and Turkish speech was treated as
/// a foreign language.
#[tauri::command]
pub fn system_languages() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_core_foundation::{CFArray, CFLocale, CFString, CFType};
        let Some(array) = CFLocale::preferred_languages() else { return Vec::new() };
        // SAFETY: CFArray's element type is only a marker, and every element
        // of a CoreFoundation array is a CFType.
        let array: &CFArray<CFType> = unsafe { &*(&*array as *const CFArray as *const CFArray<CFType>) };
        (0..array.len().min(16))
            .filter_map(|index| array.get(index))
            .filter_map(|value| value.downcast_ref::<CFString>().map(|text| text.to_string()))
            .filter(|tag| tag.len() <= 35)
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}
