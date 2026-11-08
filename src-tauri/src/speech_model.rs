use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

// Whisper large-v3 (not turbo): on recordings of real speakers it made half
// the Turkish and a third of the English dictation errors of large-v3-turbo,
// with the final text as quick; turbo also invented sentences in pauses.
const MODEL_NAME: &str = "ggml-large-v3-q5_0.bin";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-q5_0.bin";
const MODEL_BYTES: u64 = 1_081_140_203;
const MODEL_SHA256: &str = "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1";
// Models this one replaced, removed once it is installed.
const REPLACED_MODELS: [&str; 1] = ["ggml-large-v3-turbo-q5_0.bin"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    installed: bool,
    downloading: bool,
    downloaded_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

impl Default for ModelStatus {
    fn default() -> Self {
        Self {
            installed: false,
            downloading: false,
            downloaded_bytes: 0,
            total_bytes: MODEL_BYTES,
            error: None,
        }
    }
}

#[derive(Default)]
pub struct SpeechModelState(Mutex<ModelStatus>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent<'a> {
    status: &'a str,
    downloaded_bytes: u64,
    total_bytes: u64,
    error: Option<&'a str>,
}

fn destination(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("speech")
        .join(MODEL_NAME))
}

pub fn is_installed(app: &AppHandle) -> Result<bool, String> {
    match fs::symlink_metadata(destination(app)?) {
        Ok(meta) => Ok(meta.is_file() && meta.len() == MODEL_BYTES),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Cannot inspect speech model: {e}")),
    }
}

pub fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    if !is_installed(app)? {
        return Err("Download the speech model in Settings first.".into());
    }
    destination(app)
}

#[tauri::command]
pub fn speech_model_status(
    app: AppHandle,
    state: State<'_, SpeechModelState>,
) -> Result<ModelStatus, String> {
    let mut status = state
        .0
        .lock()
        .map_err(|_| "Speech model state is unavailable")?;
    status.installed = is_installed(&app)?;
    if status.installed {
        status.downloaded_bytes = MODEL_BYTES;
    }
    Ok(status.clone())
}

fn publish(app: &AppHandle, phase: &str, bytes: u64, error: Option<String>) {
    if let Ok(mut state) = app.state::<SpeechModelState>().0.lock() {
        state.downloading = phase == "downloading";
        state.installed = phase == "ready";
        state.downloaded_bytes = bytes;
        state.error = error.clone();
    }
    let _ = app.emit(
        "dictation-download",
        DownloadEvent {
            status: phase,
            downloaded_bytes: bytes,
            total_bytes: MODEL_BYTES,
            error: error.as_deref(),
        },
    );
}

#[tauri::command]
pub async fn speech_model_download(
    app: AppHandle,
    state: State<'_, SpeechModelState>,
    force: bool,
) -> Result<(), String> {
    {
        let mut status = state
            .0
            .lock()
            .map_err(|_| "Speech model state is unavailable")?;
        if status.downloading {
            return Ok(());
        }
        if !force && is_installed(&app)? {
            drop(status);
            publish(&app, "ready", MODEL_BYTES, None);
            return Ok(());
        }
        status.downloading = true;
        status.error = None;
        status.downloaded_bytes = 0;
    }
    publish(&app, "downloading", 0, None);
    // The worker outlives a closed settings panel; events and status share one state.
    tauri::async_runtime::spawn_blocking(move || match download(&app) {
        Ok(()) => publish(&app, "ready", MODEL_BYTES, None),
        Err(error) => publish(&app, "error", 0, Some(error)),
    });
    Ok(())
}

