//! The File menu's "Open File…" and "Open Folder…": a native open panel whose
//! choices go through the same delivery as files opened from Finder
//! (open_files::deliver), so they open as file and folder tiles.
//!
//! The panel is AppKit's NSOpenPanel, shown as a sheet on the main window (or
//! as a free-standing panel when that window cannot host one). Both forms are
//! asynchronous: the run loop keeps going while the panel is up.

#[cfg(any(target_os = "macos", test))]
use crate::open_files::{self, Opened};
use serde::Deserialize;
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::PoisonError;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Manager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PickKind {
    /// Any number of regular files.
    File,
    /// One directory.
    Folder,
}

#[derive(Default)]
pub struct OpenPanel(Mutex<PanelState>);

#[derive(Default)]
struct PanelState {
    /// A panel is up; another request is ignored until it closes.
    showing: bool,
    /// The folder the last choice was made in, where the next panel starts.
    last_directory: Option<PathBuf>,
}

#[cfg(any(target_os = "macos", test))]
impl PanelState {
    /// Claims the panel; false while one is already showing.
    fn begin(&mut self) -> bool {
        !std::mem::replace(&mut self.showing, true)
    }
}

/// Where a panel opens: the last folder used while it still exists, else home.
#[cfg(any(target_os = "macos", test))]
fn start_directory(last: Option<&Path>, home: Option<PathBuf>) -> Option<PathBuf> {
    last.filter(|path| path.is_dir())
        .map(Path::to_path_buf)
        .or_else(|| home.filter(|path| path.is_dir()))
}

/// Keeps what `kind` asks for: files from a file panel, one folder from a
/// folder panel (a package such as an .app can still slip through a file
/// panel as a directory).
#[cfg(any(target_os = "macos", test))]
fn chosen(kind: PickKind, opened: Opened) -> Opened {
    match kind {
        PickKind::File => Opened { files: opened.files, folders: Vec::new() },
        PickKind::Folder => Opened { files: Vec::new(), folders: opened.folders.into_iter().take(1).collect() },
    }
}

/// The folder a choice was made in: the one holding the first chosen item.
#[cfg(any(target_os = "macos", test))]
fn chosen_in(opened: &Opened) -> Option<PathBuf> {
    let first = opened.files.first().or(opened.folders.first())?;
    Path::new(first).parent().map(Path::to_path_buf)
}

/// Shows the panel for `kind`; its choice is delivered to the page later.
/// Returns at once, and does nothing while a panel is already showing.
pub fn pick(app: &AppHandle, kind: PickKind) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let start = {
            let state = app.state::<OpenPanel>();
            let mut state = state.0.lock().unwrap_or_else(PoisonError::into_inner);
            if !state.begin() {
                return Ok(());
            }
            start_directory(state.last_directory.as_deref(), app.path().home_dir().ok())
        };
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || macos::show(handle, kind, start)) {
            finished(app, kind, None);
            return Err(error.to_string());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, kind);
        Err("Open File and Open Folder are only available on macOS".into())
    }
}

/// Ends a panel: `paths` is what was chosen, or `None` when it was cancelled
/// (nothing happens then).
#[cfg(target_os = "macos")]
fn finished(app: &AppHandle, kind: PickKind, paths: Option<Vec<PathBuf>>) {
    let Some(paths) = paths else {
        app.state::<OpenPanel>().0.lock().unwrap_or_else(PoisonError::into_inner).showing = false;
        return;
    };
    let app = app.clone();
    // Resolving paths touches the file system (possibly a slow volume), so it
    // stays off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let opened = chosen(kind, open_files::accepted_paths(paths));
        {
            let state = app.state::<OpenPanel>();
            let mut state = state.0.lock().unwrap_or_else(PoisonError::into_inner);
            state.showing = false;
            if let Some(directory) = chosen_in(&opened) {
                state.last_directory = Some(directory);
            }
        }
        open_files::deliver(&app, opened);
    });
}

