use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
use std::time::Duration;

// How long a quit, or a restore at launch, waits for the terminal service
// start still running from launch: its login-shell probe, launchctl calls and
// server wait are each bounded, so this only guards against a stuck thread.
pub const LAUNCH_WAIT: Duration = Duration::from_secs(30);

// How long a quit or restart waits for a session refresh or restore to finish
// its journal work. Past it, shutting down goes on: the journal is crash-safe.
#[cfg(target_os = "macos")]
const JOURNAL_WAIT: Duration = Duration::from_secs(60);

// While a logout, restart or shut down waits on this app, the waits above are
// cut short so the rest of cleanup still ends within the answer limit: speech
// (15 s), remote desktops (5 s), the agent (5 s and a kill), terminals and
// the terminal service (one 4 s tmux call) take at most this long.
#[cfg(target_os = "macos")]
const SYSTEM_QUIT_RESERVE: Duration = Duration::from_secs(35);

// Whether the app is shutting down: cleanup started, and was not called off.
// A logout waiting on the app is then answered by cleanup itself.
static QUITTING: AtomicBool = AtomicBool::new(false);

// Told when the app starts shutting down (true) and when that is called off
// (false), so another copy launched meanwhile waits for this one to exit.
static QUIT_OBSERVER: OnceLock<fn(bool)> = OnceLock::new();

pub fn observe_quitting(observer: fn(bool)) {
    let _ = QUIT_OBSERVER.set(observer);
}

fn set_quitting(quitting: bool) {
    QUITTING.store(quitting, Ordering::Release);
    if let Some(observer) = QUIT_OBSERVER.get() {
        observer(quitting);
    }
}

/// How long a cleanup step may wait for `wait` while a logout, restart or
/// shut down has `remaining` left before its answer is due: never so long
/// that the steps after it (`reserve`) would run past the limit.
#[cfg(any(target_os = "macos", test))]
fn quit_wait(wait: Duration, remaining: Option<Duration>, reserve: Duration) -> Duration {
    remaining.map_or(wait, |left| wait.min(left.saturating_sub(reserve)))
}

/// The local terminal service start, which runs off the main thread so the
/// window appears at once. Restoring sessions and shutting down wait for it.
#[derive(Default)]
pub struct TerminalStartup {
    done: Mutex<bool>,
    changed: Condvar,
}

impl TerminalStartup {
    pub fn finish(&self) {
        *self.done.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.changed.notify_all();
    }

    /// Whether the start finished within `timeout`.
    pub fn wait(&self, timeout: Duration) -> bool {
        let done = self.done.lock().unwrap_or_else(PoisonError::into_inner);
        let (done, _) = self
            .changed
            .wait_timeout_while(done, timeout, |done| !*done)
            .unwrap_or_else(PoisonError::into_inner);
        *done
    }
}

#[derive(Clone, Default)]
pub struct ShutdownState {
    phase: Arc<AtomicU8>,
}

impl ShutdownState {
    pub fn complete(&self) -> bool {
        self.phase.load(Ordering::Acquire) == 2
    }

    fn begin(&self) -> Result<(), String> {
        self.phase
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| set_quitting(true))
            .map_err(|_| "PzzaCode is already shutting down. Wait for it to finish.".into())
    }

    fn finish_cleanup(&self, cleanup: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        if let Err(error) = cleanup() {
            self.phase.store(0, Ordering::Release);
            set_quitting(false);
            return Err(error);
        }
        self.phase.store(2, Ordering::Release);
        Ok(())
    }

    // Exit requests must return to the native event loop immediately. Waiting
    // for child processes here would make macOS report an unresponsive app.
    pub fn start(
        &self,
        cleanup: impl FnOnce() -> Result<(), String> + Send + 'static,
        finish: impl FnOnce() + Send + 'static,
    ) {
        if self.begin().is_err() {
            return;
        }
        let state = self.clone();
        std::thread::spawn(move || {
            if let Err(error) = state.finish_cleanup(cleanup) {
                eprintln!("PzzaCode could not finish shutting down: {error}. Quit again to retry.");
                return;
            }
            finish();
        });
    }
}

// How cleanup stops one service, and how to call that off. Each stop marks
// its service as shutting down before it can fail.
struct Stop<'a> {
    stop: &'a dyn Fn() -> Result<(), String>,
    resume: &'a dyn Fn(),
}

