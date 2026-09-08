use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

const MODEL_NAME: &str = "ggml-large-v3-turbo-q5_0.bin";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin";
const MODEL_BYTES: u64 = 574_041_195;
const MODEL_SHA256: &str = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";

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

struct PartialFile(PathBuf);
impl Drop for PartialFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn validate_download(bytes: u64, digest: &str) -> Result<(), String> {
    if bytes != MODEL_BYTES {
        return Err("Speech model download has an unexpected size. Please retry.".into());
    }
    if digest != MODEL_SHA256 {
        return Err("Speech model checksum verification failed. Please retry.".into());
    }
    Ok(())
}

fn download(app: &AppHandle) -> Result<(), String> {
    let path = destination(app)?;
    let directory = path
        .parent()
        .ok_or("Speech model directory is unavailable")?;
    fs::create_dir_all(directory)
        .map_err(|e| format!("Cannot create speech model directory: {e}"))?;
    let partial = PartialFile(path.with_extension("bin.part"));
    // Remove interrupted downloads before create_new, which also rejects symlinks.
    match fs::remove_file(&partial.0) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot clear interrupted speech download: {e}")),
    }
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(3600))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| "Cannot initialize speech model download")?;
    let mut response = client
        .get(MODEL_URL)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| "Speech model download failed. Check your connection and retry.")?;
    if response
        .content_length()
        .is_some_and(|size| size != MODEL_BYTES)
    {
        return Err("Speech model server returned an unexpected size.".into());
    }
    let mut file = File::options()
        .write(true)
        .create_new(true)
        .open(&partial.0)
        .map_err(|e| format!("Cannot save speech model: {e}"))?;
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    let mut last_event = Instant::now();
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|_| "Speech model download was interrupted. Please retry.")?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MODEL_BYTES {
            return Err("Speech model download exceeded its expected size.".into());
        }
        file.write_all(&buffer[..count])
            .map_err(|e| format!("Cannot save speech model: {e}"))?;
        hash.update(&buffer[..count]);
        if last_event.elapsed() >= Duration::from_millis(150) {
            publish(app, "downloading", bytes, None);
            last_event = Instant::now();
        }
    }
    validate_download(bytes, &format!("{:x}", hash.finalize()))?;
    file.sync_all()
        .map_err(|e| format!("Cannot finish saving speech model: {e}"))?;
    drop(file);
    fs::rename(&partial.0, path).map_err(|e| format!("Cannot install speech model: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_requires_exact_size_and_checksum() {
        assert!(validate_download(MODEL_BYTES, MODEL_SHA256).is_ok());
        assert!(validate_download(MODEL_BYTES - 1, MODEL_SHA256).is_err());
        assert!(validate_download(MODEL_BYTES + 1, MODEL_SHA256).is_err());
        assert!(
            validate_download(MODEL_BYTES, &format!("{:x}", Sha256::digest(b"damaged"))).is_err()
        );
    }
}
