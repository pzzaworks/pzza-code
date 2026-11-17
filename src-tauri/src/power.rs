//! Settings > General > Power: keep agents running while PzzaCode is open.
//!
//! Two holds, both tied to this process so nothing outlives the app:
//! - A `PreventUserIdleSystemSleep` power assertion stops idle sleep. macOS
//!   drops it on its own when the process exits.
//! - Sleep on lid close ignores assertions; only the kernel's SleepDisabled
//!   flag stops it, and only root may set it. The privileged helper
//!   (`src/bin/pzzacode-power-helper.rs`, registered with SMAppService) keeps
//!   the flag on while this process holds a connection to it, and clears it as
//!   soon as the connection closes, including on a crash or kill.
//!
//! The web view sends the preference on every launch, so nothing is held
//! before it loads. A background check re-applies it every 30 seconds to
//! follow the power source, battery level, Low Power Mode and heat, to send
//! the helper's heartbeat (it lets go of a hung app), and to reconnect after
//! the helper restarts. Commands run off the main thread: talking to the
//! helper and to launchd must never stall the window.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// How often power conditions and the helper connection are re-checked; also
/// the helper heartbeat interval (checked against the protocol below).
const RECHECK: Duration = Duration::from_secs(30);
/// Below this charge (on battery) the Mac is allowed to sleep again.
const BATTERY_FLOOR: u8 = 20;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwake {
    pub enabled: bool,
    /// Keep holding on battery (down to `BATTERY_FLOOR`), not only on power.
    pub on_battery: bool,
}

/// The lid-close helper's install state, as the settings page shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HelperStatus {
    /// Needs macOS 13 or later (or a platform other than macOS).
    Unsupported,
    /// Not inside the installed, signed app (a development build).
    Unavailable,
    NotInstalled,
    /// Registered; waiting for the switch in System Settings > Login Items.
    NeedsApproval,
    Ready,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    pub helper: HelperStatus,
    /// Idle sleep is held off.
    pub awake: bool,
    /// Sleep on lid close is held off.
    pub lid: bool,
    /// Why holding is paused right now ("On battery", "Low Power Mode"...).
    pub paused: Option<&'static str>,
    pub error: Option<String>,
}

/// The power situation the holds depend on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Conditions {
    on_battery: bool,
    battery_percent: Option<u8>,
    low_power: bool,
    critical_heat: bool,
}

/// Why the Mac should be allowed to sleep despite the setting, if it should.
fn pause_reason(prefs: KeepAwake, now: Conditions) -> Option<&'static str> {
    if now.critical_heat {
        return Some("Mac is too hot");
    }
    if !now.on_battery {
        return None;
    }
    if !prefs.on_battery {
        Some("On battery")
    } else if now.low_power {
        Some("Low Power Mode")
    } else if now.battery_percent.is_some_and(|percent| percent < BATTERY_FLOOR) {
        Some("Battery below 20%")
    } else {
        None
    }
}

#[derive(Default)]
struct Inner {
    prefs: KeepAwake,
    worker: bool,
    holds: platform::Holds,
    paused: Option<&'static str>,
    error: Option<String>,
}

#[derive(Default)]
struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
}

#[derive(Default)]
pub struct PowerState(Arc<Shared>);

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Runs blocking power work (helper socket, launchd, IOKit) on a worker
/// thread, never on the main thread that Tauri uses for sync commands.
async fn off_main<T: Send + 'static>(
    state: tauri::State<'_, PowerState>,
    work: impl FnOnce(&Arc<Shared>) -> T + Send + 'static,
) -> Result<T, String> {
    let shared = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || work(&shared))
        .await
        .map_err(|error| format!("Power settings failed: {error}"))
}

impl Shared {
    fn configure(self: &Arc<Self>, prefs: KeepAwake) -> PowerStatus {
        let mut inner = self.lock();
        inner.prefs = prefs;
        apply(&mut inner);
        if prefs.enabled && !inner.worker {
            let shared = Arc::clone(self);
            let spawned = std::thread::Builder::new()
                .name("power-keep-awake".into())
                .spawn(move || recheck_loop(&shared));
            match spawned {
                Ok(_) => inner.worker = true,
                Err(error) => inner.error = Some(format!("Could not start the power check: {error}")),
            }
        }
        // Wakes a running check so it sees the new preference (and exits when off).
        self.wake.notify_all();
        status(&inner)
    }
}

