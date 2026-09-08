#[cfg(target_os = "macos")]
mod native {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use serde::Serialize;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager};
    use whisper_rs::{
        FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
    };

    #[derive(Default)]
    pub struct SpeechState {
        context: Mutex<Option<Engine>>,
        active: Mutex<Option<Arc<Capture>>>,
    }

    struct Engine {
        _context: WhisperContext,
        decoder: WhisperState,
    }

    struct Capture {
        id: String,
        stop: AtomicBool,
        cancel: AtomicBool,
        closed: AtomicBool,
        samples: Mutex<Vec<f32>>,
        rate: Mutex<u32>,
        error: Mutex<Option<String>>,
    }

    #[derive(Clone, Serialize)]
    struct Event<'a> {
        id: &'a str,
        kind: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<&'a str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        level: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a str>,
    }

    fn emit(
        app: &AppHandle,
        capture: &Capture,
        kind: &str,
        text: Option<&str>,
        level: Option<f32>,
        error: Option<&str>,
    ) {
        if !capture.cancel.load(Ordering::Acquire) {
            let _ = app.emit(
                "dictation",
                Event {
                    id: &capture.id,
                    kind,
                    text,
                    level,
                    error,
                },
            );
        }
    }

    fn prepare(app: &AppHandle) -> Result<(), String> {
        let state = app.state::<SpeechState>();
        let mut context = state
            .context
            .lock()
            .map_err(|_| "Speech model lock failed")?;
        if context.is_none() {
            whisper_rs::install_logging_hooks();
            let path = crate::speech_model::model_path(app)?;
            let path = path
                .to_str()
                .ok_or("Speech model path is not valid UTF-8")?;
            let loaded = WhisperContext::new_with_params(path, WhisperContextParameters::default())
                .map_err(|_| "Could not load the dictation model. Re-download it and try again.")?;
            let decoder = loaded
                .create_state()
                .map_err(|_| "Could not create speech decoder")?;
            *context = Some(Engine {
                _context: loaded,
                decoder,
            });
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn speech_prepare(app: AppHandle) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || prepare(&app))
            .await
            .map_err(|_| "Speech preparation failed".to_string())?
    }

    fn input<T>(
        device: &cpal::Device,
        config: &cpal::StreamConfig,
        capture: Arc<Capture>,
    ) -> Result<cpal::Stream, String>
    where
        T: cpal::SizedSample + cpal::Sample,
        f32: cpal::FromSample<T>,
    {
        let channels = config.channels as usize;
        let maximum = config.sample_rate.0 as usize * 90;
        let failure = capture.clone();
        device.build_input_stream(config, move |data: &[T], _| {
            if capture.stop.load(Ordering::Acquire) { return; }
            if let Ok(mut samples) = capture.samples.lock() {
                for frame in data.chunks_exact(channels) {
                    if samples.len() >= maximum {
                        if let Ok(mut error) = capture.error.lock() { *error = Some("Recognition could not keep up with the microphone. Try a shorter recording.".into()); }
                        capture.stop.store(true, Ordering::Release);
                        break;
                    }
                    samples.push(frame.iter().map(|sample| sample.to_sample::<f32>()).sum::<f32>() / channels as f32);
                }
            }
        }, move |_| {
            if let Ok(mut error) = failure.error.lock() { *error = Some("Microphone disconnected or stopped. Check your audio input and try again.".into()); }
            failure.stop.store(true, Ordering::Release);
        }, None).map_err(|_| "Microphone unavailable. Allow microphone access in macOS System Settings > Privacy & Security > Microphone, then try again.".into())
    }

    fn capture_audio(app: AppHandle, capture: Arc<Capture>) {
        let result = (|| {
            let device = cpal::default_host()
                .default_input_device()
                .ok_or("No microphone found. Select an input in macOS Sound settings.")?;
            let supported = device
                .default_input_config()
                .map_err(|_| "Could not access microphone settings")?;
            let config = supported.config();
            if config.channels == 0 || config.sample_rate.0 == 0 || config.sample_rate.0 > 192_000 {
                return Err("Unsupported microphone format".into());
            }
            *capture.rate.lock().map_err(|_| "Microphone lock failed")? = config.sample_rate.0;
            let stream = match supported.sample_format() {
                cpal::SampleFormat::F32 => input::<f32>(&device, &config, capture.clone()),
                cpal::SampleFormat::I16 => input::<i16>(&device, &config, capture.clone()),
                cpal::SampleFormat::U16 => input::<u16>(&device, &config, capture.clone()),
                _ => {
                    Err("Unsupported microphone sample format. Choose another input device.".into())
                }
            }?;
            if capture.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            stream.play().map_err(|_| {
                "Could not start microphone. Check microphone permission in macOS settings."
            })?;
            emit(&app, &capture, "listening", None, None, None);
            let start = Instant::now();
            while !capture.stop.load(Ordering::Acquire)
                && start.elapsed() < Duration::from_secs(300)
            {
                let level = capture
                    .samples
                    .lock()
                    .map(|samples| {
                        let recent = &samples[samples
                            .len()
                            .saturating_sub(config.sample_rate.0 as usize / 10)..];
                        (recent.iter().map(|v| v * v).sum::<f32>() / recent.len().max(1) as f32)
                            .sqrt()
                    })
                    .unwrap_or(0.0);
                emit(
                    &app,
                    &capture,
                    "level",
                    None,
                    Some((level * 6.0).min(1.0)),
                    None,
                );
                std::thread::sleep(Duration::from_millis(50));
            }
            drop(stream);
            emit(&app, &capture, "finalizing", None, None, None);
            Ok::<(), String>(())
        })();
        if let Err(error) = result {
            if let Ok(mut slot) = capture.error.lock() {
                *slot = Some(error);
            }
        }
        capture.stop.store(true, Ordering::Release);
        capture.closed.store(true, Ordering::Release);
    }

    struct Transcript {
        preview: String,
        committed: String,
        consumed: usize,
    }

    fn transcribe(
        app: &AppHandle,
        capture: &Arc<Capture>,
        language: &str,
        finalizing: bool,
    ) -> Result<Transcript, String> {
        let rate = *capture.rate.lock().map_err(|_| "Audio lock failed")?;
        let samples: Vec<f32> = capture
            .samples
            .lock()
            .map_err(|_| "Audio lock failed")?
            .iter()
            .take(rate as usize * 27)
            .copied()
            .collect();
        let mut audio = super::resample(&samples, rate);
        if !super::has_speech(&audio) {
            return Ok(Transcript {
                preview: String::new(),
                committed: String::new(),
                consumed: samples.len(),
            });
        }
        let pause = audio.len() >= 32_000
            && audio[audio.len().saturating_sub(16_000)..]
                .chunks_exact(320)
                .all(|frame| frame.iter().map(|v| v * v).sum::<f32>() / 320.0 <= 0.000025);
        let commit_all = pause || (finalizing && audio.len() < 400_000);
        // Very short utterances still need a full decoder input frame.
        if audio.len() < 16_000 {
            audio.resize(16_000, 0.0);
        }
        let state = app.state::<SpeechState>();
        let mut context = state
            .context
            .lock()
            .map_err(|_| "Speech model lock failed")?;
        let decoder = &mut context
            .as_mut()
            .ok_or("Speech model is not loaded")?
            .decoder;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(
            std::thread::available_parallelism()
                .map(|n| n.get().min(8) as i32)
                .unwrap_or(4),
        );
        params.set_language(if language == "auto" {
            None
        } else {
            Some(language)
        });
        params.set_detect_language(false);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        let cancelled = capture.clone();
        params.set_abort_callback_safe(move || cancelled.cancel.load(Ordering::Acquire));
        decoder
            .full(params, &audio)
            .map_err(|_| "Speech recognition failed. Try a shorter recording.")?;
        let mut text = String::new();
        let mut committed = String::new();
        let mut consumed = 0;
        for segment in decoder.as_iter() {
            let end =
                (segment.end_timestamp().max(0) as usize * rate as usize / 100).min(samples.len());
            let stable = commit_all || (audio.len() >= 400_000 && segment.end_timestamp() <= 2300);
            if segment.no_speech_probability() < 0.6 {
                let words = segment
                    .to_str_lossy()
                    .map_err(|_| "Could not read recognition result")?;
                text.push_str(&words);
                if stable {
                    committed.push_str(&words);
                }
            }
            if stable {
                consumed = end;
            }
        }
        if commit_all {
            consumed = samples.len();
        }
        if audio.len() >= 400_000 && consumed == 0 {
            // Some continuous utterances arrive as one long segment. Commit the
            // decoded window instead of aborting or decoding the same audio forever.
            committed = text.clone();
            consumed = samples.len();
        }
        Ok(Transcript {
            preview: text.trim().to_string(),
            committed: committed.trim().to_string(),
            consumed,
        })
    }

    fn apply(
        capture: &Capture,
        transcript: &Transcript,
        committed: &mut String,
    ) -> Result<(), String> {
        if !transcript.committed.is_empty() {
            if !committed.is_empty() {
                committed.push(' ');
            }
            committed.push_str(&transcript.committed);
        }
        if transcript.consumed > 0 {
            capture
                .samples
                .lock()
                .map_err(|_| "Audio lock failed")?
                .drain(..transcript.consumed);
        }
        Ok(())
    }

    fn run(app: AppHandle, capture: Arc<Capture>, language: String) {
        let result = (|| {
            emit(&app, &capture, "loading", None, None, None);
            prepare(&app)?;
            if capture.stop.load(Ordering::Acquire) {
                return Ok(String::new());
            }
            let audio_app = app.clone();
            let audio_capture = capture.clone();
            let microphone = std::thread::spawn(move || capture_audio(audio_app, audio_capture));
            let mut last = Instant::now();
            let mut committed = String::new();
            while !capture.closed.load(Ordering::Acquire) {
                if capture.cancel.load(Ordering::Acquire) {
                    capture.stop.store(true, Ordering::Release);
                }
                if !capture.stop.load(Ordering::Acquire)
                    && last.elapsed() >= Duration::from_millis(900)
                {
                    match transcribe(&app, &capture, &language, false) {
                        Ok(transcript) => {
                            let preview = format!("{} {}", committed, transcript.preview)
                                .trim()
                                .to_string();
                            emit(&app, &capture, "partial", Some(&preview), None, None);
                            if let Err(error) = apply(&capture, &transcript, &mut committed) {
                                capture.stop.store(true, Ordering::Release);
                                let _ = microphone.join();
                                return Err(error);
                            }
                            if !transcript.committed.is_empty() {
                                emit(&app, &capture, "committed", Some(&committed), None, None);
                            }
                        }
                        Err(error) => {
                            capture.stop.store(true, Ordering::Release);
                            let _ = microphone.join();
                            return Err(error);
                        }
                    }
                    last = Instant::now();
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            let _ = microphone.join();
            if let Some(error) = capture
                .error
                .lock()
                .map_err(|_| "Audio lock failed")?
                .take()
            {
                return Err(error);
            }
            if capture.cancel.load(Ordering::Acquire) {
                return Ok(String::new());
            }
            while !capture
                .samples
                .lock()
                .map_err(|_| "Audio lock failed")?
                .is_empty()
            {
                let transcript = transcribe(&app, &capture, &language, true)?;
                apply(&capture, &transcript, &mut committed)?;
            }
            Ok(committed)
        })();
        // Release the singleton before notifying the interface so a new recording can start immediately.
        if let Ok(mut active) = app.state::<SpeechState>().active.lock() {
            *active = None;
        }
        match result {
            Ok(text) => emit(&app, &capture, "final", Some(&text), None, None),
            Err(error) => emit(&app, &capture, "error", None, None, Some(&error)),
        }
    }

    fn supported_language(language: &str) -> bool {
        language == "auto"
            || ((2..=3).contains(&language.len())
                && language.bytes().all(|byte| byte.is_ascii_lowercase())
                && whisper_rs::get_lang_id(language).and_then(whisper_rs::get_lang_str)
                    == Some(language))
    }

    #[cfg(test)]
    mod language_tests {
        use super::supported_language;

        #[test]
        fn accepts_every_canonical_engine_language_and_auto() {
            assert!(supported_language("auto"));
            for id in 0..=whisper_rs::get_lang_max_id() {
                assert!(supported_language(whisper_rs::get_lang_str(id).unwrap()));
            }
            for invalid in ["", "English", "TR", "en-US", "en\0", "turkish"] {
                assert!(!supported_language(invalid));
            }
        }
    }

    #[tauri::command]
    pub fn speech_start(app: AppHandle, id: String, language: String) -> Result<(), String> {
        if id.is_empty() || id.len() > 128 || !supported_language(&language) {
            return Err("Invalid dictation request".into());
        }
        let state = app.state::<SpeechState>();
        let mut active = state
            .active
            .lock()
            .map_err(|_| "Speech session lock failed")?;
        if active.is_some() {
            return Err("Dictation is already running. Wait for it to finish.".into());
        }
        let capture = Arc::new(Capture {
            id,
            stop: AtomicBool::new(false),
            cancel: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            samples: Mutex::new(Vec::new()),
            rate: Mutex::new(16_000),
            error: Mutex::new(None),
        });
        *active = Some(capture.clone());
        let worker_app = app.clone();
        std::thread::spawn(move || run(worker_app, capture, language));
        Ok(())
    }

    #[tauri::command]
    pub fn speech_stop(
        state: tauri::State<'_, SpeechState>,
        id: String,
        cancel: bool,
    ) -> Result<(), String> {
        let active = state
            .active
            .lock()
            .map_err(|_| "Speech session lock failed")?;
        if let Some(capture) = active.as_ref() {
            if capture.id != id {
                return Err("This dictation session is no longer active".into());
            }
            if cancel {
                capture.cancel.store(true, Ordering::Release);
            }
            capture.stop.store(true, Ordering::Release);
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use native::*;

#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct SpeechState;

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn speech_prepare() -> Result<(), String> {
    Err("Local dictation is available on macOS only".into())
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn speech_start(id: String, language: String) -> Result<(), String> {
    let _ = (id, language);
    Err("Local dictation is available on macOS only".into())
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn speech_stop(id: String, cancel: bool) -> Result<(), String> {
    let _ = (id, cancel);
    Err("Local dictation is available on macOS only".into())
}

#[cfg(any(target_os = "macos", test))]
fn resample(samples: &[f32], rate: u32) -> Vec<f32> {
    if rate == 0 || samples.is_empty() {
        return Vec::new();
    }
    let length = samples.len() * 16_000 / rate as usize;
    (0..length)
        .map(|i| {
            let position = i as f64 * rate as f64 / 16_000.0;
            let left = position as usize;
            let right = (left + 1).min(samples.len() - 1);
            let fraction = (position - left as f64) as f32;
            samples[left] * (1.0 - fraction) + samples[right] * fraction
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn has_speech(audio: &[f32]) -> bool {
    // Require sustained energy rather than sending silence or a single click to the decoder.
    audio
        .chunks_exact(320)
        .filter(|frame| frame.iter().map(|v| v * v).sum::<f32>() / 320.0 > 0.000025)
        .take(10)
        .count()
        >= 10
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resampling_preserves_duration_and_amplitude() {
        let converted = resample(&vec![0.25; 48_000], 48_000);
        assert_eq!(converted.len(), 16_000);
        assert!(converted
            .iter()
            .all(|value| (*value - 0.25).abs() < 0.00001));
        assert!(resample(&[], 48_000).is_empty());
    }
    #[test]
    fn silence_and_clicks_do_not_trigger_recognition() {
        assert!(!has_speech(&vec![0.0; 16_000]));
        let mut click = vec![0.0; 16_000];
        click[500] = 1.0;
        assert!(!has_speech(&click));
        assert!(has_speech(&vec![0.02; 3_200]));
    }
}