// Stops the services in order. When one fails the app keeps running, so every
// service a stop was attempted on, the failed one included, is resumed (newest
// first) instead of staying shut off until the next launch.
fn stop_or_resume(stops: &[Stop<'_>]) -> Result<(), String> {
    for (index, step) in stops.iter().enumerate() {
        if let Err(error) = (step.stop)() {
            for attempted in stops[..=index].iter().rev() {
                (attempted.resume)();
            }
            return Err(error);
        }
    }
    Ok(())
}

fn cleanup(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    // A quit during launch lets the terminal service start finish first, so
    // the stop below releases what that start claims.
    // During a logout, restart or shut down each wait leaves room for the
    // rest of cleanup before the answer limit (see SYSTEM_QUIT_RESERVE).
    #[cfg(target_os = "macos")]
    let budget = |wait: Duration| quit_wait(wait, system_quit::remaining(), SYSTEM_QUIT_RESERVE);
    #[cfg(target_os = "macos")]
    if let Some(startup) = app.try_state::<TerminalStartup>() {
        if !startup.wait(budget(LAUNCH_WAIT)) {
            eprintln!("PzzaCode: the local terminal service is still starting; shutting down anyway");
        }
    }
    // A refresh or restore that is running (in any app copy) finishes its
    // journal work before the terminal service is let go, and none starts
    // after this. The hold is released when cleanup fails (the app stays
    // open) and kept until exit otherwise.
    #[cfg(target_os = "macos")]
    let journal = crate::session_refresh::hold_journal_for_quit(app, budget(JOURNAL_WAIT));
    #[cfg(target_os = "macos")]
    let speech = Stop {
        stop: &|| app.state::<crate::speech::SpeechState>().shutdown(Duration::from_secs(15)),
        resume: &|| app.state::<crate::speech::SpeechState>().resume(),
    };
    let rdp = Stop { stop: &crate::rdp::shutdown, resume: &crate::rdp::resume };
    let agent = Stop {
        stop: &|| crate::agent::stop(app),
        resume: &|| crate::agent::resume(app),
    };
    stop_or_resume(&[
        #[cfg(target_os = "macos")]
        speech,
        rdp,
        agent,
    ])?;
    // These cannot fail, so they run only once nothing can be called off.
    app.state::<crate::pty::PtyState>().shutdown();
    #[cfg(target_os = "macos")]
    crate::local_tmux::stop();
    #[cfg(target_os = "macos")]
    if let Some(journal) = journal {
        journal.keep_until_exit();
    }
    Ok(())
}

#[tauri::command]
pub async fn app_restart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    app.state::<ShutdownState>().begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let cleaned = app.state::<ShutdownState>().finish_cleanup(|| cleanup(&app));
        // The app stays open, so a logout waiting on it cannot go on.
        #[cfg(target_os = "macos")]
        if cleaned.is_err() {
            system_quit::answer(false);
        }
        cleaned?;
        // Restart exit requests cannot be prevented by Tauri. Release native
        // resources before requesting one, while failures can still reach the UI.
        app.request_restart();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub fn handle_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    use tauri::Manager;
    if let tauri::RunEvent::WindowEvent {
        event: tauri::WindowEvent::Destroyed,
        ..
    } = &event
    {
        if app.webview_windows().is_empty() {
            app.exit(0);
        }
    }
    if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
        let shutdown = app.state::<ShutdownState>();
        if shutdown.complete() {
            // A logout, restart or shut down waits for this answer; AppKit
            // then ends the app itself.
            #[cfg(target_os = "macos")]
            if system_quit::answer(true) {
                api.prevent_exit();
            }
            return;
        }
        api.prevent_exit();
        let cleanup_app = app.clone();
        let exit_app = app.clone();
        shutdown.start(
            move || {
                let result = cleanup(&cleanup_app);
                #[cfg(target_os = "macos")]
                if let Err(error) = &result {
                    // The app stays open, so the logout or restart cannot go on.
                    system_quit::answer(false);
                    show_shutdown_error(&cleanup_app, error);
                }
                result
            },
            move || exit_app.exit(code.unwrap_or(0)),
        );
    }
}

