#[cfg(target_os = "macos")]
mod macos {
    use std::{ffi::c_void, sync::OnceLock};

    type Connection = unsafe extern "C" fn() -> u32;
    type Blur = unsafe extern "C" fn(u32, u32, u32) -> i32;
    static FUNCTIONS: OnceLock<Result<(Connection, Blur), String>> = OnceLock::new();

    fn functions() -> Result<(Connection, Blur), String> {
        FUNCTIONS
            .get_or_init(|| unsafe {
                // Resolve private compositor entry points at runtime so an OS that
                // removes them reports an error instead of preventing app startup.
                let handle = libc::dlopen(
                    c"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
                        .as_ptr(),
                    libc::RTLD_LAZY,
                );
                if handle.is_null() {
                    return Err("Desktop blur API is unavailable on this macOS version".into());
                }
                let connection = libc::dlsym(handle, c"CGSMainConnectionID".as_ptr());
                let blur = libc::dlsym(handle, c"CGSSetWindowBackgroundBlurRadius".as_ptr());
                if connection.is_null() || blur.is_null() {
                    libc::dlclose(handle);
                    return Err(
                        "Adjustable desktop blur is unavailable on this macOS version".into(),
                    );
                }
                // Keep the framework loaded for the lifetime of these function pointers.
                Ok((
                    std::mem::transmute::<*mut c_void, Connection>(connection),
                    std::mem::transmute::<*mut c_void, Blur>(blur),
                ))
            })
            .clone()
    }

    pub fn apply(window: &tauri::WebviewWindow, radius: u32) -> Result<(), String> {
        let (connection, blur) = functions()?;
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        if pointer.is_null() {
            return Err("Native window is unavailable".into());
        }
        // The caller schedules this on the main thread and owns a live window.
        let number: isize = unsafe {
            objc2::msg_send![&*pointer.cast::<objc2::runtime::AnyObject>(), windowNumber]
        };
        let id = u32::try_from(number).map_err(|_| "Invalid native window identifier")?;
        let status = unsafe { blur(connection(), id, radius) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("macOS rejected desktop blur (error {status})"))
        }
    }
}

#[tauri::command]
pub async fn set_desktop_blur(
    window: tauri::WebviewWindow,
    radius: u32,
) -> Result<(), String> {
    if radius > 64 {
        return Err("Desktop blur radius must be between 0 and 64".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = sender.send(macos::apply(&target, radius));
            })
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "Desktop blur request timed out".to_string())?
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("Adjustable desktop blur is only available on macOS".into())
    }
}
