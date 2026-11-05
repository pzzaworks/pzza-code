// macOS privacy permissions for PzzaCode and tmux. Local shells live under the
// tmux helper, which is the PzzaCode executable started by launchd
// (local_tmux.rs), so most access is attributed to PzzaCode. tmux itself is
// also granted where macOS lists command-line tools, so tools that check the
// binary directly get the same access.

use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    Granted,
    /// Not granted yet; asking may still show the system prompt.
    NotGranted,
    /// Explicitly refused; only System Settings can change it.
    Denied,
    /// macOS gave no answer without asking (e.g. Automation's target is not running).
    Unknown,
}

#[derive(Serialize)]
pub struct PermissionState {
    id: &'static str,
    status: PermissionStatus,
}

const PERMISSIONS: [&str; 8] = [
    "fullDiskAccess",
    "microphone",
    "screenRecording",
    "accessibility",
    "automation",
    // tmux, for tools that check the binary itself. Only these three privacy
    // lists accept a command-line tool; the rest go to the launching app.
    "tmuxFullDiskAccess",
    "tmuxAccessibility",
    "tmuxScreenRecording",
];

fn known(id: &str) -> Result<&'static str, String> {
    PERMISSIONS
        .into_iter()
        .find(|known| *known == id)
        .ok_or_else(|| "Unknown permission".to_string())
}

#[tauri::command]
pub async fn permissions_status() -> Result<Vec<PermissionState>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        PERMISSIONS
            .into_iter()
            .map(|id| PermissionState { id, status: imp::status(id) })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

