// Voice activity detection for dictation: Silero VAD v5 (MIT,
// github.com/snakers4/silero-vad) through the bundled ONNX Runtime. It gives
// a speech probability for every 32 ms of 16 kHz audio and tells speech from
// fans, typing and music far better than an energy threshold, so silence can
// end a recording without cutting the user off. The 2 MB model is downloaded
// once (pinned) and loaded only while dictation records.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const MODEL_NAME: &str = "silero_vad.onnx";
const MODEL: crate::speech_model::PinnedFile = crate::speech_model::PinnedFile {
    label: "Voice activity model",
    url: "https://raw.githubusercontent.com/snakers4/silero-vad/a16f3ed07990489f395521a5fd6a3a6a8ad16240/src/silero_vad/data/silero_vad.onnx",
    bytes: 2_327_524,
    sha256: "2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f",
};

/// Samples per inference at 16 kHz, plus the context the model expects
/// before each window (the reference implementation's framing).
const WINDOW: usize = 512;
const CONTEXT: usize = 64;

/// The model file next to the speech model, downloaded on first use.
pub(crate) fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("speech").join(MODEL_NAME);
    if std::fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() == MODEL.bytes) {
        return Ok(path);
    }
    crate::speech_model::download_pinned(&MODEL, &path, |_| {})?;
    Ok(path)
}

/// Where the ONNX Runtime library is: inside the app bundle's Frameworks
/// (signed with the app), or PZZA_ONNXRUNTIME for development and tests.
fn onnxruntime_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PZZA_ONNXRUNTIME").map(PathBuf::from) {
        return path.is_file().then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let bundled = exe.parent()?.parent()?.join("Frameworks").join("libonnxruntime.1.dylib");
    if bundled.is_file() {
        return Some(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("frameworks").join("libonnxruntime.1.dylib");
    development.is_file().then_some(development)
}

fn environment() -> Result<&'static ort::environment::Environment, String> {
    static ENVIRONMENT: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| {
            let path = onnxruntime_path().ok_or("ONNX Runtime is missing from this build.")?;
            ort::init_from(&path)
                .map_err(|error| format!("ONNX Runtime could not be loaded: {error}"))?
                .with_name("pzzacode-voice")
                .build()
                .map_err(|error| format!("ONNX Runtime could not start: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A single-threaded session on the CPU. ort's default device policy
/// (MaxEfficiency) may hand the model to Core ML; the CPU is fast enough here.
fn cpu_session(path: &Path) -> Result<ort::session::Session, String> {
    let builder = ort::session::Session::builder(environment()?).map_err(|error| error.to_string())?;
    let builder = builder.with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU).map_err(|error| error.to_string())?;
    let mut builder = builder.with_intra_threads(1).map_err(|error| error.to_string())?;
    builder.commit_from_file(path).map_err(|error| error.to_string())
}

pub(crate) struct Vad {
    session: ort::session::Session,
    state: Vec<f32>,
    context: Vec<f32>,
    window: Vec<f32>,
    probability: f32,
}

impl Vad {
    pub(crate) fn load(path: &Path) -> Result<Self, String> {
        let failed = |error: String| format!("Voice activity detection could not start: {error}");
        let session = cpu_session(path).map_err(failed)?;
        Ok(Self { session, state: vec![0.0; 2 * 128], context: vec![0.0; CONTEXT], window: Vec::with_capacity(WINDOW), probability: 0.0 })
    }

    /// Feeds 16 kHz audio and returns the speech probability of the latest
    /// complete window (unchanged until 32 ms of new audio arrived).
    pub(crate) fn push(&mut self, samples: &[f32]) -> Result<f32, String> {
        for sample in samples {
            self.window.push(*sample);
            if self.window.len() == WINDOW {
                self.infer()?;
            }
        }
        Ok(self.probability)
    }

    fn infer(&mut self) -> Result<(), String> {
        let failed = |error: ort::Error| format!("Voice activity detection failed: {error}");
        let mut input = Vec::with_capacity(CONTEXT + WINDOW);
        input.extend_from_slice(&self.context);
        input.extend_from_slice(&self.window);
        self.context.copy_from_slice(&self.window[WINDOW - CONTEXT..]);
        self.window.clear();
        let state = std::mem::take(&mut self.state);
        let outputs = self.session.run(ort::inputs![
            "input" => ort::value::Tensor::from_array(([1usize, CONTEXT + WINDOW], input)).map_err(failed)?,
            "state" => ort::value::Tensor::from_array(([2usize, 1, 128], state)).map_err(failed)?,
            "sr" => ort::value::Tensor::from_array(((), vec![16_000i64])).map_err(failed)?,
        ]).map_err(failed)?;
        let (_, probability) = outputs["output"].try_extract_tensor::<f32>().map_err(failed)?;
        let probability = probability.first().copied().unwrap_or(0.0);
        let (_, state) = outputs["stateN"].try_extract_tensor::<f32>().map_err(failed)?;
        let state = state.to_vec();
        drop(outputs);
        self.probability = probability;
        self.state = state;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Needs the ONNX Runtime library (PZZA_ONNXRUNTIME or src-tauri/frameworks)
    // and the model at PZZA_VAD_MODEL.
    #[test]
    #[ignore = "needs ONNX Runtime and the Silero model"]
    fn silero_hears_speech_but_not_noise_or_silence() {
        let model = PathBuf::from(std::env::var("PZZA_VAD_MODEL").expect("PZZA_VAD_MODEL"));
        let mut vad = Vad::load(&model).unwrap();
        let rate = 16_000usize;
        let silence = vec![0.0f32; rate];
        assert!(vad.push(&silence).unwrap() < 0.2);
        let noise: Vec<f32> = (0..rate).map(|index| (((index * 7919) % 1000) as f32 / 1000.0 - 0.5) * 0.2).collect();
        assert!(vad.push(&noise).unwrap() < 0.5, "white noise is not speech");
        let path = std::env::temp_dir().join(format!("pzza-vad-{}.wav", std::process::id()));
        let status = std::process::Command::new("/usr/bin/say").args(["-v", "Samantha (English (US))", "--data-format=LEF32@16000", "-o"]).arg(&path).arg("Please open the usage menu and maximize the api tile.").status().unwrap();
        assert!(status.success());
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        let data = bytes.windows(4).position(|window| window == b"data").unwrap();
        let speech: Vec<f32> = bytes[data + 8..].chunks_exact(4).map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]]) * 0.2).collect();
        let peak = speech.chunks(320).map(|chunk| vad.push(chunk).unwrap()).fold(0.0f32, f32::max);
        assert!(peak > 0.8, "speech probability peaked at {peak}");
    }
}
