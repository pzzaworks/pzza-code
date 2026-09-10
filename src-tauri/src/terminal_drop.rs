use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::{Emitter, Manager, Runtime};

const MAX_FILES: usize = 8;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
struct DroppedFile {
    name: String,
    path: String,
    size: u64,
}
struct GrantedFile {
    file: Option<File>,
    info: DroppedFile,
    modified: Option<SystemTime>,
}
struct Grant {
    window: String,
    created: Instant,
    files: Vec<GrantedFile>,
}
#[derive(Default)]
pub(crate) struct DropState(Mutex<HashMap<String, Grant>>);

#[derive(Clone, Serialize)]
struct DropNotice {
    id: String,
    files: Vec<DroppedFile>,
    x: f64,
    y: f64,
    error: Option<String>,
}

fn clean_name(value: &str) -> bool {
    !value.is_empty() && !value.chars().any(|c| c.is_control())
}

// Walk with directory descriptors so swapping an ancestor for a symlink cannot
// redirect a validated OS drop to another file between checking and opening.
#[cfg(unix)]
fn open_regular(path: &Path) -> Result<File, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let components: Vec<_> = path.components().collect();
    if components.first() != Some(&Component::RootDir) || components.len() < 2 {
        return Err("Drop an absolute regular file path.".into());
    }
    let mut file = File::open("/").map_err(|_| "Cannot inspect the dropped file.")?;
    for (index, component) in components.iter().enumerate().skip(1) {
        let Component::Normal(name) = component else {
            return Err("Unsupported dropped path.".into());
        };
        let name = CString::new(name.as_bytes()).map_err(|_| "Invalid dropped filename.")?;
        let directory = index + 1 < components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        // The parent descriptor remains alive for this entire openat call.
        let fd = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err("Cannot read the dropped file. Symlinks are not supported.".into());
        }
        file = unsafe { File::from_raw_fd(fd) };
    }
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect the dropped file.")?
        .is_file()
    {
        return Err(
            "Drop regular files only. Directories and special files are not supported.".into(),
        );
    }
    Ok(file)
}
#[cfg(not(unix))]
fn open_regular(_path: &Path) -> Result<File, String> {
    Err("Secure native file drops are not supported on this platform.".into())
}

fn grant_files(paths: &[PathBuf]) -> Result<Vec<GrantedFile>, String> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err("Drop between one and eight files.".into());
    }
    let mut total = 0;
    let mut files = Vec::new();
    for path in paths {
        let text = path
            .to_str()
            .ok_or("Dropped filenames must be valid Unicode.")?;
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid dropped filename.")?;
        if text.len() > 4096 || name.len() > 255 || !clean_name(text) || !clean_name(name) {
            return Err("Dropped filenames contain unsupported characters or are too long.".into());
        }
        let file = open_regular(path)?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect the dropped file.")?;
        total += metadata.len();
        if metadata.len() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
            return Err("Drop files up to 16 MiB each and 32 MiB total.".into());
        }
        files.push(GrantedFile {
            file: Some(file),
            modified: metadata.modified().ok(),
            info: DroppedFile {
                name: name.into(),
                path: text.into(),
                size: metadata.len(),
            },
        });
    }
    Ok(files)
}

fn take_file(
    state: &DropState,
    window: &str,
    id: &str,
    index: usize,
) -> Result<GrantedFile, String> {
    let mut grants = state
        .0
        .lock()
        .map_err(|_| "Drop capability is unavailable.")?;
    grants.retain(|_, grant| grant.created.elapsed() < TTL);
    let grant = grants
        .get_mut(id)
        .filter(|grant| grant.window == window)
        .ok_or("The native drop expired. Drop the files again.")?;
    let file = grant
        .files
        .get_mut(index)
        .ok_or("Invalid dropped file index.")?;
    Ok(GrantedFile {
        file: Some(
            file.file
                .take()
                .ok_or("This dropped file was already read.")?,
        ),
        info: file.info.clone(),
        modified: file.modified,
    })
}