#[cfg(target_os = "macos")]
fn show_shutdown_error(app: &tauri::AppHandle, error: &str) {
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
    let text = std::ffi::CString::new(
        format!(
            "{error}. PzzaCode has not exited. Wait a moment, then choose Quit again to retry."
        )
        .replace('\0', ""),
    )
    .expect("Shutdown message contains no NUL bytes");
    let _ = app.run_on_main_thread(move || unsafe {
        let alert: Retained<AnyObject> = msg_send![class!(NSAlert), new];
        let title: Retained<AnyObject> = msg_send![class!(NSString), stringWithUTF8String: c"PzzaCode could not finish shutting down".as_ptr()];
        let message: Retained<AnyObject> = msg_send![class!(NSString), stringWithUTF8String: text.as_ptr()];
        let _: () = msg_send![&alert, setMessageText: &*title];
        let _: () = msg_send![&alert, setInformativeText: &*message];
        let _: isize = msg_send![&alert, runModal];
    });
}

// The native application menu and Dock send terminate: directly. Tao's
// applicationWillTerminate notification is too late to defer that exit.
#[cfg(target_os = "macos")]
pub fn install_native_quit(request: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
    use objc2::runtime::{AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel, MainThreadMarker};
    use std::sync::OnceLock;

    static REQUEST: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
    extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: &AnyObject) -> usize {
        // A logout, restart or shut down is cancelled outright by
        // NSTerminateCancel. For those, AppKit is answered once the same
        // managed exit path finishes cleanup (see system_quit::answer).
        let system = unsafe { system_quit::requested() };
        if system && !system_quit::defer() {
            // An answer is already owed for an earlier one.
            return system_quit::NS_TERMINATE_LATER;
        }
        if let Some(request) = REQUEST.get() {
            request();
        }
        if system {
            return system_quit::NS_TERMINATE_LATER;
        }
        // NSTerminateCancel: the accepted window close will re-enter our
        // managed exit path. A cancelled unsaved-work dialog changes nothing.
        0
    }

    MainThreadMarker::new().ok_or("Native Quit must be installed on the main thread")?;
    unsafe {
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![application, delegate];
        let delegate = delegate
            .as_ref()
            .ok_or("Native application delegate is unavailable")?;
        let class = delegate.class();
        let selector = sel!(applicationShouldTerminate:);
        if class.instance_method(selector).is_some() {
            return Err("Native application already owns its Quit decision".into());
        }
        REQUEST
            .set(Box::new(request))
            .map_err(|_| "Native Quit was already installed")?;
        // Add only the missing delegate method. Do not replace the delegate,
        // its class, or an inherited implementation used by the event loop.
        let implementation: Imp = std::mem::transmute(
            should_terminate as extern "C-unwind" fn(&AnyObject, Sel, &AnyObject) -> usize,
        );
        if !objc2::ffi::class_addMethod(
            (class as *const objc2::runtime::AnyClass).cast_mut(),
            selector,
            implementation,
            c"Q@:@".as_ptr(),
        )
        .as_bool()
        {
            return Err("Could not install the native Quit decision".into());
        }
    }
    Ok(())
}

/// The window's unsaved-work dialog was cancelled. A logout, restart or shut
/// down waiting on PzzaCode is called off at once instead of at the limit.
#[tauri::command]
pub fn app_quit_cancelled() {
    #[cfg(target_os = "macos")]
    system_quit::answer(false);
}

