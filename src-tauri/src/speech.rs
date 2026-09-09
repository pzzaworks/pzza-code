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
    use std::path::Path;
    use std::{mem, ptr::{null, NonNull}};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
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
        context: WhisperContext,
        decoder: WhisperState,
    }

    impl Engine {
        fn load(model: &Path) -> Result<Self, String> {
            let mut parameters = WhisperContextParameters::default();
            parameters.flash_attn(true);
            let context = WhisperContext::new_with_params(
                model.to_str().ok_or("Speech model path is not valid UTF-8")?, parameters,
            ).map_err(|error| format!("Could not load the dictation model: {error}"))?;
            let decoder = context.create_state().map_err(|error| format!("Could not create speech decoder: {error}"))?;
            Ok(Self { context, decoder })
        }

        fn recognize(&mut self, audio: &[f32], language: &str, capture: &Arc<Capture>) -> Result<(), String> {
            let mut params = recognition_params(language, capture);
            params.set_audio_ctx(audio_context(audio.len()));
            let result = self.decoder.full(params, audio);
            if capture.cancel.load(Ordering::Acquire) { return Ok(()); }
            if let Err(error) = result {
                self.decoder = self.context.create_state().map_err(|error| format!("Could not reset speech decoder: {error}"))?;
                return Err(format!("Speech recognition could not process the audio: {error}. Click the microphone to retry."));
            }
            Ok(())
        }
    }

    fn audio_context(samples: usize) -> i32 {
        // Each encoder frame covers 20 ms. Keep generous padding for short
        // speech and expand with the utterance instead of encoding 30 s every time.
        (samples.div_ceil(320).saturating_add(100).div_ceil(128) * 128).clamp(768, 1500) as i32
    }

    unsafe extern "C" fn recording_cancelled(data: *mut std::ffi::c_void) -> bool {
        // The caller keeps this Arc allocation alive throughout synchronous decoding.
        // Only an atomic flag is read, including when the engine calls from a worker thread.
        unsafe { &*data.cast::<Capture>() }.cancel.load(Ordering::Acquire)
    }

    fn recognition_params<'a>(language: &'a str, capture: &'a Arc<Capture>) -> FullParams<'a, 'a> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(std::thread::available_parallelism().map(|n| n.get().min(8) as i32).unwrap_or(4));
        params.set_language(if language == "auto" { None } else { Some(language) });
        params.set_detect_language(false);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        // Word boundaries let successive decodes confirm input before a sentence ends.
        params.set_token_timestamps(true);
        params.set_max_len(1);
        params.set_split_on_word(true);
        // Version 0.16.0's closure helper casts a boxed trait object to the wrong
        // concrete type. Pass the recording's stable address through the C API instead.
        unsafe {
            params.set_abort_callback(Some(recording_cancelled));
            params.set_abort_callback_user_data(Arc::as_ptr(capture).cast_mut().cast());
        }
        params
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
        captured_samples: AtomicUsize,
        finished: AtomicBool,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        active: Option<bool>,
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
                    active: None,
                },
            );
        }
    }

    fn emit_processing(app: &AppHandle, capture: &Capture, active: bool) {
        if !capture.cancel.load(Ordering::Acquire) {
            let _ = app.emit("dictation", Event {
                id: &capture.id, kind: "processing", text: None, level: None, error: None, active: Some(active),
            });
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
            *context = Some(Engine::load(&path)?);
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
                let before = samples.len();
                for frame in args.data.buffer.chunks_exact(channels) {
                    if samples.len() >= maximum {
                        if let Ok(mut error) = capture.error.lock() { *error = Some("Recognition could not keep up with the microphone. Try a shorter recording.".into()); }
                        capture.stop.store(true, Ordering::Release);
                        break;
                    }
                    samples.push(frame.iter().sum::<f32>() / channels as f32);
                }
                capture.captured_samples.fetch_add(samples.len() - before, Ordering::Release);
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

    #[derive(Default)]
    struct TranscriptWindow {
        earlier: String,
        previous: String,
        confirmed: String,
        language_candidate: Option<String>,
        detected_language: Option<String>,
    }

    impl TranscriptWindow {
        fn confirms(&self, candidate: &str) -> bool {
            agreed_prefix(&self.previous, candidate)
                && self.earlier.split_whitespace().zip(candidate.split_whitespace())
                    .all(|(earlier, current)| same_word(earlier, current))
        }

        fn observe(&mut self, text: &str) {
            self.earlier = mem::replace(&mut self.previous, text.into());
        }
    }

    fn utterance_boundary(audio: &[f32]) -> Option<usize> {
        let mut voiced = 0;
        let mut quiet = 0;
        for (index, frame) in audio.chunks_exact(320).enumerate() {
            if frame.iter().map(|value| value * value).sum::<f32>() / 320.0 > 0.000025 {
                voiced += 1;
                quiet = 0;
            } else {
                quiet += 1;
                // Look inside the buffer too: another phrase may have started
                // while the engine was decoding the previous one.
                if voiced >= 10 && quiet >= 20 { return Some((index + 1) * 320); }
            }
        }
        None
    }

    fn transcribe(
        app: &AppHandle,
        capture: &Arc<Capture>,
        language: &str,
        window: &mut TranscriptWindow,
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
        let state = app.state::<SpeechState>();
        let mut context = state.context.lock().map_err(|_| "Speech model lock failed")?;
        let engine = context.as_mut().ok_or("Speech model is not loaded")?;
        emit_processing(app, capture, true);
        let result = transcribe_samples(engine, capture, language, window, &samples, rate, finalizing);
        emit_processing(app, capture, false);
        result
    }

    fn transcribe_samples(
        engine: &mut Engine,
        capture: &Arc<Capture>,
        language: &str,
        window: &mut TranscriptWindow,
        samples: &[f32],
        rate: u32,
        finalizing: bool,
    ) -> Result<Transcript, String> {
        let mut audio = super::resample(samples, rate);
        let boundary = utterance_boundary(&audio);
        let utterance_samples = boundary.map(|end| end * rate as usize / 16_000).unwrap_or(samples.len());
        if let Some(end) = boundary { audio.truncate(end); }
        if window.confirmed.is_empty() && !super::has_speech(&audio) {
            return Ok(Transcript {
                preview: String::new(),
                committed: String::new(),
                // Keep a little preroll so a word beginning at this boundary is not lost.
                consumed: if finalizing { samples.len() } else { samples.len().saturating_sub(rate as usize / 5) },
            });
        }
        let duration = audio.len();
        let commit_all = boundary.is_some() || finalizing || audio.len() >= 400_000;
        // Very short utterances still need a full decoder input frame.
        if audio.len() < 16_000 {
            audio.resize(16_000, 0.0);
        }
        engine.recognize(&audio, window.detected_language.as_deref().unwrap_or(language), capture)?;
        if capture.cancel.load(Ordering::Acquire) {
            return Ok(Transcript { preview: String::new(), committed: String::new(), consumed: samples.len() });
        }
        let decoder = &engine.decoder;
        // Reuse an agreed language only within this utterance. A pause resets
        // detection so the next utterance can use a different language.
        if language == "auto" && window.detected_language.is_none() {
            if let Some(detected) = whisper_rs::get_lang_str(decoder.full_lang_id_from_state()) {
                if duration >= 24_000 && window.language_candidate.as_deref() == Some(detected) {
                    window.detected_language = Some(detected.into());
                }
                window.language_candidate = Some(detected.into());
            }
        }
        let mut text = String::new();
        let mut committed = String::new();
        let mut consumed = 0;
        for segment in decoder.as_iter() {
            if segment.no_speech_probability() < 0.6 {
                let words = segment
                    .to_str_lossy()
                    .map_err(|_| "Could not read recognition result")?;
                text.push_str(&words);
            }
            // Confirm complete words twice, but give recently revised words one
            // more update. The newest half-second also stays uncommitted.
            let agreed = window.confirms(text.trim())
                && segment.end_timestamp().max(0) as usize + 50 <= duration / 160;
            let stable = commit_all || agreed;
            if stable {
                committed = text.clone();
            }
        }
        let text = text.trim();
        let candidate = committed.trim();
        let preview = remaining_words(text, &window.confirmed).unwrap_or("").trim().to_string();
        let committed = if let Some(suffix) = remaining_words(candidate, &window.confirmed) {
            let suffix = suffix.trim().to_string();
            window.confirmed = candidate.into();
            suffix
        } else if commit_all {
            return Err("Recognition revised words already entered. Check the terminal and repeat the remaining words.".into());
        } else {
            String::new()
        };
        window.observe(text);
        // Retain acoustic context while emitting words. Cutting at estimated word
        // timestamps can split a syllable and corrupt the next recognition update.
        if commit_all {
            consumed = utterance_samples;
            *window = TranscriptWindow::default();
        }
        Ok(Transcript {
            preview,
            committed,
            consumed,
        })
    }

    fn agreed_prefix(previous: &str, candidate: &str) -> bool {
        !candidate.is_empty() && remaining_words(previous, candidate)
            .is_some_and(|remaining| !remaining.trim().is_empty())
    }

    fn same_word(left: &str, right: &str) -> bool {
        let normalize = |word: &str| word.trim_matches(['.', ',', '!', '?', ';', ':']).to_lowercase();
        normalize(left) == normalize(right)
    }

    fn remaining_words<'a>(text: &'a str, confirmed: &str) -> Option<&'a str> {
        // Later context often revises casing or sentence punctuation. Keep what
        // was already typed and align whole words, without deleting terminal input.
        let mut remaining = text;
        for word in confirmed.split_whitespace() {
            remaining = remaining.trim_start();
            let end = remaining.find(char::is_whitespace).unwrap_or(remaining.len());
            if end == 0 || !same_word(&remaining[..end], word) { return None; }
            remaining = &remaining[end..];
        }
        Some(remaining)
    }

    #[cfg(test)]
    mod streaming_tests {
        use super::*;

        fn capture() -> Arc<Capture> {
            Arc::new(Capture {
                id: "speech-test".into(), stop: AtomicBool::new(false), cancel: AtomicBool::new(false),
                closed: AtomicBool::new(false), samples: Mutex::new(Vec::new()), rate: Mutex::new(16_000),
                error: Mutex::new(None), received: AtomicBool::new(false), finished: AtomicBool::new(false),
                captured_samples: AtomicUsize::new(0),
            })
        }

        #[test]
        fn pauses_split_buffered_phrases_without_cutting_short_word_gaps() {
            let speech = vec![0.02; 8_000];
            let mut audio = speech.clone();
            audio.extend(vec![0.0; 6_400]);
            audio.extend(&speech);
            assert_eq!(utterance_boundary(&audio), Some(14_400));
            let mut short_gap = speech.clone();
            short_gap.extend(vec![0.0; 3_200]);
            short_gap.extend(&speech);
            assert_eq!(utterance_boundary(&short_gap), None);
            assert_eq!(utterance_boundary(&vec![0.0; 32_000]), None);
            let mut leading_silence = vec![0.0; 16_000];
            leading_silence.extend(&speech);
            assert_eq!(utterance_boundary(&leading_silence), None);
        }

        #[test]
        fn encoder_window_keeps_padding_without_truncating_long_speech() {
            assert_eq!(audio_context(16_000), 768);
            assert_eq!(audio_context(160_000), 768);
            assert!(audio_context(240_000) >= 850);
            for seconds in 1..=27 {
                let context = audio_context(seconds * 16_000) as usize;
                assert!(context <= 1500);
                assert!(context * 320 >= (seconds + 2) * 16_000);
            }
        }

        #[test]
        fn decoder_cancellation_reads_only_the_live_atomic_flag() {
            let capture = capture();
            let pointer = Arc::as_ptr(&capture).cast_mut().cast();
            assert!(!unsafe { recording_cancelled(pointer) });
            capture.stop.store(true, Ordering::Release);
            assert!(!unsafe { recording_cancelled(pointer) }, "Stop must finish recognition, not abort it");
            capture.cancel.store(true, Ordering::Release);
            assert!(unsafe { recording_cancelled(pointer) });
            capture.cancel.store(false, Ordering::Release);
            assert!(!unsafe { recording_cancelled(pointer) });
            let references = Arc::strong_count(&capture);
            for _ in 0..32 { drop(recognition_params("en", &capture)); }
            assert_eq!(Arc::strong_count(&capture), references, "Decoder callbacks must not leak recordings");
        }

        #[test]
        fn only_complete_agreed_words_are_committed() {
            assert!(agreed_prefix("Please write this", "Please write"));
            assert!(agreed_prefix("Türkçe konuşmaya devam", "Türkçe konuşmaya"));
            assert!(!agreed_prefix("Please write", "Please write"));
            assert!(!agreed_prefix("Please writer", "Please write"));
            assert!(!agreed_prefix("Please read this", "Please write"));
            assert!(!agreed_prefix("Anything", ""));
            assert!(agreed_prefix("As I speak. Then continue", "As I speak, then"));
            assert_eq!(remaining_words("As I speak. Then continue", "As I speak,"), Some(" Then continue"));
            assert_eq!(remaining_words("Do not run this", "Do run"), None);
            assert_eq!(remaining_words("Use foo-bar next", "Use foobar"), None);
        }

        #[test]
        fn brief_language_switch_revisions_are_not_confirmed_early() {
            let mut window = TranscriptWindow::default();
            window.observe("Please write this.");
            window.observe("Please write the sentence.");
            assert!(window.confirms("Please write"));
            assert!(!window.confirms("Please write the"));
            window.observe("Please write the sentence in.");
            assert!(!window.confirms("Please write this"));
            window.observe("Please write this sentence into the");
            assert!(!window.confirms("Please write this"));
            window.observe("Please write this sentence into the terminal");
            assert!(window.confirms("Please write this"));
        }

        #[test]
        fn consistent_word_growth_keeps_two_observation_confirmation() {
            let mut window = TranscriptWindow::default();
            window.observe("Please write");
            window.observe("Please write this sentence");
            assert!(window.confirms("Please write this"));
            assert!(!window.confirms("Please write this sentence"));
        }

        #[test]
        #[ignore = "Requires the installed speech model and a 16 kHz float PCM speech fixture"]
        fn real_model_streams_words_before_stop_and_recovers_after_cancel() {
            whisper_rs::install_logging_hooks();
            let model = std::env::var_os("PZZA_DICTATION_TEST_MODEL").expect("Set PZZA_DICTATION_TEST_MODEL");
            let fixture = std::env::var_os("PZZA_DICTATION_TEST_AUDIO").expect("Set PZZA_DICTATION_TEST_AUDIO");
            let expected = std::env::var("PZZA_DICTATION_TEST_EXPECTED").unwrap_or_else(|_|
                "Please write this sentence into the terminal as I speak. Then keep listening until I press the stop button.".into());
            let bytes = std::fs::read(fixture).unwrap();
            let samples: Vec<f32> = bytes.chunks_exact(4)
                .map(|sample| f32::from_le_bytes(sample.try_into().unwrap())).collect();
            let mut engine = Engine::load(Path::new(&model)).unwrap();
            let capture = capture();
            let language = "auto";
            let mut window = TranscriptWindow::default();
            let mut committed = String::new();
            let mut offset = 0;
            let mut live_updates = 0;
            for incoming in samples.chunks(4_000) {
                capture.samples.lock().unwrap().extend_from_slice(incoming);
                offset += incoming.len();
                let audio = capture.samples.lock().unwrap().clone();
                let transcript = transcribe_samples(&mut engine, &capture, language, &mut window, &audio, 16_000, false).unwrap();
                if !transcript.committed.is_empty() && offset < samples.len() {
                    live_updates += 1;
                }
                apply(&capture, &transcript, &mut committed).unwrap();
            }
            while !capture.samples.lock().unwrap().is_empty() {
                let audio = capture.samples.lock().unwrap().clone();
                let transcript = transcribe_samples(&mut engine, &capture, language, &mut window, &audio, 16_000, true).unwrap();
                apply(&capture, &transcript, &mut committed).unwrap();
            }
            assert!(live_updates >= 2, "Expected multiple terminal updates before Stop, got {live_updates}");
            let normalize = |text: &str| text.to_lowercase().chars()
                .filter(|character| character.is_alphanumeric() || character.is_whitespace()).collect::<String>()
                .split_whitespace().collect::<Vec<_>>().join(" ");
            assert_eq!(normalize(&committed), normalize(&expected));
            capture.cancel.store(true, Ordering::Release);
            engine.recognize(&samples, language, &capture).unwrap();
            capture.cancel.store(false, Ordering::Release);
            engine.recognize(&samples, language, &capture).unwrap();
            assert!(engine.decoder.full_n_segments() > 0, "The next recording must remain usable after cancellation");
        }
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
            let mut processed_samples = 0;
            let mut committed = String::new();
            let mut window = TranscriptWindow::default();
            while !capture.closed.load(Ordering::Acquire) {
                if capture.cancel.load(Ordering::Acquire) {
                    capture.stop.store(true, Ordering::Release);
                }
                let captured_samples = capture.captured_samples.load(Ordering::Acquire);
                let rate = match capture.rate.lock() {
                    Ok(rate) => *rate as usize,
                    Err(_) => {
                        capture.stop.store(true, Ordering::Release);
                        let _ = microphone.join();
                        return Err("Audio lock failed".into());
                    }
                };
                if !capture.stop.load(Ordering::Acquire) && captured_samples.saturating_sub(processed_samples) >= rate / 4 {
                    // Decode each new quarter-second of audio as soon as the engine
                    // is free, including audio captured while the last decode ran.
                    processed_samples = captured_samples;
                    match transcribe(&app, &capture, &language, &mut window, false) {
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
                let transcript = transcribe(&app, &capture, &language, &mut window, true)?;
                apply(&capture, &transcript, &mut committed)?;
            }
            Ok(committed)
        })();
        // Release the singleton before notifying the interface so a new recording can start immediately.
        if let Ok(mut active) = app.state::<SpeechState>().active.lock() {
            *active = None;
        }
        capture.finished.store(true, Ordering::Release);
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
            captured_samples: AtomicUsize::new(0),
            finished: AtomicBool::new(false),
        });
        *active = Some(capture.clone());
        let worker_app = app.clone();
        std::thread::spawn(move || run(worker_app, capture, language, input_device_id));
        Ok(())
    }

    #[tauri::command]
    pub async fn speech_stop(
        state: tauri::State<'_, SpeechState>,
        id: String,
        cancel: bool,
    ) -> Result<(), String> {
        let active = state
            .active
            .lock()
            .map_err(|_| "Speech session lock failed")?
            .clone();
        if let Some(capture) = active {
            if capture.id != id {
                return Err("This dictation session is no longer active".into());
            }
            if cancel {
                capture.cancel.store(true, Ordering::Release);
            }
            capture.stop.store(true, Ordering::Release);
            if cancel {
                tauri::async_runtime::spawn_blocking(move || {
                    let deadline = Instant::now() + Duration::from_secs(10);
                    while !capture.finished.load(Ordering::Acquire) {
                        if Instant::now() >= deadline {
                            return Err("The microphone is still stopping. Try again in a moment.");
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Ok(())
                }).await.map_err(|_| "Could not stop the microphone")??;
            }
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