/// Shows the system prompt where macOS still offers one, otherwise opens the
/// matching System Settings pane. Returns the status afterwards.
#[tauri::command]
pub async fn permission_request(id: String) -> Result<PermissionStatus, String> {
    let id = known(&id)?;
    tauri::async_runtime::spawn_blocking(move || imp::request(id))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn permission_open_settings(id: String) -> Result<(), String> {
    let id = known(&id)?;
    tauri::async_runtime::spawn_blocking(move || imp::open_settings(id))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::PermissionStatus;

    pub fn status(_id: &str) -> PermissionStatus {
        PermissionStatus::Unknown
    }

    pub fn request(_id: &str) -> Result<PermissionStatus, String> {
        Err("Privacy permissions are only managed on macOS".into())
    }

    pub fn open_settings(_id: &str) -> Result<(), String> {
        Err("Privacy permissions are only managed on macOS".into())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::PermissionStatus;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{class, msg_send};
    use std::ffi::c_void;
    use std::time::Duration;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    }

    #[repr(C)]
    struct AEDesc {
        descriptor_type: u32,
        data_handle: *mut c_void,
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn AECreateDesc(type_code: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i16;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            event_class: u32,
            event_id: u32,
            ask_user_if_needed: u8,
        ) -> i32;
    }

    const fn four_char(code: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*code)
    }

    // Automation is granted per target app; System Events is what scripts and
    // CLI tools drive for UI and system control.
    const SYSTEM_EVENTS: &str = "com.apple.systemevents";
    const NO_ERR: i32 = 0;
    const EVENT_NOT_PERMITTED: i32 = -1743;
    const WOULD_REQUIRE_CONSENT: i32 = -1744;

    pub fn status(id: &str) -> PermissionStatus {
        match id {
            "fullDiskAccess" => full_disk_access(),
            "microphone" => microphone(),
            "screenRecording" => granted(unsafe { CGPreflightScreenCaptureAccess() }),
            "accessibility" => granted(unsafe { AXIsProcessTrusted() }),
            "automation" => automation(false),
            "tmuxFullDiskAccess" => tmux_grant("kTCCServiceSystemPolicyAllFiles"),
            "tmuxAccessibility" => tmux_grant("kTCCServiceAccessibility"),
            "tmuxScreenRecording" => tmux_grant("kTCCServiceScreenCapture"),
            _ => PermissionStatus::Unknown,
        }
    }

    pub fn request(id: &str) -> Result<PermissionStatus, String> {
        match (id, status(id)) {
            (_, PermissionStatus::Granted) => {}
            ("microphone", PermissionStatus::NotGranted) => request_microphone()?,
            ("accessibility", _) => prompt_accessibility()?,
            ("automation", PermissionStatus::NotGranted | PermissionStatus::Unknown) => {
                launch_system_events()?;
                automation(true);
            }
            ("screenRecording", _) => {
                // The first request lists PzzaCode in the pane; later ones are
                // silent, so the pane is where the switch actually gets flipped.
                unsafe { CGRequestScreenCaptureAccess() };
                open_settings(id)?;
            }
            ("tmuxFullDiskAccess" | "tmuxAccessibility" | "tmuxScreenRecording", _) => {
                open_settings(id)?;
                reveal_tmux()?;
            }
            ("fullDiskAccess", _) => {
                open_settings(id)?;
                reveal_app()?;
            }
            _ => open_settings(id)?,
        }
        Ok(status(id))
    }

    pub fn open_settings(id: &str) -> Result<(), String> {
        let pane = match id {
            "fullDiskAccess" | "tmuxFullDiskAccess" => "Privacy_AllFiles",
            "microphone" => "Privacy_Microphone",
            "screenRecording" | "tmuxScreenRecording" => "Privacy_ScreenCapture",
            "accessibility" | "tmuxAccessibility" => "Privacy_Accessibility",
            "automation" => "Privacy_Automation",
            _ => return Err("Unknown permission".into()),
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
        run_open(&[&url]).map_err(|_| "System Settings could not be opened".into())
    }

    fn granted(value: bool) -> PermissionStatus {
        if value {
            PermissionStatus::Granted
        } else {
            PermissionStatus::NotGranted
        }
    }

    // There is no API for Full Disk Access. Locations only it unlocks are
    // probed by opening them (never reading contents): access answers
    // "granted", EPERM answers "not granted". Paths differ across macOS
    // versions (the per-user TCC database is gone on newer releases), so the
    // first location that exists decides.
    fn full_disk_access() -> PermissionStatus {
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        let mut probes = vec![std::path::PathBuf::from("/Library/Application Support/com.apple.TCC/TCC.db")];
        if let Some(home) = home {
            probes.push(home.join("Library/Safari"));
            probes.push(home.join("Library/Mail"));
            probes.push(home.join("Library/Messages"));
        }
        for probe in probes {
            let opened = if probe.is_dir() {
                std::fs::read_dir(&probe).map(drop)
            } else {
                std::fs::File::open(&probe).map(drop)
            };
            match opened {
                Ok(()) => return PermissionStatus::Granted,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return PermissionStatus::NotGranted,
                Err(_) => continue,
            }
        }
        PermissionStatus::Unknown
    }

    // Full Disk Access has no system prompt; apps join its list by being
    // dropped in. Showing PzzaCode in Finder next to the pane makes that a
    // single drag instead of a hunt through the "+" file picker.
    fn reveal_app() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|_| "PzzaCode could not locate itself".to_string())?;
        let bundle = exe
            .ancestors()
            .find(|path| path.extension().is_some_and(|extension| extension == "app"))
            .ok_or("PzzaCode is not running from an app bundle")?;
        let bundle = bundle.to_str().ok_or("PzzaCode's location is not valid text")?;
        run_open(&["-R", bundle]).map_err(|_| "Finder could not show PzzaCode".into())
    }

    // The real tmux binary on the user's PATH. macOS records grants for
    // command-line tools by their resolved path (e.g. Homebrew's Cellar path),
    // so symlinks are followed; an upgrade moves it and needs a new grant.
    fn tmux_path() -> Option<std::path::PathBuf> {
        crate::agent::login_path()
            .split(':')
            .map(|directory| std::path::Path::new(directory).join("tmux"))
            .find(|candidate| candidate.is_file())
            .and_then(|candidate| std::fs::canonicalize(candidate).ok())
    }

    // Grants live in the system privacy database, which only Full Disk Access
    // can read; without it the answer is honestly "unknown".
    fn tmux_grant(service: &str) -> PermissionStatus {
        let Some(path) = tmux_path() else {
            return PermissionStatus::Unknown;
        };
        let Some(path) = path.to_str() else {
            return PermissionStatus::Unknown;
        };
        // SQL string literal: the only special character is the quote itself.
        let query = format!(
            "select auth_value from access where service = '{service}' and client_type = 1 and client = '{}'",
            path.replace('\'', "''")
        );
        let Ok(output) = std::process::Command::new("/usr/bin/sqlite3")
            .args(["-readonly", "/Library/Application Support/com.apple.TCC/TCC.db", &query])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        else {
            return PermissionStatus::Unknown;
        };
        if !output.status.success() {
            return PermissionStatus::Unknown;
        }
        match String::from_utf8_lossy(&output.stdout).trim() {
            "" => PermissionStatus::NotGranted,
            "2" | "3" => PermissionStatus::Granted,
            "0" => PermissionStatus::Denied,
            _ => PermissionStatus::Unknown,
        }
    }

    fn reveal_tmux() -> Result<(), String> {
        let path = tmux_path().ok_or("tmux is not installed. Install it from the setup wizard first.")?;
        let path = path.to_str().ok_or("tmux's location is not valid text")?;
        run_open(&["-R", path]).map_err(|_| "Finder could not show tmux".into())
    }

    fn audio_media_type() -> Retained<AnyObject> {
        // AVMediaTypeAudio's value; AVFoundation compares media types by string.
        unsafe { msg_send![class!(NSString), stringWithUTF8String: c"soun".as_ptr()] }
    }

    fn microphone() -> PermissionStatus {
        let Some(device) = AnyClass::get(c"AVCaptureDevice") else {
            return PermissionStatus::Unknown;
        };
        let media = audio_media_type();
        let status: isize = unsafe { msg_send![device, authorizationStatusForMediaType: &*media] };
        match status {
            0 => PermissionStatus::NotGranted,
            1 | 2 => PermissionStatus::Denied,
            3 => PermissionStatus::Granted,
            _ => PermissionStatus::Unknown,
        }
    }

    fn request_microphone() -> Result<(), String> {
        let device = AnyClass::get(c"AVCaptureDevice").ok_or("Microphone access is unavailable")?;
        let media = audio_media_type();
        let (done, answered) = std::sync::mpsc::sync_channel::<()>(1);
        let handler = block2::RcBlock::new(move |_granted: Bool| {
            let _ = done.try_send(());
        });
        let _: () = unsafe { msg_send![device, requestAccessForMediaType: &*media, completionHandler: &*handler] };
        // The prompt waits on the user; give up waiting long before a person would.
        let _ = answered.recv_timeout(Duration::from_secs(600));
        Ok(())
    }

    fn prompt_accessibility() -> Result<(), String> {
        // {kAXTrustedCheckOptionPrompt: YES}; the system alert links to the pane.
        let options: Retained<AnyObject> = unsafe {
            let key: Retained<AnyObject> =
                msg_send![class!(NSString), stringWithUTF8String: c"AXTrustedCheckOptionPrompt".as_ptr()];
            let yes: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithBool: true];
            msg_send![class!(NSDictionary), dictionaryWithObject: &*yes, forKey: &*key]
        };
        unsafe { AXIsProcessTrustedWithOptions(Retained::as_ptr(&options).cast()) };
        Ok(())
    }

    fn automation(ask: bool) -> PermissionStatus {
        let mut target = AEDesc { descriptor_type: 0, data_handle: std::ptr::null_mut() };
        let created = unsafe {
            AECreateDesc(
                four_char(b"bund"),
                SYSTEM_EVENTS.as_ptr().cast(),
                SYSTEM_EVENTS.len() as isize,
                &mut target,
            )
        };
        if created != 0 {
            return PermissionStatus::Unknown;
        }
        let wildcard = four_char(b"****");
        let result = unsafe { AEDeterminePermissionToAutomateTarget(&target, wildcard, wildcard, ask as u8) };
        unsafe { AEDisposeDesc(&mut target) };
        match result {
            NO_ERR => PermissionStatus::Granted,
            EVENT_NOT_PERMITTED => PermissionStatus::Denied,
            WOULD_REQUIRE_CONSENT => PermissionStatus::NotGranted,
            _ => PermissionStatus::Unknown,
        }
    }

    // Automation can only be checked against a running target. System Events
    // is a faceless system agent, so launching it shows nothing.
    fn launch_system_events() -> Result<(), String> {
        run_open(&["-g", "-b", SYSTEM_EVENTS]).map_err(|_| "System Events could not be started".to_string())?;
        for _ in 0..20 {
            if !matches!(automation(false), PermissionStatus::Unknown) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    fn run_open(args: &[&str]) -> Result<(), ()> {
        let status = std::process::Command::new("/usr/bin/open")
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| ())?;
        if status.success() {
            Ok(())
        } else {
            Err(())
        }
    }
}