fn recheck_loop(shared: &Shared) {
    let mut inner = shared.lock();
    loop {
        inner = shared
            .wake
            .wait_timeout(inner, RECHECK)
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .0;
        if !inner.prefs.enabled {
            inner.worker = false;
            return;
        }
        apply(&mut inner);
    }
}

/// Brings the holds in line with the preference and current conditions.
fn apply(inner: &mut Inner) {
    let wanted = inner.prefs.enabled;
    inner.paused = wanted.then(|| pause_reason(inner.prefs, platform::conditions())).flatten();
    let hold = wanted && inner.paused.is_none();
    inner.error = inner.holds.set(hold).err();
}

fn status(inner: &Inner) -> PowerStatus {
    PowerStatus {
        helper: platform::helper_status(),
        awake: inner.holds.awake(),
        lid: inner.holds.lid(),
        paused: inner.paused,
        error: inner.error.clone(),
    }
}

/// Applies the Power settings and returns what is held now.
#[tauri::command]
pub async fn power_keep_awake(state: tauri::State<'_, PowerState>, enabled: bool, on_battery: bool) -> Result<PowerStatus, String> {
    off_main(state, move |shared| shared.configure(KeepAwake { enabled, on_battery })).await
}

#[tauri::command]
pub async fn power_status(state: tauri::State<'_, PowerState>) -> Result<PowerStatus, String> {
    off_main(state, |shared| status(&shared.lock())).await
}

/// Registers the lid-close helper. macOS then asks for approval in System
/// Settings > Login Items, which this opens; the background check (and the
/// window regaining focus) picks the helper up once it is switched on.
#[tauri::command]
pub async fn power_install_helper(state: tauri::State<'_, PowerState>) -> Result<PowerStatus, String> {
    off_main(state, |shared| {
        platform::install_helper()?;
        let mut inner = shared.lock();
        apply(&mut inner);
        Ok(status(&inner))
    })
    .await?
}