#[tauri::command]
pub async fn read_dropped_file(
    window: tauri::Window,
    state: tauri::State<'_, DropState>,
    id: String,
    index: usize,
) -> Result<tauri::ipc::Response, String> {
    let granted = take_file(&state, window.label(), &id, index)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = granted.file.ok_or("The dropped file is unavailable.")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Cannot inspect the dropped file.")?;
        if metadata.len() != granted.info.size || metadata.modified().ok() != granted.modified {
            return Err("The dropped file changed. Drop it again.".into());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(granted.info.size + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read the dropped file.")?;
        let after = file
            .metadata()
            .map_err(|_| "Cannot inspect the dropped file.")?;
        if bytes.len() as u64 != granted.info.size
            || after.len() != granted.info.size
            || after.modified().ok() != granted.modified
        {
            return Err("The dropped file changed while reading. Drop it again.".into());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|_| "Could not read the dropped file.".to_string())?
}

#[tauri::command]
pub fn release_drop(
    window: tauri::Window,
    state: tauri::State<'_, DropState>,
    id: String,
) -> Result<(), String> {
    let mut grants = state
        .0
        .lock()
        .map_err(|_| "Drop capability is unavailable.")?;
    if grants
        .get(&id)
        .is_some_and(|grant| grant.window == window.label())
    {
        grants.remove(&id);
    }
    Ok(())
}

// The macOS runtime consumes every native drag when file handling is enabled,
// even drags that contain no files. A per-webview subclass routes those back to
// WebKit so editor selections, tiles, and workspace tabs keep their HTML DnD.
#[cfg(target_os = "macos")]
mod macos_selective {
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use std::sync::OnceLock;
    static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
    static BASE: OnceLock<&'static AnyClass> = OnceLock::new();
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {
        static NSFilenamesPboardType: *mut AnyObject;
    }

    fn dispatch(info: *mut AnyObject) -> &'static AnyClass {
        // This is OS drag metadata, not a renderer-provided filename or path.
        let files = unsafe {
            let pasteboard: *mut AnyObject = msg_send![info, draggingPasteboard];
            let value: *mut AnyObject =
                msg_send![pasteboard, propertyListForType: NSFilenamesPboardType];
            if value.is_null() {
                false
            } else {
                let count: usize = msg_send![value, count];
                count > 0
            }
        };
        if files {
            BASE.get().copied().expect("drop subclass registered")
        } else {
            AnyClass::get(c"WKWebView").expect("webview class registered")
        }
    }
    extern "C" fn entered(this: *mut AnyObject, _: Sel, info: *mut AnyObject) -> usize {
        unsafe { msg_send![super(this, dispatch(info)), draggingEntered: info] }
    }
    extern "C" fn updated(this: *mut AnyObject, _: Sel, info: *mut AnyObject) -> usize {
        unsafe { msg_send![super(this, dispatch(info)), draggingUpdated: info] }
    }
    extern "C" fn perform(this: *mut AnyObject, _: Sel, info: *mut AnyObject) -> Bool {
        unsafe { msg_send![super(this, dispatch(info)), performDragOperation: info] }
    }
    extern "C" fn exited(this: *mut AnyObject, _: Sel, info: *mut AnyObject) {
        unsafe { msg_send![super(this, dispatch(info)), draggingExited: info] }
    }
    pub unsafe fn install(pointer: *mut std::ffi::c_void) -> Result<(), String> {
        let view = pointer
            .cast::<AnyObject>()
            .as_ref()
            .ok_or("Native webview unavailable.")?;
        let base = view.class();
        if CLASS.get().is_some_and(|class| *class == base) {
            return Ok(());
        }
        if BASE.get().is_some_and(|class| *class != base) {
            return Err("Unsupported native webview class.".into());
        }
        let class = if let Some(class) = CLASS.get() {
            *class
        } else {
            let mut builder = ClassBuilder::new(c"PzzaSelectiveFileDrop", base)
                .ok_or("Cannot register native file drops.")?;
            builder.add_method(
                sel!(draggingEntered:),
                entered as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            );
            builder.add_method(
                sel!(draggingUpdated:),
                updated as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            );
            builder.add_method(
                sel!(performDragOperation:),
                perform as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool,
            );
            builder.add_method(
                sel!(draggingExited:),
                exited as extern "C" fn(*mut AnyObject, Sel, *mut AnyObject),
            );
            let class = builder.register();
            let _ = BASE.set(base);
            let _ = CLASS.set(class);
            class
        };
        // Adds no ivars and inherits destruction unchanged. Only these four drag
        // methods differ; each forwards using its original native ABI.
        AnyObject::set_class(view, class);
        Ok(())
    }

    #[test]
    fn drag_callback_abis_match_the_installed_webkit() {
        use objc2::Encode;
        let webkit = AnyClass::get(c"WKWebView").expect("WebKit linked by the desktop runtime");
        for (selector, returns) in [
            (sel!(draggingEntered:), usize::ENCODING.to_string()),
            (sel!(draggingUpdated:), usize::ENCODING.to_string()),
            (sel!(performDragOperation:), Bool::ENCODING.to_string()),
            (sel!(draggingExited:), "v".to_string()),
        ] {
            let method = webkit
                .instance_method(selector)
                .expect("native drag callback exists");
            assert_eq!(method.arguments_count(), 3);
            assert_eq!(method.return_type().to_string_lossy(), returns);
            assert!(method
                .argument_type(2)
                .unwrap()
                .to_string_lossy()
                .starts_with('@'));
        }
    }
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("terminal-drop")
        .setup(|app, _| {
            app.manage(DropState::default());
            Ok(())
        })
        .on_webview_ready(|webview| {
            #[cfg(target_os = "macos")]
            if let Err(error) = webview.with_webview(|native| {
                if let Err(error) = unsafe { macos_selective::install(native.inner()) } {
                    eprintln!("Native file drop setup failed: {error}");
                }
            }) {
                eprintln!("Native file drop setup failed: {error}");
            }
            #[cfg(not(target_os = "macos"))]
            let _ = webview;
        })
        .on_event(|app, event| {
            let tauri::RunEvent::WindowEvent { label, event, .. } = event else {
                return;
            };
            let state = app.state::<DropState>();
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut grants) = state.0.lock() {
                    grants.retain(|_, grant| &grant.window != label);
                }
                return;
            }
            let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) =
                event
            else {
                return;
            };
            if paths.is_empty() {
                return;
            }
            let Some(window) = app.get_webview_window(label) else {
                return;
            };
            // Cocoa draggingLocation/frame use logical points in the installed
            // runtime; other backends provide physical coordinates.
            #[cfg(target_os = "macos")]
            let scale = 1.0;
            #[cfg(not(target_os = "macos"))]
            let scale = window.scale_factor().unwrap_or(1.0);
            let mut notice = DropNotice {
                id: String::new(),
                files: Vec::new(),
                x: position.x as f64 / scale,
                y: position.y as f64 / scale,
                error: None,
            };
            match grant_files(paths) {
                Ok(files) => {
                    if let Some(id) = crate::agent::random_hex(16) {
                        if let Ok(mut grants) = state.0.lock() {
                            grants.retain(|_, grant| grant.created.elapsed() < TTL);
                            if grants.len() >= 4 {
                                notice.error = Some(
                                    "Finish the current file drops before dropping more files."
                                        .into(),
                                );
                            } else {
                                notice.id = id.clone();
                                notice.files = files.iter().map(|file| file.info.clone()).collect();
                                grants.insert(
                                    id,
                                    Grant {
                                        window: label.clone(),
                                        created: Instant::now(),
                                        files,
                                    },
                                );
                            }
                        } else {
                            notice.error = Some("Drop capability is unavailable.".into());
                        }
                    } else {
                        notice.error = Some("Cannot authorize the native file drop.".into());
                    }
                }
                Err(error) => notice.error = Some(error),
            }
            let _ = window.emit("pzza:terminal-drop", notice);
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn only_actual_regular_drop_handles_can_be_read_once() {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "pzza-drop-{}",
            crate::agent::random_hex(8).unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("a ' quoted.txt");
        fs::write(&path, b"original").unwrap();
        let files = grant_files(&[path.clone()]).unwrap();
        let state = DropState::default();
        state.0.lock().unwrap().insert(
            "drop".into(),
            Grant {
                window: "main".into(),
                created: Instant::now(),
                files,
            },
        );
        assert!(take_file(&state, "other", "drop", 0).is_err());
        assert!(take_file(&state, "main", "not-a-drop", 0).is_err());
        let mut granted = take_file(&state, "main", "drop", 0).unwrap();
        assert!(take_file(&state, "main", "drop", 0).is_err());
        fs::rename(&path, root.join("old")).unwrap();
        fs::write(&path, b"replacement").unwrap();
        let mut text = String::new();
        granted
            .file
            .take()
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "original");
        assert!(grant_files(&[root.clone()]).is_err());
        assert!(grant_files(&vec![path.clone(); 9]).is_err());
        assert!(grant_files(&[root.join("control\nname")]).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&path, root.join("link")).unwrap();
            assert!(grant_files(&[root.join("link")]).is_err());
            std::os::unix::fs::symlink(&root, root.join("parent-link")).unwrap();
            assert!(grant_files(&[root.join("parent-link/a ' quoted.txt")]).is_err());
        }
        File::create(&path)
            .unwrap()
            .set_len(MAX_FILE_BYTES + 1)
            .unwrap();
        assert!(grant_files(&[path]).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
