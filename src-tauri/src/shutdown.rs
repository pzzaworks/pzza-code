use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct ShutdownState {
    phase: Arc<AtomicU8>,
}

impl ShutdownState {
    pub fn complete(&self) -> bool {
        self.phase.load(Ordering::Acquire) == 2
    }

    // Exit requests must return to the native event loop immediately. Waiting
    // for child processes here would make macOS report an unresponsive app.
    pub fn start(
        &self,
        cleanup: impl FnOnce() -> Result<(), String> + Send + 'static,
        finish: impl FnOnce() + Send + 'static,
    ) {
        if self
            .phase
            .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let phase = self.phase.clone();
        std::thread::spawn(move || {
            if let Err(error) = cleanup() {
                eprintln!("PzzaCode could not finish shutting down: {error}. Quit again to retry.");
                phase.store(0, Ordering::Release);
                return;
            }
            phase.store(2, Ordering::Release);
            finish();
        });
    }
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
            return;
        }
        api.prevent_exit();
        let cleanup_app = app.clone();
        let exit_app = app.clone();
        shutdown.start(
            move || {
                let result: Result<(), String> = (|| {
                    #[cfg(target_os = "macos")]
                    cleanup_app
                        .state::<crate::speech::SpeechState>()
                        .shutdown(std::time::Duration::from_secs(15))?;
                    crate::agent::stop(&cleanup_app)?;
                    cleanup_app.state::<crate::pty::PtyState>().shutdown();
                    Ok(())
                })();
                #[cfg(target_os = "macos")]
                if let Err(error) = &result {
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
        if let Some(request) = REQUEST.get() {
            request();
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
}
