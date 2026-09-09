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
            let mut engine = Self { context, decoder };
            // Compile the live decoder's Metal kernels during preparation so
            // the first spoken words do not pay that startup cost.
            let warmup = Arc::new(Capture::new(String::new()));
            engine.recognize(&[0.0; 16_000], "en", &warmup, false)?;
            Ok(engine)
        }

        fn recognize(&mut self, audio: &[f32], language: &str, capture: &Arc<Capture>, multilingual: bool) -> Result<(), String> {
            let mut params = recognition_params(language, capture);
            params.set_audio_ctx(if multilingual { 1500 } else { audio_context(audio.len()) });
            let result = self.decoder.full(params, audio);
            if capture.cancel.load(Ordering::Acquire) { return Ok(()); }
            if let Err(error) = result {
                self.decoder = self.context.create_state().map_err(|error| format!("Could not reset speech decoder: {error}"))?;
                return Err(format!("Speech recognition could not process the audio: {error}. Click the microphone to retry."));
            }
            Ok(())
        }

        fn detect_language(&mut self, audio: &[f32]) -> Result<Option<String>, String> {
            self.decoder.pcm_to_mel(audio, 8)
                .map_err(|error| format!("Could not prepare language detection: {error}"))?;
            let (language, probabilities) = self.decoder.lang_detect(0, 8)
                .map_err(|error| format!("Could not detect the spoken language: {error}"))?;
            Ok(probabilities.get(language as usize).filter(|probability| **probability >= 0.6)
                .and_then(|_| whisper_rs::get_lang_str(language)).map(str::to_owned))
        }
    }

    fn audio_context(samples: usize) -> i32 {
        // Each encoder frame covers 20 ms, with two seconds of padding. Mixed
        // speech uses the full context to avoid losing short language switches.
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

    impl Capture {
        fn new(id: String) -> Self {
            Self {
                id, stop: AtomicBool::new(false), cancel: AtomicBool::new(false),
                closed: AtomicBool::new(false), samples: Mutex::new(Vec::new()),
                rate: Mutex::new(16_000), error: Mutex::new(None), received: AtomicBool::new(false),
                captured_samples: AtomicUsize::new(0), finished: AtomicBool::new(false),
            }
        }
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

    #[derive(Clone, Debug)]
    struct Word {
        text: String,
        start: usize,
        end: usize,
    }

    #[derive(Default)]
    struct TranscriptWindow {
        earlier: Vec<Word>,
        previous: Vec<Word>,
        confirmed: Vec<Word>,
        detected_language: Option<String>,
        language_checked_at: usize,
        language_hint_until: usize,
        english_since: Option<usize>,
        multilingual: bool,
        language_changed: bool,
        missing_prefix: bool,
    }

    impl TranscriptWindow {
        fn update(&mut self, words: Vec<Word>, duration: usize, complete: bool) -> Transcript {
            let words = if complete && words.is_empty() {
                let count = self.previous.iter().zip(&self.earlier)
                    .take_while(|(word, old)| same_word(&word.text, &old.text)).count();
                self.previous[..count].to_vec()
            } else { words };
            let omitted_prefix = self.language_changed && !self.confirmed.is_empty()
                && !words.is_empty() && aligned_prefix(&words, &self.confirmed) == 0;
            self.missing_prefix |= omitted_prefix;
            self.language_changed = false;
            // Recovery belongs to the boundary's old hypotheses. On subsequent
            // passes those hypotheses already describe the new language and
            // must go through normal word confirmation instead.
            let carried = if omitted_prefix {
                self.finish_missing_prefix(&words, duration)
            } else { String::new() };
            if self.missing_prefix && aligned_prefix(&words, &self.confirmed) > 0 {
                self.missing_prefix = false;
            }
            let entered = self.entered(&words);
            let pending = &words[entered..];
            let previous = &self.previous[self.entered(&self.previous)..];
            let earlier = &self.earlier[self.entered(&self.earlier)..];
            let count = if complete { pending.len() } else {
                pending.iter().enumerate().take_while(|(index, word)| {
                    // Keep the newest half-second and incomplete last word open.
                    word.end.saturating_add(8_000) <= duration
                        && previous.len() > index + 1
                        && same_word(&previous[*index].text, &word.text)
                        && earlier.get(*index).is_none_or(|old| same_word(&old.text, &word.text))
                }).count()
            };
            let transcript = Transcript {
                preview: word_text(pending),
                committed: [carried, word_text(&pending[..count])].into_iter()
                    .filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" "),
                consumed: 0,
            };
            // Rebase already entered audio onto this hypothesis. A correction to
            // an old word must not prevent unrelated later words from being typed.
            if count > 0 {
                self.confirm(&words, entered, count);
                self.missing_prefix = false;
            }
            if !words.is_empty() {
                self.earlier = mem::replace(&mut self.previous, words);
            }
            transcript
        }

        fn confirm(&mut self, words: &[Word], entered: usize, count: usize) {
            if entered < self.confirmed.len() {
                // A language-specific hypothesis may temporarily omit words
                // already typed. Keep those anchors in case a later decode
                // restores them with different timestamps.
                self.confirmed.extend_from_slice(&words[entered..entered + count]);
            } else {
                self.confirmed = words[..entered + count].to_vec();
            }
        }

        fn entered(&self, words: &[Word]) -> usize {
            let aligned = aligned_prefix(words, &self.confirmed);
            if aligned > 0 || self.missing_prefix { return aligned; }
            // Without a language change, a wholly revised hypothesis still
            // represents the same audio. Preserve the already entered frontier.
            self.confirmed.last().map(|last| words.iter()
                .take_while(|word| word.end <= last.end).count()).unwrap_or(0)
        }

        fn finish_missing_prefix(&mut self, words: &[Word], duration: usize) -> String {
            if !self.missing_prefix || words.is_empty() || self.confirmed.is_empty() || aligned_prefix(words, &self.confirmed) > 0 {
                return String::new();
            }
            // A language change can omit the entire old-language prefix. Finish
            // only its still-pending words that both earlier decodes agreed on.
            let entered = aligned_prefix(&self.previous, &self.confirmed);
            let previous = &self.previous[entered..];
            let earlier = &self.earlier[aligned_prefix(&self.earlier, &self.confirmed)..];
            let count = previous.iter().zip(earlier).take_while(|(word, old)| {
                same_word(&word.text, &old.text) && word.end.saturating_add(8_000) <= duration
            }).count();
            let text = word_text(&previous[..count]);
            if count > 0 {
                let words = self.previous[..entered + count].to_vec();
                self.confirm(&words, entered, count);
            }
            text
        }

        fn trim(&mut self, samples: usize) {
            self.language_checked_at = self.language_checked_at.saturating_sub(samples);
            self.language_hint_until = self.language_hint_until.saturating_sub(samples);
            self.english_since = self.english_since.map(|start| start.saturating_sub(samples));
            if self.language_hint_until == 0 {
                self.detected_language = None;
                self.multilingual = false;
            }
            for words in [&mut self.earlier, &mut self.previous, &mut self.confirmed] {
                words.retain(|word| word.end > samples);
                for word in words {
                    word.start = word.start.saturating_sub(samples);
                    word.end = word.end.saturating_sub(samples);
                }
            }
        }

        fn observe_language(&mut self, language: String, duration: usize) {
            self.multilingual |= self.detected_language.as_ref().is_some_and(|current| *current != language);
            let sustained_english = if language == "en" {
                duration.saturating_sub(*self.english_since.get_or_insert(duration)) >= 16_000
            } else {
                self.english_since = None;
                false
            };
            // An English hint can omit foreign phrases from mixed speech. Keep
            // the other language's hint while that speech remains in the buffer;
            // brief English interjections still transcribe under that hint. Switch
            // back when English persists, rather than pinning a foreign language.
            if language != "en" || sustained_english || self.detected_language.as_deref().is_none_or(|current| current == "en") {
                self.language_changed |= self.detected_language.as_ref() != Some(&language);
                self.detected_language = Some(language);
                self.language_hint_until = duration;
            }
            self.language_checked_at = duration;
        }
    }

    fn word_text(words: &[Word]) -> String {
        words.iter().map(|word| word.text.as_str()).collect::<Vec<_>>().join(" ")
    }

    fn aligned_prefix(words: &[Word], confirmed: &[Word]) -> usize {
        let Some(last) = confirmed.last() else { return 0; };
        // Align the retained overlap, allowing insertions, deletions and revisions
        // in old speech. Time breaks ties so repeated words remain distinct.
        let mut costs: Vec<usize> = (0..=words.len()).collect();
        let mut matches = vec![0; words.len() + 1];
        for (index, old) in confirmed.iter().enumerate() {
            let mut diagonal = costs[0];
            let mut diagonal_matches = matches[0];
            costs[0] = index + 1;
            for (position, word) in words.iter().enumerate() {
                let above = costs[position + 1];
                let above_matches = matches[position + 1];
                let overlaps = word.start < old.end && word.end > old.start;
                // After two words establish the overlap, trust that lexical
                // alignment: cutting retained audio can retime the entire phrase.
                let nearby = word.start < old.end.saturating_add(1_600)
                    && word.end.saturating_add(1_600) > old.start;
                let equal = (overlaps || (nearby && diagonal_matches > 0) || diagonal_matches >= 2)
                    && same_word(&old.text, &word.text);
                let substitution = if equal { 0 } else if overlaps { 1 } else { 2 };
                let best = [
                    (diagonal + substitution, diagonal_matches + usize::from(equal)),
                    (above + 1, above_matches),
                    (costs[position] + 1, matches[position]),
                ].into_iter().min_by_key(|(cost, matched)| (*cost, std::cmp::Reverse(*matched))).unwrap();
                costs[position + 1] = best.0;
                matches[position + 1] = best.1;
                diagonal = above;
                diagonal_matches = above_matches;
            }
        }
        (0..=words.len()).filter(|index| *index == 0 || matches[*index] > 0).min_by_key(|index| {
            let end = index.checked_sub(1).map(|i| words[i].end).unwrap_or(0);
            (costs[*index], std::cmp::Reverse(matches[*index]), end.abs_diff(last.end))
        }).unwrap_or(0)
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
        // Recheck recent speech, not the beginning of a long utterance. Reuse the
        // result between checks to avoid an extra encoder pass on every update.
        if language == "auto" && duration.saturating_sub(window.language_checked_at) >= 24_000 {
            // An inconclusive detector must not interrupt otherwise usable ASR.
            if let Ok(Some(detected)) = engine.detect_language(&audio[duration.saturating_sub(32_000)..duration]) {
                window.observe_language(detected, duration);
            }
            window.language_checked_at = duration;
        }
        engine.recognize(&audio, window.detected_language.as_deref().unwrap_or(language), capture, window.multilingual)?;
        if capture.cancel.load(Ordering::Acquire) {
            return Ok(Transcript { preview: String::new(), committed: String::new(), consumed: samples.len() });
        }
        let mut words: Vec<Word> = Vec::new();
        for segment in engine.decoder.as_iter() {
            if segment.no_speech_probability() >= 0.6 { continue; }
            let text = segment.to_str_lossy().map_err(|_| "Could not read recognition result")?;
            let start = segment.start_timestamp().max(0) as usize * 160;
            let end = (segment.end_timestamp().max(0) as usize * 160).min(duration);
            for (index, part) in text.split_whitespace().enumerate() {
                if index == 0 && !text.starts_with(char::is_whitespace) {
                    if let Some(last) = words.last_mut() {
                        last.text.push_str(part);
                        last.end = end;
                        continue;
                    }
                }
                words.push(Word { text: part.into(), start, end });
            }
        }
        let mut transcript = window.update(words, duration, commit_all);
        if commit_all {
            transcript.consumed = utterance_samples;
            *window = TranscriptWindow::default();
        } else if let Some(last) = window.confirmed.last() {
            if last.end >= 96_000 {
                // Retain at least four seconds of confirmed acoustic context. Any
                // partial word at the cut is already entered and aligned out.
                let cut = window.confirmed.iter().rev()
                    .find(|word| word.start + 64_000 <= last.end)
                    .map(|word| word.start / 320 * 320).unwrap_or(0);
                transcript.consumed = cut * rate as usize / 16_000;
                window.trim(cut);
            }
        }
        Ok(transcript)
    }

    fn same_word(left: &str, right: &str) -> bool {
        let normalize = |word: &str| word.trim_matches(['.', ',', '!', '?', ';', ':']).to_lowercase();
        normalize(left) == normalize(right)
    }

    #[cfg(test)]
    mod streaming_tests {
        use super::*;

        fn capture() -> Arc<Capture> {
            Arc::new(Capture::new("speech-test".into()))
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

        fn words(text: &str) -> Vec<Word> {
            text.split_whitespace().enumerate().map(|(index, text)| Word {
                text: text.into(), start: index * 8_000, end: (index + 1) * 8_000,
            }).collect()
        }

        #[test]
        fn old_word_revisions_do_not_block_new_input() {
            let mut window = TranscriptWindow::default();
            window.update(words("Please write the sentence"), 48_000, false);
            assert_eq!(window.update(words("Please write the sentence here"), 56_000, false).committed, "Please write the");
            assert_eq!(window.update(words("Please write this sentence here now"), 64_000, false).committed, "sentence");
            assert_eq!(window.update(words("Please write this sentence here now"), 64_000, true).committed, "here now");
        }

        #[test]
        fn alignment_handles_insertions_deletions_and_repeated_words() {
            let expanded = words("Please carefully write this sentence");
            let confirmed = vec![expanded[0].clone(), expanded[2].clone(), expanded[3].clone()];
            assert_eq!(aligned_prefix(&expanded, &confirmed), 4);
            let shortened = vec![expanded[0].clone(), expanded[2].clone(), expanded[3].clone(), expanded[4].clone()];
            assert_eq!(aligned_prefix(&shortened, &expanded[..4]), 3);
            assert_eq!(aligned_prefix(&words("go go go next"), &words("go go")), 2);
            assert_eq!(aligned_prefix(&words("Use foo-bar next"), &words("Use foobar")), 2);
            assert_eq!(aligned_prefix(&words("Türkçe bitti now keep speaking"), &words("Türkçe bitti")), 2);
        }

        #[test]
        fn incomplete_hypotheses_do_not_forget_entered_words() {
            for revision in ["", "one two"] {
                let mut window = TranscriptWindow::default();
                assert_eq!(window.update(words("one two three"), 40_000, true).committed, "one two three");
                assert_eq!(window.update(words(revision), 48_000, false).committed, "");
                assert_eq!(window.update(words("one two three four"), 56_000, true).committed, "four");
            }
            let mut window = TranscriptWindow::default();
            window.update(words("keep listening"), 24_000, false);
            assert_eq!(window.update(Vec::new(), 32_000, true).committed, "");
            assert_eq!(window.update(words("keep listening"), 24_000, false).committed, "keep");
            assert_eq!(window.update(Vec::new(), 32_000, true).committed, "listening");
        }

        #[test]
        fn whole_revisions_do_not_repeat_already_entered_audio() {
            let mut window = TranscriptWindow::default();
            window.update(words("hello"), 16_000, true);
            assert_eq!(window.update(words("merhaba next"), 32_000, true).committed, "next");
        }

        #[test]
        fn language_changes_preserve_agreed_pending_words_from_omitted_prefixes() {
            let mut window = TranscriptWindow::default();
            window.observe_language("en".into(), 16_000);
            window.update(words("If the network request fails"), 48_000, false);
            assert_eq!(window.update(words("If the network request fails I may stay"), 72_000, false).committed, "If the network request");
            window.observe_language("tr".into(), 72_000);
            assert_eq!(window.update(words("Aynı isteği tekrar gönder"), 80_000, false).committed, "fails");
            assert_eq!(window.update(words("Aynı isteği tekrar gönder"), 88_000, false).committed, "");
            assert_eq!(window.update(words("Aynı isteği tekrar gönder"), 96_000, false).committed, "Aynı isteği tekrar");
            assert_eq!(window.update(words("Aynı isteği tekrar gönder"), 96_000, false).committed, "");
            assert_eq!(window.update(words("Aynı isteği tekrar gönder"), 96_000, true).committed, "gönder");
            assert!(!window.missing_prefix);
            assert_eq!(window.update(words("Entirely revised old phrase next"), 104_000, true).committed, "next");
        }

        #[test]
        fn language_hints_follow_recent_speech_and_expire_with_its_audio() {
            let mut window = TranscriptWindow::default();
            window.observe_language("en".into(), 24_000);
            assert!(!window.multilingual);
            window.observe_language("tr".into(), 48_000);
            assert!(window.multilingual);
            window.observe_language("en".into(), 72_000);
            assert_eq!(window.detected_language.as_deref(), Some("tr"));
            window.observe_language("de".into(), 96_000);
            assert_eq!(window.detected_language.as_deref(), Some("de"));
            window.trim(96_000);
            assert_eq!(window.detected_language, None);
            window.observe_language("en".into(), 24_000);
            assert_eq!(window.detected_language.as_deref(), Some("en"));
        }

        #[test]
        fn restored_language_prefixes_do_not_repeat_previously_entered_words() {
            let mut window = TranscriptWindow::default();
            window.observe_language("en".into(), 40_000);
            assert_eq!(window.update(words("Please open the function and"), 40_000, true).committed, "Please open the function and");
            window.observe_language("tr".into(), 48_000);
            assert_eq!(window.update(words("Hata"), 48_000, true).committed, "Hata");
            assert_eq!(window.update(words("Hata kontrolünü"), 56_000, true).committed, "kontrolünü");
            assert_eq!(window.update(words("Please open the function and Hata kontrolünü ekle sonra"), 80_000, true).committed, "ekle sonra");
        }

        #[test]
        fn later_speech_is_not_mistaken_for_missing_overlap() {
            let confirmed = vec![Word { text: "go".into(), start: 0, end: 8_000 }];
            let later = vec![Word { text: "go".into(), start: 24_000, end: 32_000 }];
            assert_eq!(aligned_prefix(&later, &confirmed), 0);
            let confirmed = vec![Word { text: "hello".into(), start: 0, end: 32_000 }];
            let later = vec![Word { text: "continue".into(), start: 32_000, end: 36_000 }];
            assert_eq!(aligned_prefix(&later, &confirmed), 0);
        }

        #[test]
        fn retimed_overlap_does_not_repeat_words_after_an_audio_cut() {
            let confirmed = words("into the terminal as I");
            let mut revised = words("into the terminal as I speak");
            for word in &mut revised[2..] {
                word.start += 16_000;
                word.end += 16_000;
            }
            assert_eq!(aligned_prefix(&revised, &confirmed), 5);
        }

        #[test]
        fn recent_revisions_and_incomplete_words_wait_for_confirmation() {
            let mut window = TranscriptWindow::default();
            assert_eq!(window.update(words("Please write this"), 40_000, false).committed, "");
            assert_eq!(window.update(words("Please write the sentence"), 48_000, false).committed, "Please write");
            assert_eq!(window.update(words("Please write the sentence here"), 56_000, false).committed, "");
            assert_eq!(window.update(words("Please write this sentence here"), 56_000, false).committed, "");
            assert_eq!(window.update(words("Please write this sentence here now"), 56_000, false).committed, "");
            assert_eq!(window.update(words("Please write this sentence here now"), 56_000, false).committed, "this sentence here");
        }

        #[test]
        fn retained_audio_overlap_does_not_repeat_entered_words() {
            let mut window = TranscriptWindow::default();
            window.update(words("one two three four five six seven eight"), 80_000, false);
            assert_eq!(window.update(words("one two three four five six seven eight nine"), 88_000, false).committed, "one two three four five six seven");
            window.trim(32_000);
            assert_eq!(window.update(words("five six seven eight nine ten"), 64_000, false).committed, "eight");
            assert_eq!(window.update(words("five six seven eight nine ten"), 64_000, true).committed, "nine ten");
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
            let realtime = std::env::var_os("PZZA_DICTATION_TEST_REALTIME").is_some();
            let started = Instant::now();
            while offset < samples.len() {
                // In live capture, audio also arrives while inference is running.
                // Exercise that cadence as well as deterministic quarter-second steps.
                let end = if realtime {
                    let available = (started.elapsed().as_secs_f64() * 16_000.0) as usize;
                    if available.saturating_sub(offset) < 4_000 && available < samples.len() {
                        std::thread::sleep(Duration::from_millis(15));
                        continue;
                    }
                    available.min(samples.len())
                } else { (offset + 4_000).min(samples.len()) };
                capture.samples.lock().unwrap().extend_from_slice(&samples[offset..end]);
                offset = end;
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
            engine.recognize(&samples, language, &capture, false).unwrap();
            capture.cancel.store(false, Ordering::Release);
            engine.recognize(&samples, language, &capture, false).unwrap();
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
        let capture = Arc::new(Capture::new(id));
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
