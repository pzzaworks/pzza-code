#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    id: String,
    name: String,
    is_default: bool,
}

#[cfg(target_os = "macos")]
mod native {
    use super::InputDevice;
    use coreaudio::audio_unit::{
        audio_format::LinearPcmFlags, macos_helpers::{audio_unit_from_device_id, get_audio_device_ids},
        render_callback::{self, data}, AudioUnit, Element, SampleFormat, Scope, StreamFormat,
    };
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceIsAlive, kAudioDevicePropertyDeviceUID, kAudioDevicePropertyStreams,
        kAudioHardwarePropertyDefaultInputDevice,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyScopeInput, kAudioObjectSystemObject, AudioObjectGetPropertyData,
        AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress,
    };
    use objc2_core_foundation::{CFRetained, CFString};
    use serde::Serialize;
    use std::{mem, ptr::{null, NonNull}};
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
        received: AtomicBool,
    }

    fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress { mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain }
    }

    // Each call pairs a CoreAudio property with its documented scalar representation.
    fn property<T: Copy + Default>(object: u32, selector: u32) -> Result<T, String> {
        let mut value = T::default();
        let mut size = mem::size_of::<T>() as u32;
        let address = address(selector, kAudioObjectPropertyScopeGlobal);
        let status = unsafe { AudioObjectGetPropertyData(object, NonNull::from(&address), 0, null(), NonNull::from(&mut size), NonNull::from(&mut value).cast()) };
        if status != 0 || size as usize != mem::size_of::<T>() { return Err("Could not read microphone properties".into()); }
        Ok(value)
    }

    fn device_string(object: u32, selector: u32) -> Result<String, String> {
        let pointer: *const CFString = property(object, selector)?;
        let pointer = NonNull::new(pointer.cast_mut()).ok_or("Microphone information is unavailable")?;
        // CoreAudio transfers ownership of CFString-valued device properties to the caller.
        Ok(unsafe { CFRetained::from_raw(pointer) }.to_string())
    }

    fn input_devices() -> Result<Vec<(u32, InputDevice)>, String> {
        let default = property::<u32>(kAudioObjectSystemObject as u32, kAudioHardwarePropertyDefaultInputDevice).unwrap_or(0);
        let objects = get_audio_device_ids().map_err(|_| "Could not list microphones")?;
        let mut devices = Vec::new();
        for object in objects {
            let address = self::address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput);
            let mut size = 0;
            let status = unsafe { AudioObjectGetPropertyDataSize(object, NonNull::from(&address), 0, null(), NonNull::from(&mut size)) };
            if status != 0 || size == 0 { continue; }
            let (Ok(id), Ok(name)) = (device_string(object, kAudioDevicePropertyDeviceUID), device_string(object, kAudioObjectPropertyName)) else { continue; };
            if valid_input_device_id(&id) { devices.push((object, InputDevice { id, name, is_default: object == default })); }
        }
        Ok(devices)
    }

    fn valid_input_device_id(id: &str) -> bool {
        !id.trim().is_empty() && id.len() <= 4096 && !id.chars().any(char::is_control)
    }

    fn select_input_device(devices: &[(u32, InputDevice)], id: Option<&str>) -> Result<u32, String> {
        devices.iter().find(|(_, device)| id.map_or(device.is_default, |id| device.id == id))
            .map(|(object, _)| *object)
            .ok_or_else(|| match id {
                Some(_) => "Selected microphone is unavailable. Reconnect it or choose another microphone in Settings.".into(),
                None => "No microphone found. Select an input in macOS Sound settings.".into(),
            })
    }

    #[tauri::command]
    pub async fn speech_input_devices() -> Result<Vec<InputDevice>, String> {
        tauri::async_runtime::spawn_blocking(|| input_devices().map(|devices| devices.into_iter().map(|(_, device)| device).collect()))
            .await.map_err(|_| "Could not list microphones".to_string())?
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

    fn input(device: u32, capture: Arc<Capture>) -> Result<(AudioUnit, u32), String> {
        let mut stream = audio_unit_from_device_id(device, true)
            .map_err(|_| "Microphone unavailable. Check microphone access in macOS Privacy & Security settings.")?;
        let hardware = stream.stream_format(Scope::Input, Element::Input)
            .map_err(|_| "Could not access microphone settings")?;
        if hardware.channels == 0 || hardware.channels > 128 || !hardware.sample_rate.is_finite()
            || !(1.0..=192_000.0).contains(&hardware.sample_rate) || hardware.sample_rate.fract() != 0.0 {
            return Err("Unsupported microphone format".into());
        }
        let rate = hardware.sample_rate as u32;
        let channels = hardware.channels as usize;
        let maximum = rate as usize * 90;
        *capture.rate.lock().map_err(|_| "Microphone lock failed")? = rate;
        // HAL converts the hardware format to interleaved floats at its native rate.
        stream.set_stream_format(StreamFormat {
            sample_rate: hardware.sample_rate, channels: hardware.channels,
            sample_format: SampleFormat::F32,
            flags: LinearPcmFlags::IS_FLOAT | LinearPcmFlags::IS_PACKED,
        }, Scope::Output, Element::Input).map_err(|_| "Unsupported microphone format")?;
        stream.set_input_callback(move |args: render_callback::Args<data::Interleaved<f32>>| {
            if capture.stop.load(Ordering::Acquire) { return Ok(()); }
            if !args.data.buffer.is_empty() { capture.received.store(true, Ordering::Release); }
            if let Ok(mut samples) = capture.samples.lock() {
                for frame in args.data.buffer.chunks_exact(channels) {
                    if samples.len() >= maximum {
                        if let Ok(mut error) = capture.error.lock() { *error = Some("Recognition could not keep up with the microphone. Try a shorter recording.".into()); }
                        capture.stop.store(true, Ordering::Release);
                        break;
                    }
                    samples.push(frame.iter().sum::<f32>() / channels as f32);
                }
            }
            Ok(())
        }).map_err(|_| "Could not initialize microphone capture")?;
        Ok((stream, rate))
    }

    fn capture_audio(app: AppHandle, capture: Arc<Capture>, input_device_id: Option<String>) {
        let result = (|| {
            let device = select_input_device(&input_devices()?, input_device_id.as_deref())?;
            let (mut stream, rate) = input(device, capture.clone())?;
            if capture.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            stream.start().map_err(|_| {
                "Could not start microphone. Check microphone permission in macOS settings."
            })?;
            emit(&app, &capture, "listening", None, None, None);
            let start = Instant::now();
            let mut last_audio = start;
            while !capture.stop.load(Ordering::Acquire)
                && start.elapsed() < Duration::from_secs(300)
            {
                if capture.received.swap(false, Ordering::AcqRel) { last_audio = Instant::now(); }
                if property::<u32>(device, kAudioDevicePropertyDeviceIsAlive).unwrap_or(0) == 0
                    || last_audio.elapsed() > Duration::from_secs(3) {
                    return Err("Microphone stopped providing audio. Check your selected input and microphone permission, then try again.".into());
                }
                let level = capture
                    .samples
                    .lock()
                    .map(|samples| {
                        let recent = &samples[samples
                            .len()
                            .saturating_sub(rate as usize / 10)..];
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

    fn run(app: AppHandle, capture: Arc<Capture>, language: String, input_device_id: Option<String>) {
        let result = (|| {
            emit(&app, &capture, "loading", None, None, None);
            prepare(&app)?;
            if capture.stop.load(Ordering::Acquire) {
                return Ok(String::new());
            }
            let audio_app = app.clone();
            let audio_capture = capture.clone();
            let microphone = std::thread::spawn(move || capture_audio(audio_app, audio_capture, input_device_id));
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

    #[cfg(test)]
    mod device_tests {
        use super::{select_input_device, valid_input_device_id, InputDevice};

        fn microphone(object: u32, id: &str, is_default: bool) -> (u32, InputDevice) {
            (object, InputDevice { id: id.into(), name: "USB microphone".into(), is_default })
        }

        #[test]
        fn system_default_is_resolved_for_each_recording() {
            let first = vec![microphone(1, "usb:a", true), microphone(2, "usb:b", false)];
            let second = vec![microphone(1, "usb:a", false), microphone(2, "usb:b", true)];
            assert_eq!(select_input_device(&first, None).unwrap(), 1);
            assert_eq!(select_input_device(&second, None).unwrap(), 2);
            assert!(select_input_device(&[], None).is_err());
        }

        #[test]
        fn selected_uid_survives_reconnection_and_duplicate_names() {
            let first = vec![microphone(1, "usb:a", true), microphone(2, "usb:b", false)];
            let reconnected = vec![microphone(7, "usb:b", true), microphone(9, "usb:a", false)];
            assert_eq!(select_input_device(&first, Some("usb:a")).unwrap(), 1);
            assert_eq!(select_input_device(&reconnected, Some("usb:a")).unwrap(), 9);
            assert!(select_input_device(&first, Some("missing")).is_err());
            assert!(select_input_device(&first, Some("USB microphone")).is_err());
        }

        #[test]
        fn device_ids_are_bounded_nonempty_and_free_of_control_characters() {
            assert!(valid_input_device_id("BuiltInMicrophoneDevice"));
            assert!(valid_input_device_id("USB: Studio microphone"));
            assert!(valid_input_device_id(&"a".repeat(4096)));
            for invalid in ["", " ", "usb\0mic", "usb\nmic", &"a".repeat(4097)] {
                assert!(!valid_input_device_id(invalid));
            }
        }
    }

    #[tauri::command]
    pub fn speech_start(app: AppHandle, id: String, language: String, input_device_id: Option<String>) -> Result<(), String> {
        if id.is_empty() || id.len() > 128 || !supported_language(&language)
            || input_device_id.as_deref().is_some_and(|id| !valid_input_device_id(id)) {
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
            received: AtomicBool::new(false),
        });
        *active = Some(capture.clone());
        let worker_app = app.clone();
        std::thread::spawn(move || run(worker_app, capture, language, input_device_id));
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
pub async fn speech_input_devices() -> Result<Vec<InputDevice>, String> {
    Err("Local dictation is available on macOS only".into())
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn speech_start(id: String, language: String, input_device_id: Option<String>) -> Result<(), String> {
    let _ = (id, language, input_device_id);
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
