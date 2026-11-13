//! Files and folders opened "with PzzaCode" (Finder's Open With, double-click
//! once PzzaCode is the default, or the File menu's Open File… and Open
//! Folder… pickers in open_panel.rs) and the one-click "make PzzaCode the
//! default editor" setup.
//!
//! Delivery contract with the frontend: every accepted path reaches it exactly
//! once. Paths that arrive before the page is listening wait in a queue; the
//! page registers its `open-files` and `open-folders` listeners first and then
//! drains the queue with `take_opened_files`, after which new arrivals are
//! emitted as events.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use tauri::{AppHandle, Emitter, Manager, Url};

pub const OPEN_FILES_EVENT: &str = "open-files";
pub const OPEN_FOLDERS_EVENT: &str = "open-folders";
pub(crate) const MAIN_WINDOW: &str = "main";
/// Upper bound on paths accepted from one open request.
const MAX_PATHS_PER_EVENT: usize = 64;
/// Upper bound on a path's length in bytes, before and after resolving it.
const MAX_PATH_LEN: usize = 4096;
/// Upper bound on paths held while the page is not listening.
const MAX_PENDING: usize = 256;

#[derive(Default)]
pub struct OpenedFiles(Mutex<Inbox>);

/// Canonical paths to open: regular files become file tiles, directories
/// folder tiles.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Opened {
    pub files: Vec<String>,
    pub folders: Vec<String>,
}

impl Opened {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.folders.is_empty()
    }

    fn len(&self) -> usize {
        self.files.len() + self.folders.len()
    }

    fn contains(&self, path: &str) -> bool {
        self.files.iter().chain(&self.folders).any(|entry| entry == path)
    }
}

#[derive(Default)]
struct Inbox {
    /// True once the current page has drained the queue; from then on new
    /// arrivals go out as events instead.
    listening: bool,
    pending: Opened,
}

impl Inbox {
    /// Queues `opened` while the page is not listening, or hands it back to
    /// be emitted right away.
    fn accept(&mut self, opened: Opened) -> Option<Opened> {
        if self.listening {
            return Some(opened);
        }
        let Opened { files, folders } = opened;
        for (path, folder) in files.into_iter().map(|path| (path, false)).chain(folders.into_iter().map(|path| (path, true))) {
            if self.pending.len() >= MAX_PENDING {
                break;
            }
            if self.pending.contains(&path) {
                continue;
            }
            if folder {
                self.pending.folders.push(path);
            } else {
                self.pending.files.push(path);
            }
        }
        None
    }

    fn take(&mut self) -> Opened {
        self.listening = true;
        std::mem::take(&mut self.pending)
    }

    /// A (re)loading page has no listener yet, so queue until it drains again.
    fn stop_listening(&mut self) {
        self.listening = false;
    }
}

/// Forwards the run loop's open-document events. macOS delivers files opened
/// with the app through `application:openURLs:`, which tauri reports as
/// `RunEvent::Opened`.
pub fn handle_event(app: &AppHandle, event: &tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
        deliver(app, accepted_urls(urls));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Resets delivery when the main page starts (re)loading, so files opened
/// while it reloads wait for the new page instead of reaching no listener.
pub fn page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if webview.label() == MAIN_WINDOW && payload.event() == tauri::webview::PageLoadEvent::Started {
        let state = webview.state::<OpenedFiles>();
        state.0.lock().unwrap_or_else(PoisonError::into_inner).stop_listening();
    }
}

/// Hands accepted paths to the page: emitted when it listens, else queued.
pub(crate) fn deliver(app: &AppHandle, opened: Opened) {
    if opened.is_empty() {
        return;
    }
    let ready = app
        .state::<OpenedFiles>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .accept(opened);
    if let Some(Opened { files, folders }) = ready {
        for (event, paths) in [(OPEN_FILES_EVENT, files), (OPEN_FOLDERS_EVENT, folders)] {
            if paths.is_empty() {
                continue;
            }
            if let Err(error) = app.emit_to(MAIN_WINDOW, event, paths) {
                eprintln!("PzzaCode could not deliver opened paths: {error}");
            }
        }
    }
    bring_forward(app);
}

fn bring_forward(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    for result in [window.unminimize(), window.show(), window.set_focus()] {
        if let Err(error) = result {
            eprintln!("PzzaCode could not bring its window forward: {error}");
        }
    }
}

#[tauri::command]
pub fn take_opened_files(state: tauri::State<'_, OpenedFiles>) -> Opened {
    state.0.lock().unwrap_or_else(PoisonError::into_inner).take()
}

/// The local `file:` URLs among `urls`, accepted as `accepted_paths` does.
fn accepted_urls(urls: &[Url]) -> Opened {
    accepted_paths(
        urls.iter()
            .filter(|url| url.scheme() == "file")
            .filter_map(|url| url.to_file_path().ok()),
    )
}

/// Keeps only local regular files and directories, as canonical UTF-8 paths,
/// without duplicates and at most `MAX_PATHS_PER_EVENT` of them.
pub(crate) fn accepted_paths(paths: impl IntoIterator<Item = PathBuf>) -> Opened {
    let mut opened = Opened::default();
    for path in paths {
        if opened.len() >= MAX_PATHS_PER_EVENT {
            break;
        }
        let Some((path, folder)) = canonical_entry(&path) else {
            continue;
        };
        if opened.contains(&path) {
            continue;
        }
        if folder {
            opened.folders.push(path);
        } else {
            opened.files.push(path);
        }
    }
    opened
}