const fn four_char_code(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

// The keyAEQuitReason values loginwindow sends with its quit Apple event.
const SYSTEM_QUIT_REASONS: [u32; 6] = [
    four_char_code(b"logo"), // kAELogOut
    four_char_code(b"rlgo"), // kAEReallyLogOut
    four_char_code(b"rrst"), // kAEShowRestartDialog
    four_char_code(b"rest"), // kAERestart
    four_char_code(b"rsdn"), // kAEShowShutdownDialog
    four_char_code(b"shut"), // kAEShutDown
];

fn system_quit_reason(reason: u32) -> bool {
    SYSTEM_QUIT_REASONS.contains(&reason)
}

// The answer AppKit awaits after NSTerminateLater. Each deferral gets its own
// generation, so a fallback timer from an earlier one cannot answer a later one.
#[derive(Default)]
struct OwedAnswer {
    pending: AtomicUsize,
    issued: AtomicUsize,
}

impl OwedAnswer {
    // Starts owing an answer; None when one is already owed.
    fn defer(&self) -> Option<usize> {
        let generation = self.issued.fetch_add(1, Ordering::AcqRel) + 1;
        self.pending
            .compare_exchange(0, generation, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| generation)
    }

    // Takes whatever answer is owed; true exactly once per deferral.
    fn take(&self) -> bool {
        self.pending.swap(0, Ordering::AcqRel) != 0
    }

    // Takes the answer only when it is still owed for `generation`.
    fn take_generation(&self, generation: usize) -> bool {
        self.pending
            .compare_exchange(generation, 0, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    // Whether the answer for `generation` is still owed.
    fn owes(&self, generation: usize) -> bool {
        self.pending.load(Ordering::Acquire) == generation
    }

    // At the answer limit: calls the quit off (true, the answer is taken)
    // only while the app is not shutting down. Once cleanup runs it answers
    // itself, YES when it exits or NO when it fails, so the logout is never
    // cancelled for an app that then quits anyway.
    fn call_off_at_limit(&self, generation: usize, quitting: bool) -> bool {
        !quitting && self.take_generation(generation)
    }
}

// macOS asks applicationShouldTerminate: for a logout, restart or shut down
// too. Answering NSTerminateCancel there aborts the whole logout ("PzzaCode
// interrupted restart"). Those quits are answered NSTerminateLater instead,
// and replyToApplicationShouldTerminate: follows once the managed exit path
// has cleaned up (YES), or the app stays open after all (NO).
#[cfg(target_os = "macos")]
mod system_quit {
    use super::{four_char_code, system_quit_reason, OwedAnswer, QUITTING};
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use std::sync::{Mutex, OnceLock, PoisonError};
    use std::time::{Duration, Instant};

    pub const NS_TERMINATE_LATER: usize = 2;
    // When nothing answers sooner (the unsaved-work dialog was cancelled and
    // the window stays open), the logout is called off after this long.
    // Cleanup that starts by then answers itself instead, and keeps its
    // waits within this limit (see quit_wait).
    const ANSWER_LIMIT_SECONDS: i64 = 120;
    // How long past the limit a cleanup that started is waited for at most:
    // more than the steps that may still run once it passed (the reserve).
    const LATE_ANSWER_SECONDS: i64 = 45;

    // The generation owed and when its answer is due.
    static DUE: Mutex<Option<(usize, Instant)>> = Mutex::new(None);

    /// How long until the owed answer is due; None when none is owed.
    pub fn remaining() -> Option<Duration> {
        let (generation, due) = (*DUE.lock().unwrap_or_else(PoisonError::into_inner))?;
        owed().owes(generation).then(|| due.saturating_duration_since(Instant::now()))
    }

    const CORE_EVENT_CLASS: u32 = four_char_code(b"aevt"); // kCoreEventClass
    const QUIT_APPLICATION: u32 = four_char_code(b"quit"); // kAEQuitApplication
    const QUIT_REASON: u32 = four_char_code(b"why?"); // keyAEQuitReason

    #[repr(C)]
    struct DispatchQueue {
        _private: [u8; 0],
    }

    extern "C" {
        // dispatch_get_main_queue() is a macro over this symbol.
        #[link_name = "_dispatch_main_q"]
        static MAIN_QUEUE: DispatchQueue;
        fn dispatch_async_f(queue: *const DispatchQueue, context: *mut c_void, work: extern "C" fn(*mut c_void));
        fn dispatch_after_f(when: u64, queue: *const DispatchQueue, context: *mut c_void, work: extern "C" fn(*mut c_void));
        fn dispatch_time(when: u64, delta: i64) -> u64;
    }

    fn owed() -> &'static OwedAnswer {
        static OWED: OnceLock<OwedAnswer> = OnceLock::new();
        OWED.get_or_init(OwedAnswer::default)
    }

    /// Whether the quit being decided comes from loginwindow for a logout,
    /// restart or shut down. Must run inside applicationShouldTerminate:.
    pub unsafe fn requested() -> bool {
        let manager: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        let Some(manager) = manager.as_ref() else {
            return false;
        };
        let event: *mut AnyObject = msg_send![manager, currentAppleEvent];
        let Some(event) = event.as_ref() else {
            return false;
        };
        let event_class: u32 = msg_send![event, eventClass];
        let event_id: u32 = msg_send![event, eventID];
        if event_class != CORE_EVENT_CLASS || event_id != QUIT_APPLICATION {
            return false;
        }
        let reason: *mut AnyObject = msg_send![event, attributeDescriptorForKeyword: QUIT_REASON];
        let Some(reason) = reason.as_ref() else {
            return false;
        };
        let mut code: u32 = msg_send![reason, typeCodeValue];
        if code == 0 {
            code = msg_send![reason, enumCodeValue];
        }
        system_quit_reason(code)
    }

    /// Starts owing AppKit an answer, with a fallback that calls the quit off
    /// at the limit. False when an answer is already owed.
    pub fn defer() -> bool {
        let Some(generation) = owed().defer() else {
            return false;
        };
        let due = Instant::now() + Duration::from_secs(ANSWER_LIMIT_SECONDS as u64);
        *DUE.lock().unwrap_or_else(PoisonError::into_inner) = Some((generation, due));
        unsafe {
            dispatch_after_f(
                dispatch_time(0, ANSWER_LIMIT_SECONDS * 1_000_000_000),
                &MAIN_QUEUE,
                generation as *mut c_void,
                answer_at_limit,
            );
        }
        true
    }

    /// Answers a deferred logout, restart or shut down; false when none is
    /// waiting. Safe from any thread and from inside event loop callbacks:
    /// the reply runs on the main queue after the current callback returns.
    pub fn answer(allow: bool) -> bool {
        if !owed().take() {
            return false;
        }
        unsafe {
            dispatch_async_f(&MAIN_QUEUE, usize::from(allow) as *mut c_void, reply);
        }
        true
    }

    extern "C" fn answer_at_limit(generation: *mut c_void) {
        let generation = generation as usize;
        if owed().call_off_at_limit(generation, QUITTING.load(Ordering::Acquire)) {
            eprintln!("PzzaCode did not finish quitting in time; the logout or restart was called off");
            reply(std::ptr::null_mut());
        } else if owed().owes(generation) {
            eprintln!("PzzaCode is still shutting down; the logout or restart goes on once it is done");
            // Cleanup's waits are all bounded; should it still not answer by
            // then, the logout goes on anyway (nothing it saves is lost when
            // the app ends midway).
            unsafe {
                dispatch_after_f(
                    dispatch_time(0, LATE_ANSWER_SECONDS * 1_000_000_000),
                    &MAIN_QUEUE,
                    generation as *mut c_void,
                    answer_late,
                );
            }
        }
    }

    extern "C" fn answer_late(generation: *mut c_void) {
        if owed().take_generation(generation as usize) {
            eprintln!("PzzaCode is still shutting down; letting the logout or restart go on");
            reply(1 as *mut c_void);
        }
    }

    extern "C" fn reply(allow: *mut c_void) {
        unsafe {
            let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if let Some(application) = application.as_ref() {
                let _: () = msg_send![application, replyToApplicationShouldTerminate: Bool::new(!allow.is_null())];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn shutdown_does_not_block_the_requesting_thread_or_start_twice() {
        let state = ShutdownState::default();
        let (release, waiting) = mpsc::channel();
        let (completed, result) = mpsc::channel();
        let start = Instant::now();
        state.start(
            move || {
                waiting.recv_timeout(Duration::from_secs(2)).unwrap();
                Ok(())
            },
            move || completed.send(()).unwrap(),
        );
        assert!(start.elapsed() < Duration::from_millis(100));
        assert!(!state.complete());
        let (duplicate, duplicate_result) = mpsc::channel();
        state.start(
            move || {
                duplicate.send(()).unwrap();
                Ok(())
            },
            || {},
        );
        assert!(duplicate_result
            .recv_timeout(Duration::from_millis(20))
            .is_err());
        release.send(()).unwrap();
        result.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(state.complete());
    }

    #[test]
    fn failed_cleanup_never_exits_and_can_be_retried() {
        let state = ShutdownState::default();
        let (finished, result) = mpsc::channel();
        state.start(
            || Err("Native resources still in use".into()),
            move || finished.send(()).unwrap(),
        );
        assert!(result.recv_timeout(Duration::from_secs(2)).is_err());
        assert!(!state.complete());
        let (finished, result) = mpsc::channel();
        state.start(|| Ok(()), move || finished.send(()).unwrap());
        result.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(state.complete());
    }

    #[test]
    fn exit_is_allowed_only_after_cleanup_finishes() {
        let state = ShutdownState::default();
        let phase = state.phase.clone();
        let (completed, result) = mpsc::channel();
        state.start(
            || Ok(()),
            move || completed.send(phase.load(Ordering::Acquire)).unwrap(),
        );
        assert_eq!(result.recv_timeout(Duration::from_secs(2)).unwrap(), 2);
    }

    #[test]
    fn a_failed_stop_resumes_every_service_it_reached_newest_first() {
        let log = std::cell::RefCell::new(Vec::new());
        let note = |entry: &'static str| log.borrow_mut().push(entry);
        let result = stop_or_resume(&[
            Stop { stop: &|| { note("stop speech"); Ok(()) }, resume: &|| note("resume speech") },
            Stop { stop: &|| { note("stop rdp"); Err("still closing".into()) }, resume: &|| note("resume rdp") },
            Stop { stop: &|| { note("stop agent"); Ok(()) }, resume: &|| note("resume agent") },
        ]);
        assert_eq!(result, Err("still closing".into()));
        assert_eq!(*log.borrow(), ["stop speech", "stop rdp", "resume rdp", "resume speech"]);
    }

    #[test]
    fn stops_that_all_succeed_resume_nothing() {
        let log = std::cell::RefCell::new(Vec::new());
        let note = |entry: &'static str| log.borrow_mut().push(entry);
        let result = stop_or_resume(&[
            Stop { stop: &|| { note("stop speech"); Ok(()) }, resume: &|| note("resume speech") },
            Stop { stop: &|| { note("stop agent"); Ok(()) }, resume: &|| note("resume agent") },
        ]);
        assert_eq!(result, Ok(()));
        assert_eq!(*log.borrow(), ["stop speech", "stop agent"]);
    }

    #[test]
    fn terminal_startup_waits_until_it_finishes_or_the_limit() {
        let startup = Arc::new(TerminalStartup::default());
        assert!(!startup.wait(Duration::from_millis(10)));
        let finisher = startup.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            finisher.finish();
        });
        let start = Instant::now();
        assert!(startup.wait(Duration::from_secs(2)));
        assert!(start.elapsed() < Duration::from_secs(1));
        thread.join().unwrap();
        assert!(startup.wait(Duration::ZERO));
    }

    #[test]
    fn only_logout_restart_and_shut_down_are_system_quits() {
        for reason in [b"logo", b"rlgo", b"rrst", b"rest", b"rsdn", b"shut"] {
            assert!(system_quit_reason(four_char_code(reason)));
        }
        assert!(!system_quit_reason(0));
        assert!(!system_quit_reason(four_char_code(b"quit")));
    }

    #[test]
    fn a_deferred_quit_is_answered_exactly_once() {
        let owed = OwedAnswer::default();
        assert!(!owed.take());
        let first = owed.defer().unwrap();
        assert_eq!(owed.defer(), None);
        assert!(owed.take());
        assert!(!owed.take());
        // The limit for an answered deferral never answers a later one.
        let second = owed.defer().unwrap();
        assert_ne!(first, second);
        assert!(!owed.take_generation(first));
        assert!(owed.take_generation(second));
        assert!(!owed.take());
    }

    #[test]
    fn the_limit_never_calls_off_a_quit_that_is_cleaning_up() {
        let owed = OwedAnswer::default();
        let generation = owed.defer().unwrap();
        // Cleanup runs: the answer stays owed for cleanup to give.
        assert!(!owed.call_off_at_limit(generation, true));
        assert!(owed.owes(generation));
        // Nothing runs (the window stays open): the quit is called off once.
        assert!(owed.call_off_at_limit(generation, false));
        assert!(!owed.owes(generation));
        assert!(!owed.call_off_at_limit(generation, false));
        assert!(!owed.take(), "cleanup finishing later has nothing left to answer");
    }

    #[test]
    fn cleanup_waits_leave_room_for_the_rest_before_the_answer_limit() {
        let reserve = Duration::from_secs(35);
        let wait = Duration::from_secs(60);
        // No logout waiting: the full wait.
        assert_eq!(quit_wait(wait, None, reserve), wait);
        // Plenty of time left: still the full wait.
        assert_eq!(quit_wait(wait, Some(Duration::from_secs(120)), reserve), wait);
        // Short on time: only what leaves the reserve, never below zero.
        assert_eq!(quit_wait(wait, Some(Duration::from_secs(50)), reserve), Duration::from_secs(15));
        assert_eq!(quit_wait(wait, Some(Duration::from_secs(10)), reserve), Duration::ZERO);
        // The launch and journal waits of a cleanup that starts right away
        // fit within the 120 s limit together with the reserve.
        let launch = quit_wait(Duration::from_secs(30), Some(Duration::from_secs(120)), reserve);
        let journal = quit_wait(wait, Some(Duration::from_secs(120) - launch), reserve);
        assert!(launch + journal + reserve <= Duration::from_secs(120));
    }
}