/// A download pinned to one immutable file: a commit-specific URL, its exact
/// size and SHA-256. Nothing else is ever installed under its name.
pub(crate) struct PinnedFile {
    pub label: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

const SPEECH_MODEL: PinnedFile = PinnedFile { label: "Speech model", url: MODEL_URL, bytes: MODEL_BYTES, sha256: MODEL_SHA256 };

fn download(app: &AppHandle) -> Result<(), String> {
    let mut last_event = Instant::now();
    download_pinned(&SPEECH_MODEL, &destination(app)?, |bytes| {
        if last_event.elapsed() >= Duration::from_millis(150) {
            publish(app, "downloading", bytes, None);
            last_event = Instant::now();
        }
    })?;
    let path = destination(app)?;
    if let Some(directory) = path.parent() {
        for name in REPLACED_MODELS {
            let _ = fs::remove_file(directory.join(name));
        }
    }
    Ok(())
}

fn validate_download(file: &PinnedFile, bytes: u64, digest: &str) -> Result<(), String> {
    if bytes != file.bytes {
        return Err(format!("{} download has an unexpected size. Please retry.", file.label));
    }
    if digest != file.sha256 {
        return Err(format!("{} checksum verification failed. Please retry.", file.label));
    }
    Ok(())
}

fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Downloads a pinned file next to its destination and installs it with an
/// atomic rename only after the size and checksum match. An interrupted
/// transfer keeps its partial file and resumes with a range request; a
/// partial file that fails verification is deleted.
pub(crate) fn download_pinned(file: &PinnedFile, path: &Path, mut progress: impl FnMut(u64)) -> Result<(), String> {
    let label = file.label;
    let directory = path.parent().ok_or(format!("{label} directory is unavailable"))?;
    fs::create_dir_all(directory).map_err(|e| format!("Cannot create the {label} directory: {e}"))?;
    let partial = partial_path(path);
    // Resume only a regular file (never a symlink) that is still incomplete.
    let mut existing = match fs::symlink_metadata(&partial) {
        Ok(meta) if meta.is_file() && meta.len() < file.bytes => meta.len(),
        Ok(_) => {
            fs::remove_file(&partial).map_err(|e| format!("Cannot clear an interrupted {label} download: {e}"))?;
            0
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(format!("Cannot inspect an interrupted {label} download: {e}")),
    };
    let mut hash = Sha256::new();
    if existing > 0 {
        let mut source = File::open(&partial).map_err(|e| format!("Cannot resume the {label} download: {e}"))?;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            let count = source.read(&mut buffer).map_err(|e| format!("Cannot resume the {label} download: {e}"))?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
    }
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| format!("Cannot initialize the {label} download"))?;
    let mut request = client.get(file.url);
    if existing > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let mut response = request
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| format!("{label} download failed. Check your connection and retry."))?;
    let resumed = existing > 0
        && response.status() == reqwest::StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|range| range.starts_with(&format!("bytes {existing}-")));
    if !resumed && existing > 0 {
        // The server sent the whole file instead of the requested range.
        existing = 0;
        hash = Sha256::new();
    }
    if response.content_length().is_some_and(|size| size != file.bytes - existing) {
        return Err(format!("{label} server returned an unexpected size."));
    }
    let mut output = if resumed {
        File::options().append(true).open(&partial)
    } else {
        // create_new rejects a symlink planted after the check above.
        let _ = fs::remove_file(&partial);
        File::options().write(true).create_new(true).open(&partial)
    }
    .map_err(|e| format!("Cannot save the {label}: {e}"))?;
    let mut bytes = existing;
    let mut buffer = [0_u8; 128 * 1024];
    progress(bytes);
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|_| format!("{label} download was interrupted. Retry to resume it."))?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > file.bytes {
            drop(output);
            let _ = fs::remove_file(&partial);
            return Err(format!("{label} download exceeded its expected size."));
        }
        output.write_all(&buffer[..count]).map_err(|e| format!("Cannot save the {label}: {e}"))?;
        hash.update(&buffer[..count]);
        progress(bytes);
    }
    if let Err(error) = validate_download(file, bytes, &format!("{:x}", hash.finalize())) {
        drop(output);
        // A short read can still resume; a full-size mismatch is corrupt.
        if bytes >= file.bytes {
            let _ = fs::remove_file(&partial);
        }
        return Err(error);
    }
    output.sync_all().map_err(|e| format!("Cannot finish saving the {label}: {e}"))?;
    drop(output);
    fs::rename(&partial, path).map_err(|e| format!("Cannot install the {label}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_requires_exact_size_and_checksum() {
        assert!(validate_download(&SPEECH_MODEL, MODEL_BYTES, MODEL_SHA256).is_ok());
        assert!(validate_download(&SPEECH_MODEL, MODEL_BYTES - 1, MODEL_SHA256).is_err());
        assert!(validate_download(&SPEECH_MODEL, MODEL_BYTES + 1, MODEL_SHA256).is_err());
        assert!(
            validate_download(&SPEECH_MODEL, MODEL_BYTES, &format!("{:x}", Sha256::digest(b"damaged"))).is_err()
        );
    }

    #[test]
    fn partial_downloads_live_next_to_the_destination() {
        assert_eq!(partial_path(Path::new("/data/speech/model.bin")), PathBuf::from("/data/speech/model.bin.part"));
    }
}