#[tauri::command]
pub async fn power_open_login_items(state: tauri::State<'_, PowerState>) -> Result<(), String> {
    off_main(state, |_| platform::open_login_items()).await?
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Conditions, HelperStatus};
    use crate::power_ipc::{HEARTBEAT_SECS, HELLO, REPLY_ERROR, REPLY_HELD, SOCKET_PATH};
    use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType};
    use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo, NSProcessInfoThermalState, NSString};
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
    use std::os::unix::net::UnixStream;
    use std::ptr::NonNull;
    use std::time::Duration;

    // The recheck sends the heartbeat, so it must run at the protocol's pace.
    const _: () = assert!(super::RECHECK.as_secs() == HEARTBEAT_SECS);

    /// The LaunchDaemon plist in `Contents/Library/LaunchDaemons`.
    const DAEMON_PLIST: &str = "com.pzzacode.app.power.plist";
    const ASSERTION_NAME: &str = "PzzaCode is keeping agents running";
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(kind: &CFString, level: u32, name: &CFString, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
        fn IOPSCopyPowerSourcesInfo() -> Option<NonNull<CFType>>;
        fn IOPSCopyPowerSourcesList(blob: &CFType) -> Option<NonNull<CFArray>>;
        fn IOPSGetPowerSourceDescription(blob: &CFType, source: &CFType) -> *const CFDictionary;
        fn IOPSGetProvidingPowerSourceType(blob: &CFType) -> *const CFString;
    }

    fn at_least(major: isize) -> bool {
        NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
            majorVersion: major,
            minorVersion: 0,
            patchVersion: 0,
        })
    }

    #[derive(Default)]
    pub struct Holds {
        assertion: Option<u32>,
        lid: Option<UnixStream>,
    }

    impl Holds {
        pub fn awake(&self) -> bool {
            self.assertion.is_some()
        }

        pub fn lid(&self) -> bool {
            self.lid.is_some()
        }

        /// Takes or lets go of both holds. The idle hold never depends on the
        /// helper; a lid hold that cannot be taken is reported as the error.
        pub fn set(&mut self, hold: bool) -> Result<(), String> {
            if !hold {
                self.lid = None;
                if let Some(id) = self.assertion.take() {
                    // SAFETY: `id` came from IOPMAssertionCreateWithName.
                    unsafe { IOPMAssertionRelease(id) };
                }
                return Ok(());
            }
            if self.assertion.is_none() {
                let mut id = 0;
                let kind = CFString::from_static_str("PreventUserIdleSystemSleep");
                let name = CFString::from_str(ASSERTION_NAME);
                // SAFETY: both strings are live CFStrings and `id` is writable.
                if unsafe { IOPMAssertionCreateWithName(&kind, K_IOPM_ASSERTION_LEVEL_ON, &name, &mut id) } != 0 {
                    return Err("macOS refused to keep the Mac awake".into());
                }
                self.assertion = Some(id);
            }
            // Each apply doubles as the heartbeat; a helper that went away
            // (or let go) is reconnected below.
            if self.lid.as_ref().is_some_and(|stream| !connection_open(stream) || (&*stream).write_all(b".").is_err()) {
                self.lid = None;
            }
            if self.lid.is_none() && helper_status() == HelperStatus::Ready {
                self.lid = Some(hold_lid()?);
            }
            Ok(())
        }
    }

    /// Whether the helper is still on the other end (it closes the connection
    /// only when it stops).
    fn connection_open(stream: &UnixStream) -> bool {
        if stream.set_nonblocking(true).is_err() {
            return false;
        }
        let mut probe = [0u8; 1];
        let open = match (&*stream).read(&mut probe) {
            Ok(0) => false,
            Ok(_) => true,
            Err(error) => error.kind() == ErrorKind::WouldBlock,
        };
        stream.set_nonblocking(false).is_ok() && open
    }

    fn hold_lid() -> Result<UnixStream, String> {
        let stream = UnixStream::connect(SOCKET_PATH)
            .map_err(|error| format!("The power helper is not running ({error})"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|error| error.to_string())?;
        writeln!(&stream, "{HELLO}").map_err(|error| format!("The power helper did not answer ({error})"))?;
        let mut reply = String::new();
        BufReader::new(&stream)
            .read_line(&mut reply)
            .map_err(|error| format!("The power helper did not answer ({error})"))?;
        let reply = reply.trim();
        if reply == REPLY_HELD {
            return Ok(stream);
        }
        let reason = reply.strip_prefix(REPLY_ERROR).map(str::trim).filter(|reason| !reason.is_empty());
        Err(format!("The power helper refused: {}", reason.unwrap_or("no reason given")))
    }

    fn service() -> Option<objc2::rc::Retained<SMAppService>> {
        // SMAppService is macOS 13+; the class does not exist before that.
        // SAFETY: plain class method with a valid NSString.
        at_least(13).then(|| unsafe { SMAppService::daemonServiceWithPlistName(&NSString::from_str(DAEMON_PLIST)) })
    }

    pub fn helper_status() -> HelperStatus {
        let Some(service) = service() else { return HelperStatus::Unsupported };
        // SAFETY: plain property read.
        match unsafe { service.status() } {
            SMAppServiceStatus::Enabled => HelperStatus::Ready,
            SMAppServiceStatus::RequiresApproval => HelperStatus::NeedsApproval,
            SMAppServiceStatus::NotRegistered => HelperStatus::NotInstalled,
            _ => HelperStatus::Unavailable,
        }
    }

    pub fn install_helper() -> Result<(), String> {
        let service = service().ok_or("Keeping the Mac awake with the lid closed needs macOS 13 or later")?;
        // SAFETY: plain method calls on a live SMAppService.
        let registered = unsafe { service.registerAndReturnError() };
        match unsafe { service.status() } {
            SMAppServiceStatus::Enabled => Ok(()),
            SMAppServiceStatus::RequiresApproval => open_login_items(),
            SMAppServiceStatus::NotFound => {
                Err("The power helper is only available in the installed PzzaCode app".into())
            }
            _ => Err(registered
                .err()
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| "macOS did not install the power helper".into())),
        }
    }

    pub fn open_login_items() -> Result<(), String> {
        if !at_least(13) {
            return Err("Needs macOS 13 or later".into());
        }
        // SAFETY: class method with no arguments.
        unsafe { SMAppService::openSystemSettingsLoginItems() };
        Ok(())
    }

    pub fn conditions() -> Conditions {
        let process = NSProcessInfo::processInfo();
        let mut now = Conditions {
            critical_heat: process.thermalState() == NSProcessInfoThermalState::Critical,
            // Low Power Mode exists on macOS 12 and later.
            low_power: at_least(12) && process.isLowPowerModeEnabled(),
            ..Conditions::default()
        };
        // SAFETY: every Copy result is wrapped in CFRetained; Get results are
        // borrowed from `blob`, which outlives their use.
        unsafe {
            let Some(blob) = IOPSCopyPowerSourcesInfo() else { return now };
            let blob = CFRetained::from_raw(blob);
            let providing = IOPSGetProvidingPowerSourceType(&blob);
            now.on_battery = !providing.is_null() && (*providing).to_string() == "Battery Power";
            let Some(list) = IOPSCopyPowerSourcesList(&blob) else { return now };
            let list = CFRetained::from_raw(list);
            for index in 0..list.count() {
                let source = list.value_at_index(index).cast::<CFType>();
                if source.is_null() {
                    continue;
                }
                let description = IOPSGetPowerSourceDescription(&blob, &*source);
                if description.is_null() {
                    continue;
                }
                let description = &*description;
                if let (Some(current), Some(max)) = (number(description, "Current Capacity"), number(description, "Max Capacity")) {
                    if max > 0 {
                        now.battery_percent = Some((current.clamp(0, max) * 100 / max) as u8);
                        break;
                    }
                }
            }
        }
        now
    }

    fn number(description: &CFDictionary, key: &'static str) -> Option<i64> {
        let key = CFString::from_static_str(key);
        // SAFETY: power source descriptions are CFString-keyed dictionaries;
        // the value is type-checked before use.
        let value = unsafe { description.value((&*key as *const CFString).cast()) }.cast::<CFType>();
        if value.is_null() {
            return None;
        }
        // SAFETY: non-null values in the dictionary are live CF objects.
        unsafe { &*value }.downcast_ref::<CFNumber>()?.as_i64()
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{Conditions, HelperStatus};

    #[derive(Default)]
    pub struct Holds;

    impl Holds {
        pub fn awake(&self) -> bool {
            false
        }

        pub fn lid(&self) -> bool {
            false
        }

        pub fn set(&mut self, hold: bool) -> Result<(), String> {
            if hold {
                Err("Keeping the computer awake is only managed on macOS".into())
            } else {
                Ok(())
            }
        }
    }

    pub fn helper_status() -> HelperStatus {
        HelperStatus::Unsupported
    }

    pub fn install_helper() -> Result<(), String> {
        Err("Only available on macOS".into())
    }

    pub fn open_login_items() -> Result<(), String> {
        Err("Only available on macOS".into())
    }

    pub fn conditions() -> Conditions {
        Conditions::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON_POWER: Conditions = Conditions { on_battery: false, battery_percent: Some(100), low_power: false, critical_heat: false };
    const BATTERY: Conditions = Conditions { on_battery: true, battery_percent: Some(80), low_power: false, critical_heat: false };
    const POWER_ONLY: KeepAwake = KeepAwake { enabled: true, on_battery: false };
    const ANY_POWER: KeepAwake = KeepAwake { enabled: true, on_battery: true };

    #[test]
    fn holds_on_power_adapter() {
        assert_eq!(pause_reason(POWER_ONLY, ON_POWER), None);
        // Low Power Mode set to "Always" must not stop it on the adapter.
        assert_eq!(pause_reason(POWER_ONLY, Conditions { low_power: true, ..ON_POWER }), None);
    }

    #[test]
    fn battery_needs_the_battery_option() {
        assert_eq!(pause_reason(POWER_ONLY, BATTERY), Some("On battery"));
        assert_eq!(pause_reason(ANY_POWER, BATTERY), None);
    }

    #[test]
    fn battery_floor_and_low_power_mode_pause_on_battery() {
        assert_eq!(pause_reason(ANY_POWER, Conditions { battery_percent: Some(19), ..BATTERY }), Some("Battery below 20%"));
        assert_eq!(pause_reason(ANY_POWER, Conditions { battery_percent: Some(20), ..BATTERY }), None);
        assert_eq!(pause_reason(ANY_POWER, Conditions { low_power: true, ..BATTERY }), Some("Low Power Mode"));
    }

    #[test]
    fn critical_heat_always_pauses() {
        assert_eq!(pause_reason(POWER_ONLY, Conditions { critical_heat: true, ..ON_POWER }), Some("Mac is too hot"));
    }
}