/// The canonical path behind `path` and whether it is a directory; `None`
/// for anything but an existing regular file or directory.
fn canonical_entry(path: &Path) -> Option<(String, bool)> {
    if path.as_os_str().len() > MAX_PATH_LEN || !path.is_absolute() {
        return None;
    }
    let resolved: PathBuf = std::fs::canonicalize(path).ok()?;
    if resolved.as_os_str().len() > MAX_PATH_LEN {
        return None;
    }
    // canonicalize resolved every link, so this is the target's own type.
    let metadata = std::fs::metadata(&resolved).ok()?;
    if !metadata.is_file() && !metadata.is_dir() {
        return None;
    }
    let folder = metadata.is_dir();
    resolved.into_os_string().into_string().ok().map(|path| (path, folder))
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultEditorStatus {
    /// Whether this copy can make itself the default editor.
    supported: bool,
    /// True when PzzaCode opens every type it declares.
    is_default: bool,
    total: u32,
    owned: u32,
    /// Every eligible type, so the user can pick which ones to take over.
    types: Vec<DefaultEditorType>,
}

/// One content type PzzaCode can become the default for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultEditorType {
    /// The type identifier (UTI); `set_default_editor` takes these back.
    id: String,
    label: String,
    /// Declared extensions without their dot, sorted.
    extensions: Vec<String>,
    owned: bool,
}

/// Upper bound on type identifiers accepted from one request.
const MAX_REQUESTED_TYPES: usize = 512;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultEditorUpdate {
    /// Types PzzaCode became the default for in this call.
    updated: u32,
    /// One readable entry per type macOS refused or did not answer in time.
    failed: Vec<String>,
}

#[tauri::command]
pub async fn default_editor_status() -> Result<DefaultEditorStatus, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(macos::status)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(DefaultEditorStatus::default())
    }
}

/// Makes PzzaCode the default for `types` (type identifiers from
/// `default_editor_status`), or for every eligible type when omitted.
#[tauri::command]
pub async fn set_default_editor(app: AppHandle, types: Option<Vec<String>>) -> Result<DefaultEditorUpdate, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || macos::make_default(&app, types.as_deref()))
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, types);
        Err("Setting the default editor is only available on macOS".into())
    }
}

/// One `CFBundleDocumentTypes` entry of the running app's Info.plist.
#[derive(Debug, Default, Clone, PartialEq)]
struct DocumentType {
    extensions: Vec<String>,
    content_types: Vec<String>,
}

/// Every extension and content type the app declares, normalized and
/// without duplicates, in declaration order.
#[derive(Debug, Default, PartialEq)]
struct Declared {
    extensions: Vec<String>,
    content_types: Vec<String>,
}

fn declared(types: &[DocumentType]) -> Declared {
    let mut result = Declared::default();
    for entry in types {
        for extension in entry.extensions.iter().filter_map(|value| normalize_extension(value)) {
            if !result.extensions.contains(&extension) {
                result.extensions.push(extension);
            }
        }
        for content_type in entry.content_types.iter().filter_map(|value| normalize_identifier(value)) {
            if !result.content_types.contains(&content_type) {
                result.content_types.push(content_type);
            }
        }
    }
    result
}

/// Lowercase extension without its dot; `None` for wildcards and anything
/// that is not a plain extension.
fn normalize_extension(value: &str) -> Option<String> {
    let extension = value.trim().trim_start_matches('.').to_ascii_lowercase();
    let plain = !extension.is_empty()
        && extension.len() <= 64
        && extension.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '.'));
    plain.then_some(extension)
}

fn normalize_identifier(value: &str) -> Option<String> {
    let identifier = value.trim();
    let valid = !identifier.is_empty()
        && identifier.len() <= 255
        && identifier.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    valid.then(|| identifier.to_string())
}

/// A content type PzzaCode can become the default for, with the declared
/// extensions that led to it (several extensions can share one type; a type
/// declared by identifier alone has none).
#[derive(Debug, Clone, PartialEq)]
struct Target {
    identifier: String,
    /// Sorted, without dots or duplicates.
    extensions: Vec<String>,
}

impl Target {
    fn label(&self) -> String {
        type_label(&self.identifier, &self.extensions)
    }
}

/// Merges (type identifier, declared extension) pairs into one target per
/// type, in first-seen order. `None` is a type declared by identifier.
fn group_targets(resolved: impl IntoIterator<Item = (String, Option<String>)>) -> Vec<Target> {
    let mut targets: Vec<Target> = Vec::new();
    for (identifier, extension) in resolved {
        let index = match targets.iter().position(|target| target.identifier == identifier) {
            Some(index) => index,
            None => {
                targets.push(Target { identifier, extensions: Vec::new() });
                targets.len() - 1
            }
        };
        if let Some(extension) = extension {
            let extensions = &mut targets[index].extensions;
            if let Err(position) = extensions.binary_search(&extension) {
                extensions.insert(position, extension);
            }
        }
    }
    targets
}

