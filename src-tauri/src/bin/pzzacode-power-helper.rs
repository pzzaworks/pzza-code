//! Privileged helper behind "Keep agents running with the lid closed".
//!
//! macOS sleeps on lid close no matter which power assertions are held; only
//! the kernel's SleepDisabled flag (`pmset -a disablesleep 1`) stops it, and
//! only root may set it. PzzaCode registers this binary as a LaunchDaemon with
//! SMAppService (one approval in System Settings > Login Items) and holds the
//! flag by keeping a connection to this helper open.
//!
//! Fail-safe by design: the flag is on only while at least one connection from
//! a process signed as PzzaCode (Developer ID, same team as this helper) is
//! open and sending heartbeats. The moment the last one closes or goes quiet,
//! whether the app quit, crashed, was killed or hung, the flag is cleared.
//!
//! A durable marker file records that the helper set the flag, so a helper
//! that dies (or fails to clear it) while holding it clears it on its next
//! start. A flag that was already on before the helper's first hold is left
//! alone; one set by hand *during* a hold cannot be told apart from ours by
//! `pmset` and is cleared with it.

#[cfg(target_os = "macos")]
#[path = "../power_ipc.rs"]
mod power_ipc;

#[cfg(target_os = "macos")]
fn main() {
    helper::run();
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("pzzacode-power-helper only runs on macOS");
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
mod helper {
    use crate::power_ipc::{HEARTBEAT_SECS, HELLO, REPLY_ERROR, REPLY_HELD, SOCKET_PATH};
    use std::ffi::{c_char, c_void, CString};
    use std::fs::{self, File};
    use std::io::{ErrorKind, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::io::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;
    use std::process::Command;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::thread;
    use std::time::Duration;

    /// Exists only while this helper has (or may have) SleepDisabled switched on.
    const MARKER_PATH: &str = "/var/db/com.pzzacode.app.power.held";
    const MARKER_DIR: &str = "/var/db";
    const PMSET: &str = "/usr/bin/pmset";
    const APP_IDENTIFIER: &str = "com.pzzacode.app";
    /// A connection must say hello this quickly or it is dropped.
    const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
    /// Connections not yet verified, at most; more are refused, so a flood of
    /// local connections cannot exhaust the helper's threads or descriptors.
    const MAX_PENDING: usize = 8;

    #[derive(Default)]
    struct Hold {
        /// Verified connections currently open.
        clients: usize,
        /// Whether this helper switched the flag on (and so must switch it off).
        owned: bool,
    }

    type Shared = Arc<Mutex<Hold>>;

    pub fn run() {
        // Handle termination on a dedicated thread: block the signals here so
        // every thread spawned later inherits the mask, then sigwait for them.
        let signals = termination_signals();
        // SAFETY: `signals` is a fully initialised sigset_t.
        unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut()) };

        if !recover_from_previous_run() {
            // launchd (KeepAlive) starts the helper again shortly to retry.
            eprintln!("pzzacode-power-helper: could not clear SleepDisabled left by a previous run");
            std::process::exit(1);
        }

        let requirement = match peer_requirement() {
            Some(requirement) => requirement,
            None => {
                eprintln!("pzzacode-power-helper: not signed with a team identifier; refusing to run");
                std::process::exit(1);
            }
        };

        let listener = match bind_socket() {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("pzzacode-power-helper: cannot listen on {SOCKET_PATH}: {error}");
                std::process::exit(1);
            }
        };

        let state: Shared = Arc::default();
        {
            let state = Arc::clone(&state);
            thread::spawn(move || wait_for_termination(signals, state));
        }

        let pending = Arc::new(AtomicUsize::new(0));
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(stream) => stream,
                Err(_) => {
                    // Out of descriptors, say: back off instead of spinning.
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
            };
            if pending.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING {
                pending.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let (state, requirement, counter) = (Arc::clone(&state), requirement.clone(), Arc::clone(&pending));
            let spawned = thread::Builder::new().spawn(move || serve(stream, &requirement, &state, Pending(&counter)));
            if spawned.is_err() {
                pending.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    /// Counts a connection as pending until dropped.
    struct Pending<'a>(&'a AtomicUsize);

    impl Drop for Pending<'_> {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn termination_signals() -> libc::sigset_t {
        // SAFETY: sigemptyset initialises the set before sigaddset reads it.
        unsafe {
            let mut set = std::mem::zeroed::<libc::sigset_t>();
            libc::sigemptyset(&mut set);
            for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
                libc::sigaddset(&mut set, signal);
            }
            set
        }
    }

    fn wait_for_termination(signals: libc::sigset_t, state: Shared) {
        let mut received = 0;
        // SAFETY: both pointers are valid for the duration of the call.
        unsafe { libc::sigwait(&signals, &mut received) };
        // Keep the lock until exit so no connection can switch the flag back on.
        let mut hold = lock(&state);
        if hold.owned {
            set_sleep_disabled(false).ok();
            hold.owned = false;
        }
        fs::remove_file(SOCKET_PATH).ok();
        std::process::exit(0);
    }

    /// A previous helper that held the flag and then died (or could not clear
    /// it) left the marker behind: give sleep back before serving anyone.
    fn recover_from_previous_run() -> bool {
        !Path::new(MARKER_PATH).exists() || set_sleep_disabled(false).is_ok()
    }

    fn bind_socket() -> std::io::Result<UnixListener> {
        match fs::remove_file(SOCKET_PATH) {
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let listener = UnixListener::bind(SOCKET_PATH)?;
        // Any local process may connect; each connection is then checked
        // against PzzaCode's code signature before it can change anything.
        fs::set_permissions(SOCKET_PATH, fs::Permissions::from_mode(0o666))?;
        Ok(listener)
    }

    fn serve(mut stream: UnixStream, requirement: &CString, state: &Shared, pending: Pending<'_>) {
        // The signature is checked after the hello arrives, so it is the
        // process that wrote it that must be PzzaCode.
        let verified = stream.set_read_timeout(Some(HELLO_TIMEOUT)).is_ok()
            && read_hello(&mut stream)
            && peer_satisfies(&stream, requirement);
        drop(pending);
        if !verified {
            writeln!(stream, "{REPLY_ERROR} not PzzaCode").ok();
            return;
        }
        if let Err(reason) = acquire(state) {
            writeln!(stream, "{REPLY_ERROR} {reason}").ok();
            return;
        }
        let heartbeat = Duration::from_secs(HEARTBEAT_SECS * 3);
        if writeln!(stream, "{REPLY_HELD}").is_ok() && stream.set_read_timeout(Some(heartbeat)).is_ok() {
            // Hold while heartbeats keep arriving. End of stream (the app is
            // gone) or a missed heartbeat window (it is stopped or hung) ends it.
            let mut buffer = [0u8; 64];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }
        release(state);
    }

    /// Reads the client's first line, byte by byte so nothing after it is
    /// consumed, and accepts only `HELLO`.
    fn read_hello(stream: &mut UnixStream) -> bool {
        let mut line = Vec::with_capacity(HELLO.len() + 1);
        let mut byte = [0u8; 1];
        while line.len() <= HELLO.len() {
            match stream.read(&mut byte) {
                Ok(1) if byte[0] == b'\n' => return line == HELLO.as_bytes(),
                Ok(1) => line.push(byte[0]),
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                _ => return false,
            }
        }
        false
    }

    fn lock(state: &Shared) -> MutexGuard<'_, Hold> {
        state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn acquire(state: &Shared) -> Result<(), String> {
        let mut hold = lock(state);
        if hold.clients == 0 {
            if hold.owned || Path::new(MARKER_PATH).exists() {
                // Ours from an earlier hold: switch it on again in case it was cleared.
                set_sleep_disabled(true)?;
                hold.owned = true;
            } else if sleep_disabled()? {
                // A flag that was on before we held it stays the user's to clear.
                hold.owned = false;
            } else {
                set_sleep_disabled(true)?;
                hold.owned = true;
            }
        }
        hold.clients += 1;
        Ok(())
    }

    fn release(state: &Shared) {
        let mut hold = lock(state);
        hold.clients = hold.clients.saturating_sub(1);
        if hold.clients == 0 && hold.owned {
            if let Err(error) = set_sleep_disabled(false) {
                // Never leave the flag on without a way back: exit with the
                // lock held, and launchd restarts the helper, whose startup
                // clears the flag the marker still records.
                eprintln!("pzzacode-power-helper: could not clear SleepDisabled ({error}); restarting");
                std::process::exit(1);
            }
            hold.owned = false;
        }
    }

    fn sleep_disabled() -> Result<bool, String> {
        let output = Command::new(PMSET)
            .arg("-g")
            .output()
            .map_err(|error| format!("pmset failed: {error}"))?;
        if !output.status.success() {
            return Err("pmset -g failed".into());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(text.lines().any(|line| {
            let mut fields = line.split_whitespace();
            fields.next() == Some("SleepDisabled") && fields.next() == Some("1")
        }))
    }

    /// Writes the marker and flushes it (and its directory entry) to disk, so
    /// it survives a power loss right after the flag is set.
    fn write_marker() -> std::io::Result<()> {
        File::create(MARKER_PATH)?.sync_all()?;
        File::open(MARKER_DIR)?.sync_all()
    }

    /// Switches the kernel's SleepDisabled flag and keeps the marker in step:
    /// the marker is written before switching on and removed after switching
    /// off, so it is present whenever the flag might be ours.
    fn set_sleep_disabled(on: bool) -> Result<(), String> {
        if on {
            write_marker().map_err(|error| format!("marker: {error}"))?;
        }
        let status = Command::new(PMSET)
            .args(["-a", "disablesleep", if on { "1" } else { "0" }])
            .status()
            .map_err(|error| format!("pmset failed: {error}"))?;
        if !status.success() {
            if on {
                fs::remove_file(MARKER_PATH).ok();
            }
            return Err("pmset disablesleep failed".into());
        }
        if !on {
            fs::remove_file(MARKER_PATH).ok();
        }
        Ok(())
    }

    // --- Code signature checks -------------------------------------------

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFDataRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type SecCodeRef = *const c_void;
    type SecStaticCodeRef = *const c_void;
    type SecRequirementRef = *const c_void;
    type OSStatus = i32;
    type SecCSFlags = u32;

    const K_SEC_CS_DEFAULT_FLAGS: SecCSFlags = 0;
    const K_SEC_CS_SIGNING_INFORMATION: SecCSFlags = 1 << 1;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[repr(C)]
    struct CFDictionaryKeyCallBacks {
        version: isize,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
        hash: *const c_void,
    }

    #[repr(C)]
    struct CFDictionaryValueCallBacks {
        version: isize,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
        equal: *const c_void,
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
        static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
        fn CFRelease(value: CFTypeRef);
        fn CFDataCreate(allocator: CFAllocatorRef, bytes: *const u8, length: isize) -> CFDataRef;
        fn CFDictionaryCreate(
            allocator: CFAllocatorRef,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const CFDictionaryKeyCallBacks,
            value_callbacks: *const CFDictionaryValueCallBacks,
        ) -> CFDictionaryRef;
        fn CFDictionaryGetValue(dictionary: CFDictionaryRef, key: *const c_void) -> *const c_void;
        fn CFStringCreateWithCString(allocator: CFAllocatorRef, text: *const c_char, encoding: u32) -> CFStringRef;
        fn CFStringGetCString(text: CFStringRef, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFGetTypeID(value: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecGuestAttributeAudit: CFStringRef;
        static kSecCodeInfoTeamIdentifier: CFStringRef;
        fn SecCodeCopySelf(flags: SecCSFlags, code: *mut SecCodeRef) -> OSStatus;
        fn SecCodeCopyStaticCode(code: SecCodeRef, flags: SecCSFlags, static_code: *mut SecStaticCodeRef) -> OSStatus;
        fn SecCodeCopySigningInformation(code: SecStaticCodeRef, flags: SecCSFlags, information: *mut CFDictionaryRef) -> OSStatus;
        fn SecCodeCopyGuestWithAttributes(host: SecCodeRef, attributes: CFDictionaryRef, flags: SecCSFlags, guest: *mut SecCodeRef) -> OSStatus;
        fn SecRequirementCreateWithString(text: CFStringRef, flags: SecCSFlags, requirement: *mut SecRequirementRef) -> OSStatus;
        fn SecCodeCheckValidity(code: SecCodeRef, flags: SecCSFlags, requirement: SecRequirementRef) -> OSStatus;
    }

    /// Owns one Core Foundation reference and releases it on drop.
    struct Owned(CFTypeRef);

    impl Owned {
        fn new(value: CFTypeRef) -> Option<Self> {
            (!value.is_null()).then_some(Self(value))
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: `Owned` is only built from +1 references we must release.
            unsafe { CFRelease(self.0) };
        }
    }

    fn cf_string(text: &CString) -> Option<Owned> {
        // SAFETY: `text` is a valid NUL-terminated UTF-8 string.
        Owned::new(unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), K_CF_STRING_ENCODING_UTF8) })
    }

    fn rust_string(value: CFTypeRef) -> Option<String> {
        // SAFETY: the type is checked before the value is read as a CFString.
        unsafe {
            if value.is_null() || CFGetTypeID(value) != CFStringGetTypeID() {
                return None;
            }
            let mut buffer = [0 as c_char; 256];
            if CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, K_CF_STRING_ENCODING_UTF8) == 0 {
                return None;
            }
            Some(std::ffi::CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned())
        }
    }

    /// The team that signed this helper. The helper ships inside the app and
    /// is signed with it, so only a PzzaCode signed by the same team may connect;
    /// nothing identifying has to be compiled in.
    fn own_team_identifier() -> Option<String> {
        // SAFETY: each out-pointer is written by the call it is passed to, and
        // every returned +1 reference is wrapped in `Owned`.
        unsafe {
            let mut code = std::ptr::null();
            if SecCodeCopySelf(K_SEC_CS_DEFAULT_FLAGS, &mut code) != 0 {
                return None;
            }
            let code = Owned::new(code)?;
            let mut static_code = std::ptr::null();
            if SecCodeCopyStaticCode(code.0, K_SEC_CS_DEFAULT_FLAGS, &mut static_code) != 0 {
                return None;
            }
            let static_code = Owned::new(static_code)?;
            let mut information = std::ptr::null();
            if SecCodeCopySigningInformation(static_code.0, K_SEC_CS_SIGNING_INFORMATION, &mut information) != 0 {
                return None;
            }
            let information = Owned::new(information)?;
            rust_string(CFDictionaryGetValue(information.0, kSecCodeInfoTeamIdentifier))
        }
    }

    /// The code requirement a connecting process must satisfy: PzzaCode,
    /// signed with a Developer ID Application certificate of this helper's
    /// team (the app's designated requirement). Development and other
    /// distribution signatures of the same team do not pass.
    fn peer_requirement() -> Option<CString> {
        let team = own_team_identifier()?;
        if team.is_empty() || !team.chars().all(|c| c.is_ascii_alphanumeric()) {
            return None;
        }
        CString::new(format!(
            "identifier \"{APP_IDENTIFIER}\" and anchor apple generic \
             and certificate 1[field.1.2.840.113635.100.6.2.6] \
             and certificate leaf[field.1.2.840.113635.100.6.1.13] \
             and certificate leaf[subject.OU] = \"{team}\""
        ))
        .ok()
    }

    /// Checks the connected process's running code against `requirement`,
    /// identified by its audit token (immune to PID reuse).
    fn peer_satisfies(stream: &UnixStream, requirement: &CString) -> bool {
        let mut token = [0u8; 32];
        let mut length = token.len() as libc::socklen_t;
        // SAFETY: `token` is a writable buffer of `length` bytes.
        let status = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut length,
            )
        };
        if status != 0 || length as usize != token.len() {
            return false;
        }
        let Some(text) = cf_string(requirement) else { return false };
        // SAFETY: as in `own_team_identifier`; inputs outlive every call.
        unsafe {
            let Some(data) = Owned::new(CFDataCreate(std::ptr::null(), token.as_ptr(), token.len() as isize)) else {
                return false;
            };
            let keys = [kSecGuestAttributeAudit];
            let values = [data.0];
            let Some(attributes) = Owned::new(CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            )) else {
                return false;
            };
            let mut guest = std::ptr::null();
            if SecCodeCopyGuestWithAttributes(std::ptr::null(), attributes.0, K_SEC_CS_DEFAULT_FLAGS, &mut guest) != 0 {
                return false;
            }
            let Some(guest) = Owned::new(guest) else { return false };
            let mut compiled = std::ptr::null();
            if SecRequirementCreateWithString(text.0, K_SEC_CS_DEFAULT_FLAGS, &mut compiled) != 0 {
                return false;
            }
            let Some(compiled) = Owned::new(compiled) else { return false };
            SecCodeCheckValidity(guest.0, K_SEC_CS_DEFAULT_FLAGS, compiled.0) == 0
        }
    }
}