#[tauri::command]
pub fn pick_and_open(app: AppHandle, kind: PickKind) -> Result<(), String> {
    pick(&app, kind)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{finished, PickKind};
    use crate::open_files::macos::{ns_string, rust_string};
    use crate::open_files::MAIN_WINDOW;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager};

    /// NSModalResponseOK: the user pressed Open.
    const RESPONSE_OK: isize = 1;

    fn directory_url(path: &std::path::Path) -> Option<Retained<AnyObject>> {
        let path = ns_string(path.to_str()?)?;
        unsafe { msg_send![class!(NSURL), fileURLWithPath: &*path, isDirectory: true] }
    }

    /// The file system paths of the panel's chosen URLs.
    fn chosen_paths(panel: &AnyObject) -> Vec<PathBuf> {
        let urls: Option<Retained<AnyObject>> = unsafe { msg_send![panel, URLs] };
        let Some(urls) = urls else {
            return Vec::new();
        };
        let count: usize = unsafe { msg_send![&*urls, count] };
        (0..count)
            .filter_map(|index| {
                let url: Option<Retained<AnyObject>> = unsafe { msg_send![&*urls, objectAtIndex: index] };
                let url = url?;
                let file: Bool = unsafe { msg_send![&*url, isFileURL] };
                if !file.as_bool() {
                    return None;
                }
                let path: Option<Retained<AnyObject>> = unsafe { msg_send![&*url, path] };
                path.as_deref().and_then(rust_string).map(PathBuf::from)
            })
            .collect()
    }

    /// The main window's NSWindow when it can take a sheet: visible and not
    /// already showing one.
    fn sheet_window(app: &AppHandle) -> Option<*mut AnyObject> {
        let window = app.get_webview_window(MAIN_WINDOW)?;
        let pointer = window.ns_window().ok()?.cast::<AnyObject>();
        if pointer.is_null() {
            return None;
        }
        let native = unsafe { &*pointer };
        let visible: Bool = unsafe { msg_send![native, isVisible] };
        let sheet: Option<Retained<AnyObject>> = unsafe { msg_send![native, attachedSheet] };
        (visible.as_bool() && sheet.is_none()).then_some(pointer)
    }

    /// Runs on the main thread.
    pub fn show(app: AppHandle, kind: PickKind, start: Option<PathBuf>) {
        autoreleasepool(|_| {
            let panel: Retained<AnyObject> = unsafe { msg_send![class!(NSOpenPanel), openPanel] };
            let folder = kind == PickKind::Folder;
            unsafe {
                let _: () = msg_send![&*panel, setCanChooseFiles: !folder];
                let _: () = msg_send![&*panel, setCanChooseDirectories: folder];
                let _: () = msg_send![&*panel, setAllowsMultipleSelection: !folder];
                let _: () = msg_send![&*panel, setCanCreateDirectories: folder];
                let _: () = msg_send![&*panel, setResolvesAliases: true];
            }
            if let Some(prompt) = ns_string("Open") {
                let _: () = unsafe { msg_send![&*panel, setPrompt: &*prompt] };
            }
            if let Some(url) = start.as_deref().and_then(directory_url) {
                let _: () = unsafe { msg_send![&*panel, setDirectoryURL: &*url] };
            }
            let source = panel.clone();
            let handle = app.clone();
            // The block keeps the panel alive until it answers; AppKit drops
            // the block once it has run, which releases the panel.
            let handler = block2::RcBlock::new(move |response: isize| {
                let paths = (response == RESPONSE_OK).then(|| chosen_paths(&source));
                finished(&handle, kind, paths);
            });
            match sheet_window(&app) {
                Some(window) => {
                    let window = unsafe { &*window };
                    let _: () = unsafe { msg_send![&*panel, beginSheetModalForWindow: window, completionHandler: &*handler] };
                }
                None => {
                    let _: () = unsafe { msg_send![&*panel, beginWithCompletionHandler: &*handler] };
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("pzza-open-panel-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn opened(files: &[&str], folders: &[&str]) -> Opened {
        Opened {
            files: files.iter().map(|path| path.to_string()).collect(),
            folders: folders.iter().map(|path| path.to_string()).collect(),
        }
    }

    #[test]
    fn starts_in_the_last_folder_while_it_exists_else_home() {
        let last = temp_dir("last");
        let home = temp_dir("home");
        assert_eq!(start_directory(Some(&last), Some(home.clone())), Some(last.clone()));
        assert_eq!(start_directory(None, Some(home.clone())), Some(home.clone()));
        std::fs::remove_dir_all(&last).unwrap();
        assert_eq!(start_directory(Some(&last), Some(home.clone())), Some(home.clone()));
        std::fs::remove_dir_all(&home).unwrap();
        assert_eq!(start_directory(Some(&last), Some(home)), None);
    }

    #[test]
    fn keeps_only_what_the_panel_asked_for() {
        let mixed = opened(&["/a.ts", "/b.ts"], &["/Tools.app", "/code"]);
        assert_eq!(chosen(PickKind::File, mixed.clone()), opened(&["/a.ts", "/b.ts"], &[]));
        assert_eq!(chosen(PickKind::Folder, mixed), opened(&[], &["/Tools.app"]));
        assert!(chosen(PickKind::Folder, opened(&["/a.ts"], &[])).is_empty());
    }

    #[test]
    fn remembers_the_folder_a_choice_was_made_in() {
        assert_eq!(chosen_in(&opened(&["/code/api/a.ts", "/x/b.ts"], &[])), Some(PathBuf::from("/code/api")));
        assert_eq!(chosen_in(&opened(&[], &["/code/api"])), Some(PathBuf::from("/code")));
        assert_eq!(chosen_in(&opened(&[], &[])), None);
    }

    #[test]
    fn one_panel_at_a_time() {
        let mut state = PanelState::default();
        assert!(state.begin());
        assert!(!state.begin());
        state.showing = false;
        assert!(state.begin());
    }

    #[test]
    fn kinds_come_from_the_page_as_lowercase_words() {
        assert_eq!(serde_json::from_str::<PickKind>("\"file\"").unwrap(), PickKind::File);
        assert_eq!(serde_json::from_str::<PickKind>("\"folder\"").unwrap(), PickKind::Folder);
        assert!(serde_json::from_str::<PickKind>("\"anything\"").is_err());
    }
}