/// Short names for the system types the declared extensions resolve to.
fn identifier_name(identifier: &str) -> Option<&'static str> {
    Some(match identifier {
        "public.plain-text" | "public.text" | "public.utf8-plain-text" => "Plain text",
        "public.json" => "JSON",
        "public.xml" => "XML",
        "public.yaml" => "YAML",
        "public.css" => "CSS",
        "net.daringfireball.markdown" => "Markdown",
        "public.comma-separated-values-text" => "CSV",
        "public.tab-separated-values-text" => "TSV",
        "com.apple.log" => "Log",
        "public.patch-file" => "Patch",
        "public.c-source" => "C",
        "public.c-header" => "C header",
        "public.c-plus-plus-source" => "C++",
        "public.c-plus-plus-header" => "C++ header",
        "public.objective-c-source" => "Objective-C",
        "public.objective-c-plus-plus-source" => "Objective-C++",
        "com.netscape.javascript-source" => "JavaScript",
        "public.python-script" => "Python",
        "public.ruby-script" => "Ruby",
        "public.perl-script" => "Perl",
        "public.php-script" => "PHP",
        "public.shell-script" => "Shell script",
        "public.bash-script" => "Bash",
        "public.zsh-script" => "Zsh",
        "public.csh-script" => "C shell",
        "public.ksh-script" => "Korn shell",
        "public.swift-source" => "Swift",
        "com.sun.java-source" => "Java",
        "public.assembly-source" => "Assembly",
        _ => return None,
    })
}

/// Short names for declared extensions, used for types macOS has no entry
/// for (dynamic types cover one extension each).
fn extension_name(extension: &str) -> Option<&'static str> {
    Some(match extension {
        "txt" => "Plain text",
        "ts" | "mts" | "cts" => "TypeScript",
        "tsx" => "TypeScript JSX",
        "js" | "mjs" | "cjs" => "JavaScript",
        "jsx" => "JavaScript JSX",
        "py" | "pyi" | "pyw" => "Python",
        "rb" => "Ruby",
        "go" => "Go",
        "rs" => "Rust",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "swift" => "Swift",
        "c" => "C",
        "h" => "C header",
        "cc" | "cpp" | "cxx" => "C++",
        "hh" | "hpp" | "hxx" => "C++ header",
        "m" => "Objective-C",
        "mm" => "Objective-C++",
        "cs" => "C#",
        "php" => "PHP",
        "sh" => "Shell script",
        "bash" => "Bash",
        "zsh" => "Zsh",
        "fish" => "Fish",
        "lua" => "Lua",
        "dart" => "Dart",
        "scala" => "Scala",
        "ex" | "exs" => "Elixir",
        "erl" | "hrl" => "Erlang",
        "hs" => "Haskell",
        "clj" | "cljs" => "Clojure",
        "r" => "R",
        "pl" | "pm" => "Perl",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "astro" => "Astro",
        "sql" => "SQL",
        "graphql" | "gql" => "GraphQL",
        "gradle" => "Gradle",
        "groovy" => "Groovy",
        "zig" => "Zig",
        "jl" => "Julia",
        "tf" => "Terraform",
        "proto" => "Protocol Buffers",
        "css" => "CSS",
        "scss" => "SCSS",
        "sass" => "Sass",
        "less" => "Less",
        "md" | "markdown" => "Markdown",
        "mdx" => "MDX",
        "rst" => "reStructuredText",
        "adoc" => "AsciiDoc",
        "json" => "JSON",
        "jsonc" => "JSON with comments",
        "json5" => "JSON5",
        "xml" => "XML",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "ini" => "INI",
        "cfg" | "conf" => "Config",
        "env" => "Environment",
        "properties" => "Properties",
        "lock" => "Lockfile",
        "log" => "Log",
        "csv" => "CSV",
        "tsv" => "TSV",
        "diff" | "patch" => "Patch",
        _ => return None,
    })
}

/// A short human name for a type: the system type's own name, else the name
/// every one of its extensions shares, else its extensions (or identifier).
fn type_label(identifier: &str, extensions: &[String]) -> String {
    if let Some(name) = identifier_name(identifier) {
        return name.to_string();
    }
    let mut names = extensions.iter().map(|extension| extension_name(extension));
    if let Some(Some(first)) = names.next() {
        if names.all(|name| name == Some(first)) {
            return first.to_string();
        }
    }
    if extensions.is_empty() {
        return identifier.to_string();
    }
    extensions.iter().map(|extension| format!(".{extension}")).collect::<Vec<_>>().join(", ")
}

/// The status the frontend shows for `targets`, each with whether PzzaCode
/// already opens it. Types are listed by label.
fn status_for(supported: bool, targets: &[(Target, bool)]) -> DefaultEditorStatus {
    let mut types: Vec<DefaultEditorType> = targets
        .iter()
        .map(|(target, owned)| DefaultEditorType {
            id: target.identifier.clone(),
            label: target.label(),
            extensions: target.extensions.clone(),
            owned: *owned,
        })
        .collect();
    types.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    let total = u32::try_from(types.len()).unwrap_or(u32::MAX);
    let owned = u32::try_from(types.iter().filter(|ty| ty.owned).count()).unwrap_or(u32::MAX);
    DefaultEditorStatus { supported, is_default: supported && owned == total, total, owned, types }
}

/// The eligible targets a request names, in their original order; `None`
/// names them all. Anything that is not one of `targets` rejects the whole
/// request, so only eligible types ever reach the system.
fn select_targets<T: Clone>(targets: &[(Target, T)], requested: Option<&[String]>) -> Result<Vec<(Target, T)>, String> {
    let Some(requested) = requested else {
        return Ok(targets.to_vec());
    };
    if requested.is_empty() {
        return Err("Choose at least one file type".into());
    }
    if requested.len() > MAX_REQUESTED_TYPES {
        return Err("Too many file types in one request".into());
    }
    for identifier in requested {
        if !targets.iter().any(|(target, _)| &target.identifier == identifier) {
            // Only echo something that looks like a type identifier.
            return Err(match normalize_identifier(identifier) {
                Some(valid) if valid == *identifier => format!("{identifier} is not a file type PzzaCode can open by default"),
                _ => "An invalid file type was requested".into(),
            });
        }
    }
    Ok(targets.iter().filter(|(target, _)| requested.contains(&target.identifier)).cloned().collect())
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use super::{
        declared, group_targets, select_targets, status_for, DefaultEditorStatus, DefaultEditorUpdate, DocumentType,
        Target,
    };
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{class, msg_send, sel};
    use std::ffi::{CStr, CString};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use tauri::AppHandle;

    // UTType lives in UniformTypeIdentifiers (macOS 11+).
    #[link(name = "UniformTypeIdentifiers", kind = "framework")]
    extern "C" {}

    /// macOS asks the user before some changes, so allow time for an answer.
    const SET_DEADLINE: Duration = Duration::from_secs(120);

    static SETTING: AtomicBool = AtomicBool::new(false);

    /// Clears `SETTING` however the request ends.
    struct SettingGuard;

    impl Drop for SettingGuard {
        fn drop(&mut self) {
            SETTING.store(false, Ordering::SeqCst);
        }
    }

    pub(crate) fn ns_string(value: &str) -> Option<Retained<AnyObject>> {
        let value = CString::new(value).ok()?;
        unsafe { msg_send![class!(NSString), stringWithUTF8String: value.as_ptr()] }
    }

    pub(crate) fn rust_string(value: &AnyObject) -> Option<String> {
        let text: *const std::ffi::c_char = unsafe { msg_send![value, UTF8String] };
        if text.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(text) }.to_str().ok().map(str::to_string)
    }

    fn is_kind(value: &AnyObject, class: &AnyClass) -> bool {
        let kind: Bool = unsafe { msg_send![value, isKindOfClass: class] };
        kind.as_bool()
    }

    fn main_bundle() -> Retained<AnyObject> {
        unsafe { msg_send![class!(NSBundle), mainBundle] }
    }

    fn bundle_identifier(bundle: &AnyObject) -> Option<String> {
        let identifier: Option<Retained<AnyObject>> = unsafe { msg_send![bundle, bundleIdentifier] };
        identifier.as_deref().and_then(rust_string)
    }

    /// The running .app bundle's URL. A development build runs a bare binary
    /// whose Info.plist declares no document types and that LaunchServices
    /// could not launch as a document handler, so it has none.
    fn app_bundle_url(bundle: &AnyObject) -> Option<Retained<AnyObject>> {
        let url: Option<Retained<AnyObject>> = unsafe { msg_send![bundle, bundleURL] };
        let url = url?;
        let path: Option<Retained<AnyObject>> = unsafe { msg_send![&*url, path] };
        let path = path.as_deref().and_then(rust_string)?;
        path.trim_end_matches('/').ends_with(".app").then_some(url)
    }

    /// Strings of `key` in `dictionary` when it holds an array, else nothing.
    fn string_array(dictionary: &AnyObject, key: &str) -> Vec<String> {
        let Some(key) = ns_string(key) else {
            return Vec::new();
        };
        let value: Option<Retained<AnyObject>> = unsafe { msg_send![dictionary, objectForKey: &*key] };
        let Some(value) = value.filter(|value| is_kind(value, class!(NSArray))) else {
            return Vec::new();
        };
        let count: usize = unsafe { msg_send![&*value, count] };
        (0..count)
            .filter_map(|index| {
                let item: Option<Retained<AnyObject>> = unsafe { msg_send![&*value, objectAtIndex: index] };
                item.filter(|item| is_kind(item, class!(NSString)))
                    .as_deref()
                    .and_then(rust_string)
            })
            .collect()
    }

    /// `CFBundleDocumentTypes` from the running app's own Info.plist, which the
    /// bundler writes from tauri.conf.json's fileAssociations.
    fn document_types(bundle: &AnyObject) -> Vec<DocumentType> {
        let Some(key) = ns_string("CFBundleDocumentTypes") else {
            return Vec::new();
        };
        let types: Option<Retained<AnyObject>> =
            unsafe { msg_send![bundle, objectForInfoDictionaryKey: &*key] };
        let Some(types) = types.filter(|types| is_kind(types, class!(NSArray))) else {
            return Vec::new();
        };
        let count: usize = unsafe { msg_send![&*types, count] };
        (0..count)
            .filter_map(|index| {
                let entry: Option<Retained<AnyObject>> = unsafe { msg_send![&*types, objectAtIndex: index] };
                let entry = entry.filter(|entry| is_kind(entry, class!(NSDictionary)))?;
                Some(DocumentType {
                    extensions: string_array(&entry, "CFBundleTypeExtensions"),
                    content_types: string_array(&entry, "LSItemContentTypes"),
                })
            })
            .collect()
    }

    fn ut_type_class() -> Option<&'static AnyClass> {
        AnyClass::get(c"UTType")
    }

    fn ut_type(identifier: &str) -> Option<Retained<AnyObject>> {
        let class = ut_type_class()?;
        let identifier = ns_string(identifier)?;
        unsafe { msg_send![class, typeWithIdentifier: &*identifier] }
    }

    fn type_identifier(ty: &AnyObject) -> Option<String> {
        let identifier: Option<Retained<AnyObject>> = unsafe { msg_send![ty, identifier] };
        identifier.as_deref().and_then(rust_string)
    }

    /// Whether becoming the default for `ty` only affects text files. An
    /// extension's preferred type can be something else entirely (".ts" is
    /// public.mpeg-2-transport-stream, ".exs" a Logic instrument), and taking
    /// those over would hijack media files, so they stay Open With only.
    /// Dynamic types exist only because no app declares the extension, so
    /// they cover nothing but the files PzzaCode claims by extension.
    /// Web pages are text too, but macOS treats the default handler for them
    /// as the default web browser (setting it asks to change the browser), so
    /// they stay Open With only.
    fn is_text_type(ty: &AnyObject, text: &AnyObject, web: &[Retained<AnyObject>]) -> bool {
        let dynamic: Bool = unsafe { msg_send![ty, isDynamic] };
        let conforms: Bool = unsafe { msg_send![ty, conformsToType: text] };
        let browser = web.iter().any(|page| {
            let page: Bool = unsafe { msg_send![ty, conformsToType: &**page] };
            page.as_bool()
        });
        (dynamic.as_bool() || conforms.as_bool()) && !browser
    }

    /// The content types to own: declared types, plus the type macOS assigns
    /// to files with each declared extension.
    fn targets(bundle: &AnyObject) -> Vec<Target> {
        let Some(class) = ut_type_class() else {
            return Vec::new();
        };
        let Some(text) = ut_type("public.text") else {
            return Vec::new();
        };
        let web: Vec<Retained<AnyObject>> = ["public.html", "public.xhtml"].into_iter().filter_map(ut_type).collect();
        let declared = declared(&document_types(bundle));
        let mut resolved = Vec::new();
        for identifier in &declared.content_types {
            if let Some(ty) = ut_type(identifier).filter(|ty| is_text_type(ty, &text, &web)) {
                if let Some(identifier) = type_identifier(&ty) {
                    resolved.push((identifier, None));
                }
            }
        }
        for extension in &declared.extensions {
            let Some(tag) = ns_string(extension) else {
                continue;
            };
            // Same as UTTypeCreatePreferredIdentifierForTag: the type Finder
            // gives a file with this extension.
            let ty: Option<Retained<AnyObject>> = unsafe { msg_send![class, typeWithFilenameExtension: &*tag] };
            if let Some(ty) = ty.filter(|ty| is_text_type(ty, &text, &web)) {
                if let Some(identifier) = type_identifier(&ty) {
                    resolved.push((identifier, Some(extension.clone())));
                }
            }
        }
        group_targets(resolved)
    }

    fn workspace() -> Retained<AnyObject> {
        unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] }
    }

    /// The content type APIs arrived in macOS 12; on 11, Open With still
    /// works but the one-click setup is not offered.
    fn workspace_supports(workspace: &AnyObject) -> bool {
        let query: Bool =
            unsafe { msg_send![workspace, respondsToSelector: sel!(URLForApplicationToOpenContentType:)] };
        let set: Bool = unsafe {
            msg_send![
                workspace,
                respondsToSelector: sel!(setDefaultApplicationAtURL:toOpenContentType:completionHandler:)
            ]
        };
        query.as_bool() && set.as_bool()
    }

    fn default_app_identifier(workspace: &AnyObject, identifier: &str) -> Option<String> {
        let ty = ut_type(identifier)?;
        let app: Option<Retained<AnyObject>> =
            unsafe { msg_send![workspace, URLForApplicationToOpenContentType: &*ty] };
        let app = app?;
        let bundle: Option<Retained<AnyObject>> = unsafe { msg_send![class!(NSBundle), bundleWithURL: &*app] };
        bundle.as_deref().and_then(bundle_identifier)
    }

    struct Survey {
        supported: bool,
        own_identifier: String,
        /// Each target with whether PzzaCode already opens it.
        targets: Vec<(Target, bool)>,
    }

    fn survey() -> Survey {
        autoreleasepool(|_| {
            let bundle = main_bundle();
            let workspace = workspace();
            let own_identifier = bundle_identifier(&bundle).unwrap_or_default();
            let usable = !own_identifier.is_empty()
                && app_bundle_url(&bundle).is_some()
                && workspace_supports(&workspace);
            if !usable {
                return Survey { supported: false, own_identifier, targets: Vec::new() };
            }
            let targets: Vec<(Target, bool)> = targets(&bundle)
                .into_iter()
                .map(|target| {
                    let owned = default_app_identifier(&workspace, &target.identifier)
                        .is_some_and(|app| app == own_identifier);
                    (target, owned)
                })
                .collect();
            Survey { supported: !targets.is_empty(), own_identifier, targets }
        })
    }

    pub fn status() -> DefaultEditorStatus {
        let survey = survey();
        status_for(survey.supported, &survey.targets)
    }

    fn describe_error(error: &AnyObject) -> String {
        let code: isize = unsafe { msg_send![error, code] };
        let description: Option<Retained<AnyObject>> = unsafe { msg_send![error, localizedDescription] };
        let description = description.as_deref().and_then(rust_string).unwrap_or_else(|| "macOS refused".into());
        format!("{description} ({code})")
    }

    pub fn make_default(app: &AppHandle, requested: Option<&[String]>) -> Result<DefaultEditorUpdate, String> {
        if SETTING.swap(true, Ordering::SeqCst) {
            return Err("PzzaCode is already becoming the default editor".into());
        }
        let _guard = SettingGuard;
        let survey = survey();
        if !survey.supported {
            return Err("PzzaCode can only become the default editor from its installed app on macOS 12 or later".into());
        }
        let pending: Vec<Target> = select_targets(&survey.targets, requested)?
            .into_iter()
            .filter_map(|(target, owned)| (!owned).then_some(target))
            .collect();
        if pending.is_empty() {
            return Ok(DefaultEditorUpdate { updated: 0, failed: Vec::new() });
        }
        let identifiers: Vec<String> = pending.iter().map(|target| target.identifier.clone()).collect();
        let (sender, receiver) = mpsc::channel::<(usize, Result<(), String>)>();
        let own_identifier = survey.own_identifier;
        // NSWorkspace answers each change asynchronously (after asking the user
        // when a type needs consent); every request goes out at once so the
        // whole setup is one action instead of one wait per type.
        app.run_on_main_thread(move || {
            autoreleasepool(|_| issue_requests(&identifiers, &own_identifier, &sender));
        })
        .map_err(|error| error.to_string())?;

        let deadline = Instant::now() + SET_DEADLINE;
        let mut results: Vec<Option<Result<(), String>>> = pending.iter().map(|_| None).collect();
        let mut answered = 0;
        while answered < results.len() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining) {
                Ok((index, result)) => {
                    if let Some(slot) = results.get_mut(index).filter(|slot| slot.is_none()) {
                        *slot = Some(result);
                        answered += 1;
                    }
                }
                // Timed out, or every request has answered or been dropped.
                Err(_) => break,
            }
        }

        let mut update = DefaultEditorUpdate { updated: 0, failed: Vec::new() };
        for (target, result) in pending.iter().zip(results) {
            match result {
                Some(Ok(())) => update.updated += 1,
                Some(Err(reason)) => update.failed.push(format!("{}: {reason}", target.label())),
                None => update.failed.push(format!("{}: macOS did not answer in time", target.label())),
            }
        }
        Ok(update)
    }

    /// Runs on the main thread. Each completion handler reports its target's
    /// index through `sender`.
    fn issue_requests(identifiers: &[String], own_identifier: &str, sender: &mpsc::Sender<(usize, Result<(), String>)>) {
        let bundle = main_bundle();
        // Never point LaunchServices at anything but this running copy.
        let own = bundle_identifier(&bundle).is_some_and(|identifier| identifier == own_identifier);
        let app_url = app_bundle_url(&bundle).filter(|_| own);
        let workspace = workspace();
        for (index, identifier) in identifiers.iter().enumerate() {
            let (Some(app_url), Some(ty)) = (app_url.as_deref(), ut_type(identifier)) else {
                let _ = sender.send((index, Err("this content type is unavailable".into())));
                continue;
            };
            let reply = sender.clone();
            let handler = block2::RcBlock::new(move |error: *mut AnyObject| {
                let result = match unsafe { error.as_ref() } {
                    None => Ok(()),
                    Some(error) => Err(describe_error(error)),
                };
                let _ = reply.send((index, result));
            });
            let _: () = unsafe {
                msg_send![
                    &*workspace,
                    setDefaultApplicationAtURL: app_url,
                    toOpenContentType: &*ty,
                    completionHandler: &*handler
                ]
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("pzza-open-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn file_url(path: &Path) -> Url {
        Url::from_file_path(path).unwrap()
    }

    fn canonical(path: &Path) -> String {
        std::fs::canonicalize(path).unwrap().into_os_string().into_string().unwrap()
    }

    fn files(paths: &[&str]) -> Opened {
        Opened { files: paths.iter().map(|path| path.to_string()).collect(), folders: Vec::new() }
    }

    #[test]
    fn queues_until_the_page_drains_then_emits() {
        let mut inbox = Inbox::default();
        assert_eq!(inbox.accept(files(&["/a", "/b"])), None);
        assert_eq!(inbox.accept(files(&["/b", "/c"])), None);
        assert_eq!(inbox.take(), files(&["/a", "/b", "/c"]));
        // Drained paths are never handed out twice.
        assert!(inbox.take().is_empty());
        assert_eq!(inbox.accept(files(&["/d"])), Some(files(&["/d"])));
        assert!(inbox.take().is_empty());
    }

    #[test]
    fn queues_folders_beside_files() {
        let mut inbox = Inbox::default();
        let opened = Opened { files: vec!["/a.ts".into()], folders: vec!["/code".into(), "/a.ts".into()] };
        assert_eq!(inbox.accept(opened), None);
        assert_eq!(inbox.accept(Opened { files: Vec::new(), folders: vec!["/code".into(), "/notes".into()] }), None);
        assert_eq!(inbox.take(), Opened { files: vec!["/a.ts".into()], folders: vec!["/code".into(), "/notes".into()] });
        let listening = Opened { files: Vec::new(), folders: vec!["/later".into()] };
        assert_eq!(inbox.accept(listening.clone()), Some(listening));
    }

    #[test]
    fn a_reloading_page_queues_again() {
        let mut inbox = Inbox::default();
        inbox.take();
        inbox.stop_listening();
        assert_eq!(inbox.accept(files(&["/e"])), None);
        assert_eq!(inbox.take(), files(&["/e"]));
    }

    #[test]
    fn the_queue_is_bounded() {
        let mut inbox = Inbox::default();
        let paths: Vec<String> = (0..MAX_PENDING + 10).map(|index| format!("/f{index}")).collect();
        let half = paths.len() / 2;
        assert_eq!(inbox.accept(Opened { files: paths[..half].to_vec(), folders: paths[half..].to_vec() }), None);
        assert_eq!(inbox.take().len(), MAX_PENDING);
    }

    #[test]
    fn accepts_only_local_regular_files_and_directories() {
        let directory = temp_dir("accept");
        let file = directory.join("main.rs");
        std::fs::write(&file, "fn main() {}").unwrap();
        let urls = vec![
            file_url(&file),
            file_url(&file),
            file_url(&directory),
            file_url(&directory),
            file_url(&directory.join("missing.rs")),
            Url::parse("https://example.com/main.rs").unwrap(),
            Url::parse("pzzacode://open?file=/etc/hosts").unwrap(),
        ];
        assert_eq!(accepted_urls(&urls), Opened { files: vec![canonical(&file)], folders: vec![canonical(&directory)] });
        // Device files and other special entries are neither.
        assert!(accepted_paths([PathBuf::from("/dev/null")]).is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn resolves_links_to_their_target() {
        let directory = temp_dir("links");
        let file = directory.join("target.md");
        std::fs::write(&file, "# hi").unwrap();
        let link = directory.join("link.md");
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let folder = directory.join("folder");
        std::fs::create_dir(&folder).unwrap();
        let folder_link = directory.join("folder-link");
        std::os::unix::fs::symlink(&folder, &folder_link).unwrap();
        assert_eq!(
            accepted_urls(&[file_url(&link), file_url(&folder_link), file_url(&folder)]),
            Opened { files: vec![canonical(&file)], folders: vec![canonical(&folder)] }
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn caps_paths_per_event_and_path_length() {
        let directory = temp_dir("caps");
        let urls: Vec<Url> = (0..MAX_PATHS_PER_EVENT + 5)
            .map(|index| {
                let file = directory.join(format!("{index}.txt"));
                std::fs::write(&file, "").unwrap();
                file_url(&file)
            })
            .collect();
        assert_eq!(accepted_urls(&urls).len(), MAX_PATHS_PER_EVENT);
        let long = PathBuf::from(format!("/{}", "a".repeat(MAX_PATH_LEN)));
        assert_eq!(canonical_entry(&long), None);
        assert_eq!(canonical_entry(Path::new("relative.txt")), None);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn normalizes_declared_types() {
        let types = vec![
            DocumentType {
                extensions: vec!["txt".into(), ".MD".into(), "*".into(), "".into(), "a/b".into()],
                content_types: vec!["public.plain-text".into(), " ".into()],
            },
            DocumentType {
                extensions: vec!["md".into(), "tar.gz".into()],
                content_types: vec!["public.plain-text".into(), "public.json".into()],
            },
        ];
        assert_eq!(
            declared(&types),
            Declared {
                extensions: vec!["txt".into(), "md".into(), "tar.gz".into()],
                content_types: vec!["public.plain-text".into(), "public.json".into()],
            }
        );
    }

    fn pair(identifier: &str, extension: Option<&str>) -> (String, Option<String>) {
        (identifier.to_string(), extension.map(str::to_string))
    }

    fn target(identifier: &str, extensions: &[&str]) -> Target {
        Target { identifier: identifier.into(), extensions: extensions.iter().map(|value| value.to_string()).collect() }
    }

    #[test]
    fn groups_extensions_sharing_a_type() {
        let targets = group_targets(vec![
            pair("public.yaml", Some("yml")),
            pair("public.plain-text", None),
            pair("public.yaml", Some("yaml")),
            pair("public.yaml", Some("yml")),
            pair("public.plain-text", Some("txt")),
        ]);
        assert_eq!(targets, vec![target("public.yaml", &["yaml", "yml"]), target("public.plain-text", &["txt"])]);
    }

    #[test]
    fn labels_types_with_short_names() {
        // The system type's own name wins.
        assert_eq!(target("public.yaml", &["yaml", "yml"]).label(), "YAML");
        assert_eq!(target("public.plain-text", &[]).label(), "Plain text");
        assert_eq!(target("public.c-plus-plus-header", &["hh", "hpp", "hxx"]).label(), "C++ header");
        // Unknown and dynamic types are named after their extensions.
        assert_eq!(target("dyn.ah62d4rv4ge8003dcta", &["rs"]).label(), "Rust");
        assert_eq!(target("dyn.example", &["py", "pyi"]).label(), "Python");
        // Extensions that disagree, or have no name, list themselves.
        assert_eq!(target("dyn.example", &["go", "rs"]).label(), ".go, .rs");
        assert_eq!(target("dyn.example", &["qqq"]).label(), ".qqq");
        assert_eq!(target("com.example.custom", &[]).label(), "com.example.custom");
    }

    #[test]
    fn status_lists_every_type_by_label() {
        let targets = vec![
            (target("public.yaml", &["yaml", "yml"]), true),
            (target("dyn.rust", &["rs"]), false),
            (target("public.css", &["css"]), true),
        ];
        let status = status_for(true, &targets);
        assert_eq!((status.total, status.owned, status.is_default), (3, 2, false));
        let labels: Vec<&str> = status.types.iter().map(|ty| ty.label.as_str()).collect();
        assert_eq!(labels, vec!["CSS", "Rust", "YAML"]);
        assert_eq!(status.types[2].extensions, vec!["yaml", "yml"]);
        assert_eq!(status.types[2].id, "public.yaml");
        assert!(!status.types[1].owned);
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["isDefault"], false);
        assert_eq!(json["types"][0], serde_json::json!({ "id": "public.css", "label": "CSS", "extensions": ["css"], "owned": true }));

        let owned: Vec<(Target, bool)> = targets.into_iter().map(|(target, _)| (target, true)).collect();
        assert!(status_for(true, &owned).is_default);
        // Nothing is the default where the setup is unsupported.
        assert!(!status_for(false, &[]).is_default);
    }

    #[test]
    fn selects_only_eligible_types() {
        let targets = vec![
            (target("public.yaml", &["yaml"]), false),
            (target("public.css", &["css"]), true),
            (target("dyn.rust", &["rs"]), false),
        ];
        let ids = |selected: Vec<(Target, bool)>| selected.into_iter().map(|(target, _)| target.identifier).collect::<Vec<_>>();
        assert_eq!(ids(select_targets(&targets, None).unwrap()), vec!["public.yaml", "public.css", "dyn.rust"]);
        let requested = vec!["dyn.rust".to_string(), "public.yaml".to_string(), "dyn.rust".to_string()];
        assert_eq!(ids(select_targets(&targets, Some(&requested)).unwrap()), vec!["public.yaml", "dyn.rust"]);
    }

    #[test]
    fn rejects_unknown_or_empty_requests() {
        let targets = vec![(target("public.yaml", &["yaml"]), false)];
        let unknown = vec!["public.yaml".to_string(), "public.html".to_string()];
        assert_eq!(
            select_targets(&targets, Some(&unknown)).unwrap_err(),
            "public.html is not a file type PzzaCode can open by default"
        );
        let invalid = vec!["../../etc\npasswd".to_string()];
        assert_eq!(select_targets(&targets, Some(&invalid)).unwrap_err(), "An invalid file type was requested");
        assert_eq!(select_targets(&targets, Some(&[])).unwrap_err(), "Choose at least one file type");
        let flood = vec!["public.yaml".to_string(); MAX_REQUESTED_TYPES + 1];
        assert!(select_targets(&targets, Some(&flood)).is_err());
    }

    /// tauri.conf.json is the source of every declared type, so check the
    /// rules the bundler and LaunchServices impose on it.
    #[test]
    fn file_associations_are_open_with_only() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let associations = config["bundle"]["fileAssociations"].as_array().unwrap();
        assert!(!associations.is_empty());
        // The bundler adds LSItemContentTypes for these extensions, and macOS
        // then ignores CFBundleTypeExtensions in the same entry, so they must
        // not share an entry with extensions it has no type for.
        let inferred = ["txt", "rtf", "html", "htm", "json", "xml"];
        let mut seen = Vec::new();
        for association in associations {
            assert_eq!(association["role"], "Editor");
            // Listed under Open With, never taking a default on install.
            assert_eq!(association["rank"], "Alternate");
            assert!(association.get("contentTypes").is_none());
            assert!(association.get("mimeType").is_none());
            assert!(association.get("exportedType").is_none());
            let extensions: Vec<&str> = association["ext"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            let typed = extensions.iter().filter(|extension| inferred.contains(extension)).count();
            assert!(typed == 0 || typed == extensions.len(), "{extensions:?}");
            for extension in extensions {
                assert_eq!(normalize_extension(extension).as_deref(), Some(extension));
                assert!(!seen.contains(&extension), "{extension} is declared twice");
                seen.push(extension);
            }
        }
    }
}
