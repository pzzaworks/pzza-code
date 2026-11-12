#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    id: String,
    name: String,
    is_default: bool,
    // Connection type, used to keep dictation off Bluetooth microphones.
    built_in: bool,
    bluetooth: bool,
}

#[cfg(target_os = "macos")]
mod native {
    use super::InputDevice;
    use coreaudio::audio_unit::{
        audio_format::LinearPcmFlags, macos_helpers::{audio_unit_from_device_id, get_audio_device_ids},
        Element, SampleFormat, Scope, StreamFormat,
    };
    use objc2_core_audio::{
        kAudioDevicePropertyDeviceIsAlive, kAudioDevicePropertyDeviceUID, kAudioDevicePropertyStreams,
        kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice, kAudioDevicePropertyTransportType,
        kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE, kAudioDeviceTransportTypeBuiltIn,
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
        Arc, Mutex, TryLockError,
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
        worker: Mutex<Option<std::thread::JoinHandle<()>>>,
        shutting_down: Arc<AtomicBool>,
        // When dictation last prepared, recorded or finished: the start of idleness.
        last_used: Mutex<Option<Instant>>,
        idle_watch: AtomicBool,
    }

    // The loaded model holds over a gigabyte. It is released after this long
    // without dictation and loaded again on the next use (the microphone
    // records meanwhile, so nothing said is lost).
    const IDLE_RELEASE: Duration = Duration::from_secs(10 * 60);
    const IDLE_CHECK: Duration = Duration::from_secs(30);

    /// Whether an idle model may be released: never while a recording or its
    /// worker runs, nor before IDLE_RELEASE has passed since the last use.
    fn idle_release_due(recording: bool, last_used: Option<Instant>, now: Instant, idle: Duration) -> bool {
        !recording && last_used.is_none_or(|at| now.saturating_duration_since(at) >= idle)
    }

    impl SpeechState {
        fn touch(&self) {
            if let Ok(mut last_used) = self.last_used.lock() {
                *last_used = Some(Instant::now());
            }
        }

        /// Drops the loaded model when dictation has been idle for `idle`.
        /// Every lock is only tried: a recording starting, a model loading or
        /// a decode running all make this wait for a later check. Returns
        /// whether the model was released.
        fn release_if_idle(&self, now: Instant, idle: Duration) -> bool {
            if self.shutting_down.load(Ordering::Acquire) {
                return false;
            }
            // speech_start claims `active` before anything records, so holding
            // it until the context is claimed keeps a recording out meanwhile.
            let Ok(active) = self.active.try_lock() else { return false };
            let Ok(worker) = self.worker.try_lock() else { return false };
            let Ok(mut context) = self.context.try_lock() else { return false };
            let recording = active.is_some() || worker.as_ref().is_some_and(|worker| !worker.is_finished());
            // Read under the context lock: a preparation marks its use before
            // letting go of it, so a model that just loaded is never taken.
            let last_used = self.last_used.lock().map(|at| *at).unwrap_or(Some(now));
            if !idle_release_due(recording, last_used, now, idle) {
                return false;
            }
            drop(worker);
            drop(active);
            // Freed under the context lock: a recording that starts now loads
            // a fresh model only after this one is gone.
            let engine = context.take();
            let released = engine.is_some();
            drop(engine);
            drop(context);
            released
        }
    }

    fn watch_idle(app: &AppHandle) {
        let state = app.state::<SpeechState>();
        if state.idle_watch.swap(true, Ordering::AcqRel) {
            return;
        }
        let watcher = app.clone();
        let started = std::thread::Builder::new().name("dictation-idle".into()).spawn(move || loop {
            std::thread::sleep(IDLE_CHECK);
            let state = watcher.state::<SpeechState>();
            if state.shutting_down.load(Ordering::Acquire) {
                return;
            }
            if state.release_if_idle(Instant::now(), IDLE_RELEASE) {
                crate::voice_log::log(&watcher, "dictation model released after being idle; it loads again on the next use");
            }
        });
        if started.is_err() {
            state.idle_watch.store(false, Ordering::Release);
        }
    }

    impl SpeechState {
        // Never hold the event loop while inference or CoreAudio finishes.
        // A timeout leaves the engine owned and exit disallowed, not leaked
        // into Metal's process-global destructor (which asserts on live buffers).
        pub fn shutdown(&self, timeout: Duration) -> Result<(), String> {
            self.shutting_down.store(true, Ordering::Release);
            let deadline = Instant::now() + timeout;
            if let Some(capture) = self.active.lock().map_err(|_| "Speech session lock failed")?.as_ref() {
                capture.cancel.store(true, Ordering::Release);
                capture.stop.store(true, Ordering::Release);
            }
            let mut worker = self.worker.lock().map_err(|_| "Speech worker lock failed")?;
            while worker.as_ref().is_some_and(|worker| !worker.is_finished()) {
                if Instant::now() >= deadline {
                    return Err("Dictation is still stopping; native resources remain protected".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            if let Some(worker) = worker.take() {
                worker.join().map_err(|_| "Dictation worker failed while stopping")?;
            }
            drop(worker);
            loop {
                match self.context.try_lock() {
                    Ok(mut context) => {
                        // Explicitly release the decoder and context before C++
                        // atexit finalization. Tauri exits without dropping state.
                        context.take();
                        return Ok(());
                    }
                    Err(TryLockError::Poisoned(_)) => return Err("Speech model lock failed".into()),
                    Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(TryLockError::WouldBlock) => return Err("Speech preparation is still stopping; native resources remain protected".into()),
                }
            }
        }
    }

    struct Engine {
        context: WhisperContext,
        decoder: WhisperState,
        // The latest language decided with confidence. It outlives utterances and
        // recordings, but only as the first decode's guess: each utterance's own
        // audio decides its language before any of its words are typed.
        spoken_language: Option<String>,
    }

    impl Engine {
        fn load(model: &Path, cancel: Arc<AtomicBool>) -> Result<Self, String> {
            let mut parameters = WhisperContextParameters::default();
            parameters.flash_attn(true);
            let context = WhisperContext::new_with_params(
                model.to_str().ok_or("Speech model path is not valid UTF-8")?, parameters,
            ).map_err(|error| format!("Could not load the dictation model: {error}"))?;
            let decoder = context.create_state().map_err(|error| format!("Could not create speech decoder: {error}"))?;
            let mut engine = Self { context, decoder, spoken_language: None };
            // Compile the live decoder's Metal kernels during preparation so
            // the first spoken words do not pay that startup cost.
            let warmup = Arc::new(Capture { cancel, ..Capture::new(String::new()) });
            engine.recognize(&[0.0; 16_000], "en", &warmup, audio_context(16_000), false)?;
            Ok(engine)
        }

        fn recognize(&mut self, audio: &[f32], language: &str, capture: &Arc<Capture>, context: i32, fallback: bool) -> Result<(), String> {
            let mut params = recognition_params(language, capture);
            // Temperature fallback re-decodes a weak hypothesis up to five more
            // times. Live passes are superseded a quarter-second later anyway, so
            // only the final flush pays for it; previews keep a steady cadence.
            if !fallback { params.set_temperature_inc(0.0); }
            params.set_audio_ctx(context);
            let result = self.decoder.full(params, audio);
            if capture.cancel.load(Ordering::Acquire) { return Ok(()); }
            if let Err(error) = result {
                self.decoder = self.context.create_state().map_err(|error| format!("Could not reset speech decoder: {error}"))?;
                return Err(format!("Speech recognition could not process the audio: {error}. Click the microphone to retry."));
            }
            Ok(())
        }

        // Reads the spoken language from the encoder output the last recognition
        // left in the decoder state. This is whisper.cpp's own detector (one
        // start-of-transcript decoder step, softmax over language tokens) minus
        // its separate encoder pass, which cost as much as a whole live decode.
        // Returns every language's probability, so the caller can restrict the
        // decision to supported and preferred languages. It does not disturb
        // the segments of that recognition.
        fn language_probabilities(&mut self) -> Result<Vec<(&'static str, f32)>, String> {
            self.decoder.decode(&[self.context.token_sot()], 0, decoder_threads() as usize)
                .map_err(|error| format!("Could not detect the spoken language: {error}"))?;
            let logits = self.decoder.get_logits().map_err(|error| format!("Could not detect the spoken language: {error}"))?;
            let languages: Vec<(&'static str, f32)> = (0..=whisper_rs::get_lang_max_id()).filter_map(|id| {
                let logit = logits.get(self.context.token_lang(id) as usize).copied()?;
                whisper_rs::get_lang_str(id).map(|language| (language, logit))
            }).collect();
            let peak = languages.iter().map(|(_, logit)| *logit).fold(f32::NEG_INFINITY, f32::max);
            if !peak.is_finite() { return Ok(Vec::new()); }
            let total: f32 = languages.iter().map(|(_, logit)| (logit - peak).exp()).sum();
            Ok(languages.into_iter().map(|(language, logit)| (language, (logit - peak).exp() / total)).collect())
        }
    }

    // The language a stretch of speech is first decoded in, before its own
    // audio is checked: what this user spoke last if it is one of their
    // languages, else their main language.
    fn first_guess(engine: &Engine, capture: &Capture) -> String {
        engine.spoken_language.as_deref()
            .filter(|language| capture.languages.is_empty() || capture.languages.iter().any(|own| own == language))
            .or(capture.languages.first().map(String::as_str))
            .unwrap_or("en").to_owned()
    }

    // The language this recognition's audio was spoken in, from the
    // detector's view of the same encoder pass (one decoder step).
    fn heard_language(engine: &mut Engine, capture: &Capture) -> Option<super::LanguageChoice> {
        // An inconclusive detector must not interrupt otherwise usable recognition.
        let probabilities = engine.language_probabilities().ok()?;
        // Continuity: a close call keeps the language of the last confident utterance.
        super::choose_language(&probabilities, &capture.languages, engine.spoken_language.as_deref())
    }

    // The share of probability at which an utterance's language is settled:
    // live words may be typed in it and it hints the following decodes.
    const SETTLED_SHARE: f32 = 0.8;

    // New audio (16 kHz samples) between two hypotheses that makes their
    // agreement enough to type a word without a third.
    const INDEPENDENT_AUDIO: usize = 16_000;

    fn decoder_threads() -> i32 {
        std::thread::available_parallelism().map(|n| n.get().min(8) as i32).unwrap_or(4)
    }

    fn audio_context(samples: usize) -> i32 {
        // Each encoder frame covers 20 ms, with two seconds of padding. Mixed
        // speech uses the full context to avoid losing short language switches.
        (samples.div_ceil(320).saturating_add(100).div_ceil(128) * 128).clamp(768, 1500) as i32
    }

    fn decode_context(samples: usize, multilingual: bool) -> i32 {
        if multilingual { 1500 } else { audio_context(samples) }
    }

    #[cfg(test)]
    #[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PassStats {
        audio_samples: usize,
        audio_ctx: i32,
        detect_ms: Option<f64>,
        decode_ms: f64,
        multilingual: bool,
        finalizing: bool,
        language: String,
        // Text this pass typed, and the detector's verdict on its audio.
        committed: String,
        heard: Option<(String, f32)>,
        redecoded: bool,
    }

    unsafe extern "C" fn recording_cancelled(data: *mut std::ffi::c_void) -> bool {
        // The caller keeps this Arc allocation alive throughout synchronous decoding.
        // Only an atomic flag is read, including when the engine calls from a worker thread.
        let capture = unsafe { &*data.cast::<Capture>() };
        #[cfg(test)]
        {
            capture.decoding.store(true, Ordering::Release);
            // Hold the opt-in regression at a real native cancellation point
            // until OS Quit arrives, rather than racing a short GPU decode.
            if capture.wait_for_cancellation {
                let deadline = Instant::now() + Duration::from_secs(5);
                while !capture.cancel.load(Ordering::Acquire) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
        let cancelled = capture.cancel.load(Ordering::Acquire);
        #[cfg(test)]
        if cancelled { capture.cancellation_seen.store(true, Ordering::Release); }
        cancelled
    }

    fn recognition_params<'a>(language: &'a str, capture: &'a Arc<Capture>) -> FullParams<'a, 'a> {
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(decoder_threads());
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
        // Dictation ends on its own after this much quiet (silence_stop_due).
        silence_stop_ms: Option<usize>,
        // "My languages", main language first: detection keeps to these.
        languages: Vec<String>,
        // Audio samples per language decided with confidence, for the final event.
        heard: Mutex<Vec<(String, usize)>>,
        stop: AtomicBool,
        cancel: Arc<AtomicBool>,
        closed: AtomicBool,
        samples: Mutex<Vec<f32>>,
        rate: Mutex<u32>,
        error: Mutex<Option<String>>,
        received: AtomicBool,
        captured_samples: AtomicUsize,
        // The voice activity model's speech probability for each 20 ms block
        // of captured audio, counted from the recording's start (None where
        // the model was not available). Recognition reads it to decode and
        // type only what was spoken.
        voice: Mutex<Vec<Option<f32>>>,
        finished: AtomicBool,
        #[cfg(test)]
        decoding: AtomicBool,
        #[cfg(test)]
        cancellation_seen: AtomicBool,
        #[cfg(test)]
        wait_for_cancellation: bool,
        #[cfg(test)]
        stats: Mutex<Vec<PassStats>>,
    }

    impl Capture {
        fn new(id: String) -> Self {
            Self {
                id, silence_stop_ms: None,
                languages: Vec::new(), heard: Mutex::new(Vec::new()),
                stop: AtomicBool::new(false), cancel: Arc::new(AtomicBool::new(false)),
                closed: AtomicBool::new(false), samples: Mutex::new(Vec::new()),
                rate: Mutex::new(16_000), error: Mutex::new(None), received: AtomicBool::new(false),
                captured_samples: AtomicUsize::new(0), voice: Mutex::new(Vec::new()), finished: AtomicBool::new(false),
                #[cfg(test)]
                decoding: AtomicBool::new(false),
                #[cfg(test)]
                cancellation_seen: AtomicBool::new(false),
                #[cfg(test)]
                wait_for_cancellation: false,
                #[cfg(test)]
                stats: Mutex::new(Vec::new()),
            }
        }

        /// Records the speech probabilities of consecutive 20 ms blocks,
        /// the first of which is block `first` of the recording.
        fn record_voice(&self, first: usize, probabilities: &[Option<f32>]) {
            if let Ok(mut voice) = self.voice.lock() {
                voice.resize(first, None);
                voice.extend_from_slice(probabilities);
            }
        }

        /// The speech probability of each 20 ms frame of a decode window of
        /// `samples` captured samples that starts `drained` samples into the
        /// recording; None where the voice model has not analyzed the audio.
        fn window_voice(&self, drained: usize, samples: usize, rate: u32) -> Vec<Option<f32>> {
            let rate = rate.max(1) as usize;
            let block = (rate / 50).max(1);
            let Ok(voice) = self.voice.lock() else { return Vec::new(); };
            (0..(samples * 50).div_ceil(rate))
                .map(|frame| voice.get((drained + frame * rate / 50) / block).copied().flatten())
                .collect()
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
            let transport = property::<u32>(object, kAudioDevicePropertyTransportType).unwrap_or(0);
            if valid_input_device_id(&id) { devices.push((object, InputDevice { id, name, is_default: object == default, built_in: transport == kAudioDeviceTransportTypeBuiltIn, bluetooth: is_bluetooth(transport) })); }
        }
        Ok(devices)
    }


    fn is_bluetooth(transport: u32) -> bool {
        transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE
    }

    // Whether the system output (speakers or headphones) is a Bluetooth device.
    fn output_is_bluetooth() -> bool {
        property::<u32>(kAudioObjectSystemObject as u32, kAudioHardwarePropertyDefaultOutputDevice)
            .and_then(|device| property::<u32>(device, kAudioDevicePropertyTransportType))
            .is_ok_and(is_bluetooth)
    }

    // Opening a Bluetooth headset's microphone switches it to its call profile,
    // which makes everything it plays sound muffled and records at telephone
    // quality (8 to 16 kHz), which recognition handles poorly. Dictation
    // therefore uses the built-in microphone when the default input or the
    // output is Bluetooth, unless the user picked one explicitly.
    fn select_voice_input(devices: &[(u32, InputDevice)], id: Option<&str>, output_bluetooth: bool) -> Result<u32, String> {
        if id.is_some() {
            return select_input_device(devices, id);
        }
        let default_bluetooth = devices.iter().any(|(_, device)| device.is_default && device.bluetooth);
        if default_bluetooth || output_bluetooth {
            if let Some((object, _)) = devices.iter().find(|(_, device)| device.built_in && !device.bluetooth) {
                return Ok(*object);
            }
        }
        select_input_device(devices, None)
    }

    /// The microphone dictation uses: the explicit choice, or the
    /// Bluetooth-safe default.
    fn voice_input_device(id: Option<&str>) -> Result<u32, String> {
        select_voice_input(&input_devices()?, id, output_is_bluetooth())
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

    // The event stream dictation reports on, and the longest it records.
    const CHANNEL: &str = "dictation";
    const MAX_RECORDING: Duration = Duration::from_secs(300);

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
        // The language heard most with confidence in a finished recording.
        #[serde(skip_serializing_if = "Option::is_none")]
        language: Option<&'a str>,
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
                CHANNEL,
                Event {
                    id: &capture.id,
                    kind,
                    text,
                    level,
                    error,
                    active: None,
                    language: None,
                },
            );
        }
    }

    fn emit_processing(app: &AppHandle, capture: &Capture, active: bool) {
        emit_flag(app, capture, "processing", active);
    }

    fn emit_flag(app: &AppHandle, capture: &Capture, kind: &str, active: bool) {
        if !capture.cancel.load(Ordering::Acquire) {
            let _ = app.emit(CHANNEL, Event {
                id: &capture.id, kind, text: None, level: None, error: None, active: Some(active), language: None,
            });
        }
    }

    fn prepare(app: &AppHandle) -> Result<(), String> {
        let state = app.state::<SpeechState>();
        let mut context = state
            .context
            .lock()
            .map_err(|_| "Speech model lock failed")?;
        if state.shutting_down.load(Ordering::Acquire) {
            return Err("The application is shutting down".into());
        }
        if context.is_none() {
            whisper_rs::install_logging_hooks();
            let path = crate::speech_model::model_path(app)?;
            let engine = Engine::load(&path, state.shutting_down.clone())?;
            if state.shutting_down.load(Ordering::Acquire) {
                return Err("The application is shutting down".into());
            }
            *context = Some(engine);
        }
        state.touch();
        drop(context);
        watch_idle(app);
        Ok(())
    }

    #[tauri::command]
    pub async fn speech_prepare(app: AppHandle) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || prepare(&app))
            .await
            .map_err(|_| "Speech preparation failed".to_string())?
    }

    fn input(device: u32, capture: Arc<Capture>) -> Result<(crate::voice_io::TappedUnit, u32), String> {
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
        let stream = crate::voice_io::TappedUnit::new(stream, channels as u32, move |buffer: &[f32]| {
            if capture.stop.load(Ordering::Acquire) { return; }
            if !buffer.is_empty() { capture.received.store(true, Ordering::Release); }
            if let Ok(mut samples) = capture.samples.lock() {
                let before = samples.len();
                for frame in buffer.chunks_exact(channels) {
                    if samples.len() >= maximum {
                        if let Ok(mut error) = capture.error.lock() { *error = Some("Recognition could not keep up with the microphone. Try a shorter recording.".into()); }
                        capture.stop.store(true, Ordering::Release);
                        break;
                    }
                    samples.push(frame.iter().sum::<f32>() / channels as f32);
                }
                capture.captured_samples.fetch_add(samples.len() - before, Ordering::Release);
            }
        })?;
        Ok((stream, rate))
    }

    fn capture_audio(app: AppHandle, capture: Arc<Capture>, input_device_id: Option<String>) {
        let result = (|| {
            let device = voice_input_device(input_device_id.as_deref())?;
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
            let mut activity = ActivityMonitor::new(&app, &capture, rate);
            while !capture.stop.load(Ordering::Acquire)
                && start.elapsed() < MAX_RECORDING
            {
                if capture.received.swap(false, Ordering::AcqRel) { last_audio = Instant::now(); }
                if property::<u32>(device, kAudioDevicePropertyDeviceIsAlive).unwrap_or(0) == 0
                    || last_audio.elapsed() > Duration::from_secs(3) {
                    return Err("Microphone stopped providing audio. Check your selected input and microphone permission, then try again.".into());
                }
                if activity.update(&app, &capture) {
                    // Everything said is already in the buffer; finalization
                    // below transcribes it as after Stop.
                    break;
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
            // The final pass decodes everything up to the last sample, so the
            // voice model hears that too: its verdict decides what is typed.
            activity.update(&app, &capture);
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

    /// Follows the dictation microphone in the capture thread, apart from
    /// recognition: reports when speech starts and stops (the caret's live
    /// indicator) and decides when silence ends the recording. The voice
    /// activity model loads on its own thread, so the microphone never waits
    /// for it; until it is ready, the level alone decides.
    struct ActivityMonitor {
        activity: super::DictationActivity,
        vad: Option<crate::voice_vad::Vad>,
        loading: Option<std::sync::mpsc::Receiver<Result<crate::voice_vad::Vad, String>>>,
        rate: usize,
        // Captured samples analyzed so far, counted from the recording's start.
        analyzed: usize,
    }

    impl ActivityMonitor {
        fn new(app: &AppHandle, capture: &Arc<Capture>, rate: u32) -> Self {
            let (sender, receiver) = std::sync::mpsc::channel();
            let loader_app = app.clone();
            let loader_capture = capture.clone();
            std::thread::spawn(move || {
                let vad = crate::voice_vad::model_path(&loader_app).and_then(|path| {
                    if loader_capture.stop.load(Ordering::Acquire) { return Err("Dictation ended".into()); }
                    crate::voice_vad::Vad::load(&path)
                });
                let _ = sender.send(vad);
            });
            Self { activity: Default::default(), vad: None, loading: Some(receiver), rate: rate as usize, analyzed: 0 }
        }

        /// Analyzes the audio captured since the last call. Returns true when
        /// silence should end the recording.
        fn update(&mut self, app: &AppHandle, capture: &Capture) -> bool {
            if let Some(result) = self.loading.as_ref().and_then(|receiver| receiver.try_recv().ok()) {
                self.loading = None;
                match result {
                    Ok(vad) => self.vad = Some(vad),
                    Err(error) => crate::voice_log::log(app, format!("dictation voice activity unavailable, using the level alone: {error}")),
                }
            }
            // Whole 20 ms blocks, which resample to exactly one 16 kHz frame
            // at every rate divisible by 50 (44.1 and 48 kHz included).
            let block = (self.rate / 50).max(1);
            let (from, fresh): (usize, Vec<f32>) = {
                let Ok(samples) = capture.samples.lock() else { return false; };
                // Recognition drains consumed audio from the front.
                let drained = capture.captured_samples.load(Ordering::Acquire).saturating_sub(samples.len());
                let from = self.analyzed.max(drained);
                let whole = (drained + samples.len()).saturating_sub(from) / block * block;
                self.analyzed = from + whole;
                (from, samples[from - drained..from - drained + whole].to_vec())
            };
            let mut voice = Vec::with_capacity(fresh.len() / block);
            for frame in super::resample(&fresh, self.rate as u32).chunks_exact(super::DictationActivity::FRAME) {
                let energy = frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32;
                let probability = match self.vad.as_mut().map(|vad| vad.push(frame)) {
                    Some(Ok(probability)) => Some(probability),
                    Some(Err(error)) => {
                        crate::voice_log::log(app, format!("dictation voice activity failed, using the level alone: {error}"));
                        self.vad = None;
                        None
                    }
                    None => None,
                };
                voice.push(probability);
                if let Some(hearing) = self.activity.frame(energy, probability) {
                    emit_flag(app, capture, "voice", hearing);
                }
            }
            capture.record_voice(from / block, &voice);
            self.activity.stop_due(capture.silence_stop_ms)
        }
    }

    struct Transcript {
        preview: String,
        committed: String,
        consumed: usize,
        #[cfg(test)]
        raw_words: String,
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
        // Audio length the previous hypothesis was decoded from.
        previous_duration: usize,
        confirmed: Vec<Word>,
        detected_language: Option<String>,
        // The latest unsure decision on this utterance, its next decode guess.
        tentative_language: Option<String>,
        // Holds live words while the utterance's language is uncertain.
        language_pending: bool,
        // Consecutive language checks that agreed with their decode language.
        agreeing_checks: u8,
        language_checked_at: usize,
        language_hint_until: usize,
        english_since: Option<usize>,
        multilingual: bool,
        language_changed: bool,
        language_transition: bool,
        missing_prefix: bool,
        boundary_suffix: Vec<Word>,
    }

    impl TranscriptWindow {
        fn update(&mut self, words: Vec<Word>, duration: usize, complete: bool) -> Transcript {
            let words = if complete && words.is_empty() {
                let count = self.previous.iter().zip(&self.earlier)
                    .take_while(|(word, old)| same_word(&word.text, &old.text)).count();
                self.previous[..count].to_vec()
            } else { words };
            let language_changed = mem::take(&mut self.language_changed);
            let language_transition = mem::take(&mut self.language_transition);
            let omitted_prefix = language_changed && !self.confirmed.is_empty()
                && !words.is_empty() && aligned_prefix(&words, &self.confirmed) == 0;
            self.missing_prefix |= omitted_prefix;
            // Recovery belongs to the boundary's old hypotheses. On subsequent
            // passes those hypotheses already describe the new language and
            // must go through normal word confirmation instead.
            let carried = if omitted_prefix && self.boundary_suffix.is_empty() {
                self.finish_missing_prefix(&words, duration)
            } else { String::new() };
            // Enter agreed recovery first so only the still-uncertain remainder
            // can hold later words at this boundary.
            if language_transition && !complete {
                self.remember_boundary_suffix(&words, duration);
            }
            if self.missing_prefix && aligned_prefix(&words, &self.confirmed) > 0 {
                self.missing_prefix = false;
            }
            let entered = self.entered(&words);
            let pending = &words[entered..];
            if self.boundary_suffix_is_restored(pending) {
                self.boundary_suffix.clear();
            }
            let previous = &self.previous[self.entered(&self.previous)..];
            let earlier = &self.earlier[self.entered(&self.earlier)..];
            // A word is typed once consecutive hypotheses agree on it. Two
            // suffice when they were decoded from clearly different audio (a
            // busy machine decodes seldom); passes close together need a
            // third, so a word is not typed on what is nearly the same evidence.
            let independent = duration.saturating_sub(self.previous_duration) >= INDEPENDENT_AUDIO;
            let count = if complete { pending.len() } else if !self.boundary_suffix.is_empty() || self.language_pending { 0 } else {
                pending.iter().enumerate().take_while(|(index, word)| {
                    // Keep the newest half-second and incomplete last word open.
                    word.end.saturating_add(8_000) <= duration
                        && previous.len() > index + 1
                        && same_word(&previous[*index].text, &word.text)
                        && (independent || earlier.get(*index).is_none_or(|old| same_word(&old.text, &word.text)))
                }).count()
            };
            let transcript = Transcript {
                preview: word_text(pending),
                committed: [carried, word_text(&pending[..count])].into_iter()
                    .filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" "),
                consumed: 0,
                #[cfg(test)]
                raw_words: String::new(),
            };
            // Rebase already entered audio onto this hypothesis. A correction to
            // an old word must not prevent unrelated later words from being typed.
            if count > 0 {
                self.confirm(&words, entered, count);
                self.missing_prefix = false;
            }
            if !words.is_empty() {
                self.earlier = mem::replace(&mut self.previous, words);
                self.previous_duration = duration;
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
            // A decode can retime the retained audio by more than a word. When
            // the entered words still read in order, follow them: the timing
            // frontier below would treat retimed new words as already typed.
            let (lexical, matched) = alignment(words, &self.confirmed, false);
            if matched >= self.confirmed.len().min(2) && lexical > 0 { return lexical; }
            // Without a language change, a wholly revised hypothesis still
            // represents the same audio. Preserve the already entered frontier.
            self.confirmed.last().map(|last| words.iter()
                .take_while(|word| word.end <= last.end).count()).unwrap_or(0)
        }

        fn remember_boundary_suffix(&mut self, words: &[Word], duration: usize) {
            if !self.boundary_suffix.is_empty() { return; }
            let previous = &self.previous[self.entered(&self.previous)..];
            let current = &words[self.entered(words)..];
            let Some(anchor) = current.first() else { return; };
            let position = previous.iter().position(|word| same_timed_word(word, anchor)).or_else(|| {
                if self.missing_prefix {
                    previous.iter().position(|word| same_word(&word.text, &anchor.text))
                } else { None }
            });
            let Some(position) = position else { return; };
            if position == 0 || previous[position - 1].end.saturating_add(8_000) > duration { return; }
            // A detector transition deleted one or more settled, still-unentered
            // words immediately before an acoustic anchor. Later output cannot
            // insert them ahead of newly typed words, so wait for recovery.
            self.boundary_suffix = previous[..position].to_vec();
        }

        fn boundary_suffix_is_restored(&self, pending: &[Word]) -> bool {
            !self.boundary_suffix.is_empty()
                && pending.len() >= self.boundary_suffix.len()
                && self.boundary_suffix.iter().zip(pending)
                    .all(|(expected, word)| same_word(&expected.text, &word.text))
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
            self.previous_duration = self.previous_duration.saturating_sub(samples);
            self.language_checked_at = self.language_checked_at.saturating_sub(samples);
            self.language_hint_until = self.language_hint_until.saturating_sub(samples);
            self.english_since = self.english_since.map(|start| start.saturating_sub(samples));
            if self.language_hint_until == 0 {
                self.detected_language = None;
                self.multilingual = false;
            }
            for words in [&mut self.earlier, &mut self.previous, &mut self.confirmed, &mut self.boundary_suffix] {
                words.retain(|word| word.end > samples);
                for word in words {
                    word.start = word.start.saturating_sub(samples);
                    word.end = word.end.saturating_sub(samples);
                }
            }
        }

        // Records this pass's language check against the language its words
        // were decoded in. Live words wait until two checks in a row find that
        // language settled in the utterance's own audio; any later check that
        // disagrees or is unsure holds them again (and checks every pass), so a
        // guess or an early misdetection never types a translation.
        fn record_language_check(&mut self, choice: &super::LanguageChoice, decode_language: &str) {
            self.tentative_language = Some(choice.language.clone());
            let agrees = choice.language == decode_language && choice.share >= SETTLED_SHARE;
            self.agreeing_checks = if agrees { self.agreeing_checks.saturating_add(1) } else { 0 };
            self.language_pending = self.agreeing_checks < 2;
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
                let transition = self.detected_language.as_ref().is_some_and(|current| current != &language);
                self.language_changed |= self.detected_language.as_ref() != Some(&language);
                self.language_transition |= transition;
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
        alignment(words, confirmed, true).0
    }

    // The prefix of `words` that covers `confirmed`, and how many words matched.
    // `timed` requires matching words to share their audio (see aligned_prefix).
    fn alignment(words: &[Word], confirmed: &[Word], timed: bool) -> (usize, usize) {
        let Some(last) = confirmed.last() else { return (0, 0); };
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
                let equal = (!timed || overlaps || (nearby && diagonal_matches > 0) || diagonal_matches >= 2)
                    && same_word(&old.text, &word.text);
                let substitution = if equal { 0 } else if overlaps || !timed { 1 } else { 2 };
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
        let index = (0..=words.len()).filter(|index| *index == 0 || matches[*index] > 0).min_by_key(|index| {
            let end = index.checked_sub(1).map(|i| words[i].end).unwrap_or(0);
            (costs[*index], std::cmp::Reverse(matches[*index]), end.abs_diff(last.end))
        }).unwrap_or(0);
        (index, matches[index])
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
        let (samples, drained) = {
            let samples = capture.samples.lock().map_err(|_| "Audio lock failed")?;
            // Consistent under the lock: the microphone counts what it appends while holding it.
            let drained = capture.captured_samples.load(Ordering::Acquire).saturating_sub(samples.len());
            (samples.iter().take(rate as usize * 27).copied().collect::<Vec<f32>>(), drained)
        };
        let voice = capture.window_voice(drained, samples.len(), rate);
        let state = app.state::<SpeechState>();
        let mut context = state.context.lock().map_err(|_| "Speech model lock failed")?;
        let engine = context.as_mut().ok_or("Speech model is not loaded")?;
        emit_processing(app, capture, true);
        let result = transcribe_samples(engine, capture, language, window, &samples, &voice, rate, finalizing);
        emit_processing(app, capture, false);
        result
    }

    fn transcribe_samples(
        engine: &mut Engine,
        capture: &Arc<Capture>,
        language: &str,
        window: &mut TranscriptWindow,
        samples: &[f32],
        // The voice model's speech probability per 20 ms frame of `samples`
        // (Capture::window_voice); missing or None frames fall back to the level.
        voice: &[Option<f32>],
        rate: u32,
        finalizing: bool,
    ) -> Result<Transcript, String> {
        let mut audio = super::resample(samples, rate);
        super::normalize_level(&mut audio);
        let boundary = utterance_boundary(&audio);
        let utterance_samples = boundary.map(|end| end * rate as usize / 16_000).unwrap_or(samples.len());
        if let Some(end) = boundary { audio.truncate(end); }
        let speech = super::SpeechMask::new(&audio, voice);
        if let Some(consumed) = unspoken_audio(window, &speech, audio.len(), boundary.map(|_| utterance_samples), samples.len(), rate, finalizing) {
            return Ok(Transcript {
                preview: String::new(),
                committed: String::new(),
                consumed,
                #[cfg(test)]
                raw_words: String::new(),
            });
        }
        let duration = audio.len();
        let commit_all = boundary.is_some() || finalizing || audio.len() >= 400_000;
        // Very short utterances still need a full decoder input frame.
        if audio.len() < 16_000 {
            audio.resize(16_000, 0.0);
        }
        #[cfg(test)]
        let mut detect_ms: Option<f64> = None;
        #[cfg(test)]
        let mut heard: Option<(String, f32)> = None;
        let automatic = language == "auto";
        // A confident hint for this utterance wins. Until one exists, decode in
        // this utterance's latest decision, else the user's likely language;
        // the pass's own audio then confirms or corrects that guess.
        let mut decode_language = if automatic {
            match window.detected_language.as_deref().or(window.tentative_language.as_deref()) {
                Some(language) => language.to_owned(),
                None => first_guess(engine, capture),
            }
        } else { language.to_owned() };
        let multilingual = window.multilingual;
        let context = decode_context(audio.len(), multilingual);
        #[cfg(test)]
        let decoding = Instant::now();
        engine.recognize(&audio, &decode_language, capture, context, finalizing)?;
        #[cfg(test)]
        let mut decode_ms = decoding.elapsed().as_secs_f64() * 1_000.0;
        if capture.cancel.load(Ordering::Acquire) {
            return Ok(Transcript {
                preview: String::new(), consumed: samples.len(), committed: String::new(),
                #[cfg(test)]
                raw_words: String::new(),
            });
        }
        let mut words = decoded_words(&engine.decoder, duration)?;
        #[cfg(test)]
        let mut redecoded = false;
        // Check every pass until the utterance has a confident language, every
        // pass that types a whole utterance, and periodically otherwise. The
        // detector reads this pass's own encoder output.
        let decision = if automatic && (commit_all || window.detected_language.is_none() || window.language_pending
            || duration.saturating_sub(window.language_checked_at) >= 24_000) {
            #[cfg(test)]
            let detecting = Instant::now();
            let decision = heard_language(engine, capture);
            window.language_checked_at = duration;
            #[cfg(test)]
            {
                detect_ms = Some(detecting.elapsed().as_secs_f64() * 1_000.0);
                heard = decision.as_ref().map(|choice| (choice.language.clone(), choice.share));
            }
            decision
        } else { None };
        // Whether this pass's words were decoded in a language other than the
        // one its audio was spoken in: such text is a translation.
        let mut mismatch = false;
        if let Some(choice) = &decision {
            mismatch = choice.language != decode_language;
            // A whole utterance is typed at once: decode it again in the spoken
            // language first, unless it already mixes languages under a hint,
            // which keeps its own switching rules. Live passes are not decoded
            // twice; their words are held and the next pass uses the decision.
            if mismatch && commit_all && !multilingual {
                #[cfg(test)]
                let decoding = Instant::now();
                engine.recognize(&audio, &choice.language, capture, context, finalizing)?;
                #[cfg(test)]
                { decode_ms += decoding.elapsed().as_secs_f64() * 1_000.0; }
                if capture.cancel.load(Ordering::Acquire) {
                    return Ok(Transcript {
                        preview: String::new(), consumed: samples.len(), committed: String::new(),
                        #[cfg(test)]
                        raw_words: String::new(),
                    });
                }
                words = decoded_words(&engine.decoder, duration)?;
                decode_language = choice.language.clone();
                #[cfg(test)]
                { redecoded = true; }
                mismatch = false;
            }
            if choice.confident {
                engine.spoken_language = Some(choice.language.clone());
                if commit_all {
                    if let Ok(mut heard) = capture.heard.lock() {
                        match heard.iter_mut().find(|(language, _)| *language == choice.language) {
                            Some((_, samples)) => *samples += duration,
                            None => heard.push((choice.language.clone(), duration)),
                        }
                    }
                }
            }
            window.record_language_check(choice, &decode_language);
        }
        window.language_pending = automatic && window.agreeing_checks < 2;
        // A hypothesis that skipped speech would type its end and lose what
        // came before. Typed audio is the usual cause (a window starting in a
        // cut word), so drop it, keeping the last typed word for alignment.
        let restart = window.confirmed.last().map(|word| word.start / 320 * 320).filter(|cut| *cut > 0 && *cut + 16_000 <= duration);
        if let Some(cut) = restart.filter(|_| skipped_speech(&words)) {
            if !commit_all {
                // Live: keep the last good preview and decode from the cut next time.
                let preview = word_text(&window.previous[window.entered(&window.previous)..]);
                window.trim(cut);
                return Ok(Transcript {
                    preview, committed: String::new(), consumed: cut * rate as usize / 16_000,
                    #[cfg(test)]
                    raw_words: word_text(&words),
                });
            }
            // Typing the whole utterance: decode its untyped part on its own.
            let mut tail = audio[cut..duration].to_vec();
            tail.resize(tail.len().max(16_000), 0.0);
            engine.recognize(&tail, &decode_language, capture, decode_context(tail.len(), multilingual), finalizing)?;
            if capture.cancel.load(Ordering::Acquire) {
                return Ok(Transcript {
                    preview: String::new(), consumed: samples.len(), committed: String::new(),
                    #[cfg(test)]
                    raw_words: String::new(),
                });
            }
            let mut retimed = decoded_words(&engine.decoder, duration - cut)?;
            for word in &mut retimed {
                word.start += cut;
                word.end += cut;
            }
            let characters = |list: &[Word]| list.iter().map(|word| word.text.chars().count()).sum::<usize>();
            if !skipped_speech(&retimed) || characters(&retimed) > characters(&words) {
                words = retimed;
            }
        }
        #[cfg(test)]
        let raw_words = word_text(&words);
        drop_unspoken(&mut words, &speech);
        #[cfg(test)]
        let mut transcript = Transcript { raw_words, ..window.update(words, duration, commit_all) };
        #[cfg(not(test))]
        let mut transcript = window.update(words, duration, commit_all);
        // Never preview a translation either.
        if mismatch { transcript.preview.clear(); }
        // A settled language hints the next decodes of this utterance.
        if let Some(choice) = decision.filter(|choice| choice.share >= SETTLED_SHARE && !commit_all) {
            window.observe_language(choice.language, duration);
        }
        #[cfg(test)]
        if let Ok(mut stats) = capture.stats.lock() {
            stats.push(PassStats {
                audio_samples: audio.len(), audio_ctx: decode_context(audio.len(), multilingual), detect_ms,
                decode_ms, multilingual, finalizing, language: decode_language,
                committed: transcript.committed.clone(), heard, redecoded,
            });
        }
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

    /// Whether a hypothesis skipped speech: whisper sometimes recognizes only
    /// the end of a long window and stretches those few words over all of it.
    /// A word other than the last that lasts over two seconds at under four
    /// characters a second is such a stretch; a long unspaced sentence in
    /// Chinese or Japanese reads faster than that.
    fn skipped_speech(words: &[Word]) -> bool {
        words.iter().rev().skip(1).any(|word| {
            let seconds = word.end.saturating_sub(word.start) as f32 / 16_000.0;
            seconds > 2.0 && (word.text.chars().count() as f32) < seconds * 4.0
        })
    }

    /// A pause after the last typed word (16 kHz samples) in which nothing is
    /// speech ends the utterance: its audio is let go, a little preroll kept.
    const UNSPOKEN_UTTERANCE_END: usize = 16_000;

    /// The decoder invents text from silence and noise ("Thank you.",
    /// "Altyazı M.K."), so a window is decoded only while something after
    /// the last typed word is speech: before anything is typed, the whole
    /// window; after that, the pause that follows the typed words, the final
    /// pass's leftover included. Returns None to decode, else the captured
    /// samples to let go without decoding (0 to wait for more audio).
    /// `duration` is the window's 16 kHz length, cut at `boundary` (the
    /// captured samples up to an utterance boundary) when there is one, and
    /// `captured` its length in captured samples.
    fn unspoken_audio(
        window: &mut TranscriptWindow,
        speech: &super::SpeechMask,
        duration: usize,
        boundary: Option<usize>,
        captured: usize,
        rate: u32,
        finalizing: bool,
    ) -> Option<usize> {
        let typed_until = window.confirmed.last().map_or(0, |word| word.end);
        if speech.speech_after(typed_until) {
            return None;
        }
        let consumed = if let Some(boundary) = boundary {
            // Audio after the boundary may already hold the next phrase.
            boundary
        } else if finalizing {
            captured
        } else if window.confirmed.is_empty() || duration.saturating_sub(typed_until) >= UNSPOKEN_UTTERANCE_END {
            // Keep a little preroll so a word beginning at this boundary is not lost.
            captured.saturating_sub(rate as usize / 5)
        } else {
            // A short pause after typed words: wait, keeping their context.
            0
        };
        // Whatever is let go was typed or unspoken: the utterance is over.
        if consumed > 0 { *window = TranscriptWindow::default(); }
        Some(consumed)
    }

    /// Drops words the decoder made up from audio without speech: every word
    /// with no speech within SpeechMask's margin, and, closer to speech, the
    /// decoder's well-known silence phrases where the voice model heard
    /// nothing at all in their audio. Text alone never removes a word.
    fn drop_unspoken(words: &mut Vec<Word>, speech: &super::SpeechMask) {
        words.retain(|word| speech.near_speech(word.start, word.end));
        let mut index = 0;
        while index < words.len() {
            let phrase = (1..=super::SILENCE_PHRASE_WORDS.min(words.len() - index)).rev().find(|&size| {
                let run = &words[index..index + size];
                run.iter().all(|word| speech.unspoken(word.start, word.end))
                    && super::silence_phrase(run.iter().map(|word| word.text.as_str()))
            });
            match phrase {
                Some(size) => { words.drain(index..index + size); }
                None => index += 1,
            }
        }
    }

    fn decoded_words(decoder: &WhisperState, duration: usize) -> Result<Vec<Word>, String> {
        let mut words: Vec<Word> = Vec::new();
        for segment in decoder.as_iter() {
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
        collapse_loops(&mut words);
        Ok(words)
    }

    /// Keeps one copy of a phrase of 1 to 8 words said three or more times in
    /// a row: the decoder sometimes loops ("bu konuda, bu konuda, bu konuda"),
    /// and live passes skip the fallback decode that would catch it. Real
    /// speech rarely repeats the same phrase three times back to back.
    fn collapse_loops(words: &mut Vec<Word>) {
        let mut index = 0;
        while index < words.len() {
            let repeat = (1..=8).find(|&size| {
                index + size * 3 <= words.len()
                    && (0..size).all(|offset| same_word(&words[index + offset].text, &words[index + size + offset].text) && same_word(&words[index + offset].text, &words[index + size * 2 + offset].text))
            });
            if let Some(size) = repeat {
                let mut end = index + size * 3;
                while end + size <= words.len() && (0..size).all(|offset| same_word(&words[index + offset].text, &words[end + offset].text)) {
                    end += size;
                }
                let last = words[end - 1].end;
                words.drain(index + size..end);
                words[index + size - 1].end = last;
            }
            index += 1;
        }
    }

    fn same_word(left: &str, right: &str) -> bool {
        let normalize = |word: &str| word.trim_matches(['.', ',', '!', '?', ';', ':']).to_lowercase();
        normalize(left) == normalize(right)
    }

    fn same_timed_word(left: &Word, right: &Word) -> bool {
        same_word(&left.text, &right.text)
            && left.start < right.end.saturating_add(1_600)
            && left.end.saturating_add(1_600) > right.start
    }

    #[cfg(test)]
    mod streaming_tests {
        use super::*;

        fn capture() -> Arc<Capture> {
            Arc::new(Capture::new("speech-test".into()))
        }

        #[test]
        fn decoder_loops_keep_one_copy_and_real_repeats_stay() {
            let words = |text: &str| text.split_whitespace().enumerate().map(|(index, word)| Word { text: word.into(), start: index * 1_000, end: index * 1_000 + 900 }).collect::<Vec<_>>();
            let text = |mut list: Vec<Word>| { collapse_loops(&mut list); word_text(&list) };
            assert_eq!(text(words("yaptıkları konuda, bu konuda, bu konuda, bu konuda, bu konuda, bu konuda, bu")), "yaptıkları konuda, bu");
            assert_eq!(text(words("Sürücü davranışı %100 Sürücü davranışı %100 Sürücü davranışı %100")), "Sürücü davranışı %100");
            // Twice is real speech ("evet evet", "çok çok iyi"), never collapsed.
            assert_eq!(text(words("evet evet tamam")), "evet evet tamam");
            assert_eq!(text(words("çok çok iyi oldu")), "çok çok iyi oldu");
            assert_eq!(text(words("Testleri çalıştır, sonra push et.")), "Testleri çalıştır, sonra push et.");
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

        fn timed_words(words: &[(&str, usize, usize)]) -> Vec<Word> {
            words.iter().map(|(text, start, end)| Word {
                text: (*text).into(), start: *start, end: *end,
            }).collect()
        }

        fn record_committed(committed: &mut Vec<String>, transcript: Transcript) {
            if !transcript.committed.is_empty() { committed.push(transcript.committed); }
        }

        fn assert_agreed_boundary_suffix_survives_finalization(restore: bool) {
            let base = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
            ]);
            let mut earlier = base.clone();
            earlier.extend(timed_words(&[("connector", 16_000, 20_000)]));
            let mut previous = earlier.clone();
            previous.extend(timed_words(&[("payload", 20_000, 28_000)]));
            let revised = timed_words(&[
                ("payload", 20_000, 28_000), ("tail", 28_000, 36_000),
            ]);
            let final_words = if restore {
                let mut restored = previous.clone();
                restored.extend(timed_words(&[("tail", 28_000, 36_000)]));
                restored
            } else { revised.clone() };
            let mut window = TranscriptWindow::default();
            let mut committed = Vec::new();

            window.observe_language("en".into(), 24_000);
            record_committed(&mut committed, window.update(base, 24_000, false));
            record_committed(&mut committed, window.update(earlier, 32_000, false));
            record_committed(&mut committed, window.update(previous, 40_000, false));
            // The connector agrees across two passes but was the older pass's
            // last word, so ordinary streaming has not entered it yet.
            assert_eq!(committed.join(" "), "alpha beta gamma delta");
            window.observe_language("tr".into(), 48_000);
            let transition = window.update(revised.clone(), 48_000, false);
            let recovered = transition.committed.clone();
            record_committed(&mut committed, transition);
            record_committed(&mut committed, window.update(revised, 56_000, false));
            record_committed(&mut committed, window.update(final_words, 64_000, true));
            assert_eq!(committed.join(" "), "alpha beta gamma delta connector payload tail");
            assert_eq!(recovered, "connector", "Agreed recovery belongs to the transition");
        }

        #[test]
        fn language_boundary_keeps_agreed_suffix_when_final_decode_omits_it() {
            assert_agreed_boundary_suffix_survives_finalization(false);
        }

        #[test]
        fn language_boundary_restoration_does_not_repeat_recovered_suffix() {
            assert_agreed_boundary_suffix_survives_finalization(true);
        }

        #[test]
        fn language_boundary_holds_a_deleted_uncommitted_suffix_until_it_recovers() {
            let base = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
            ]);
            let previous = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
                ("connector", 16_000, 20_000), ("payload", 20_000, 28_000),
                ("tail", 28_000, 36_000),
            ]);
            let retained_prefix = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
                ("payload", 20_000, 28_000), ("tail", 28_000, 36_000),
                ("followup", 36_000, 44_000),
            ]);
            let omitted_prefix = timed_words(&[
                ("payload", 20_000, 28_000), ("tail", 28_000, 36_000),
                ("followup", 36_000, 44_000),
            ]);
            let restored = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
                ("connector", 16_000, 20_000), ("payload", 20_000, 28_000),
                ("tail", 28_000, 36_000), ("followup", 36_000, 44_000),
            ]);

            for revised in [retained_prefix, omitted_prefix] {
                let mut window = TranscriptWindow::default();
                let mut committed = Vec::new();
                window.observe_language("old".into(), 24_000);
                record_committed(&mut committed, window.update(base.clone(), 24_000, true));
                record_committed(&mut committed, window.update(previous.clone(), 32_000, false));
                window.observe_language("new".into(), 32_000);
                record_committed(&mut committed, window.update(revised.clone(), 40_000, false));
                record_committed(&mut committed, window.update(revised.clone(), 52_000, false));
                record_committed(&mut committed, window.update(revised, 60_000, false));
                assert_eq!(committed.join(" "), "alpha beta gamma delta");
                record_committed(&mut committed, window.update(restored.clone(), 64_000, true));
                assert_eq!(committed.join(" "), "alpha beta gamma delta connector payload tail followup");
            }
        }

        #[test]
        fn boundary_transition_keeps_stable_suffixes_streaming() {
            let base = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
            ]);
            let stable = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
                ("payload", 20_000, 28_000), ("tail", 28_000, 36_000),
            ]);
            let extended = timed_words(&[
                ("alpha", 0, 4_000), ("beta", 4_000, 8_000),
                ("gamma", 8_000, 12_000), ("delta", 12_000, 16_000),
                ("payload", 20_000, 28_000), ("tail", 28_000, 36_000),
                ("followup", 36_000, 44_000),
            ]);
            let mut window = TranscriptWindow::default();
            let mut committed = Vec::new();

            window.observe_language("old".into(), 24_000);
            record_committed(&mut committed, window.update(base, 24_000, true));
            record_committed(&mut committed, window.update(stable, 32_000, false));
            window.observe_language("new".into(), 32_000);
            record_committed(&mut committed, window.update(extended.clone(), 40_000, false));
            assert!(window.boundary_suffix.is_empty());
            record_committed(&mut committed, window.update(extended, 52_000, false));
            assert_eq!(committed.join(" "), "alpha beta gamma delta payload tail");
        }

        #[test]
        fn live_words_wait_until_the_utterance_language_is_certain() {
            // Turkish right after English, first decoded in English: those
            // hypotheses agree with each other but must never be typed.
            let mut window = TranscriptWindow::default();
            window.language_pending = true;
            window.update(words("What you need to do"), 64_000, false);
            assert_eq!(window.update(words("What you need to do"), 72_000, false).committed, "");
            assert_eq!(window.update(words("What you need to do"), 72_000, false).committed, "");
            // The pass's own audio names Turkish and is decoded again in it.
            window.language_pending = false;
            window.observe_language("tr".into(), 72_000);
            assert_eq!(window.update(words("Ne yapman gerekiyorsa yapman"), 80_000, false).committed, "");
            assert_eq!(window.update(words("Ne yapman gerekiyorsa yapman lazım"), 88_000, false).committed, "");
            assert_eq!(window.update(words("Ne yapman gerekiyorsa yapman lazım"), 96_000, false).committed, "Ne yapman gerekiyorsa yapman");
            assert_eq!(window.update(words("Ne yapman gerekiyorsa yapman lazım"), 96_000, true).committed, "lazım");
        }

        fn check(language: &str, share: f32) -> super::super::LanguageChoice {
            super::super::LanguageChoice { language: language.into(), share, confident: share >= 0.5 }
        }

        #[test]
        fn turkish_after_english_types_nothing_until_its_own_audio_settles_it() {
            let mut window = TranscriptWindow::default();
            // Decoded in English, the language last heard, while this audio is
            // Turkish: the words are a translation and must stay untyped.
            window.record_language_check(&check("tr", 0.62), "en");
            assert!(window.language_pending);
            window.update(words("What you need to do"), 56_000, false);
            assert_eq!(window.update(words("What you need to do"), 64_000, false).committed, "");
            // One agreeing check is not enough; an early detection can be wrong.
            window.record_language_check(&check("tr", 0.95), "tr");
            assert!(window.language_pending);
            window.record_language_check(&check("tr", 0.98), "tr");
            assert!(!window.language_pending);
        }

        #[test]
        fn a_later_check_that_disagrees_or_is_unsure_holds_live_words_again() {
            let mut window = TranscriptWindow::default();
            for _ in 0..2 { window.record_language_check(&check("en", 0.89), "en"); }
            assert!(!window.language_pending);
            // Another language dominates, so the decision fell back to one of my
            // languages with almost no weight: not a settled English.
            window.record_language_check(&check("en", 0.01), "en");
            assert!(window.language_pending);
            window.record_language_check(&check("uk", 0.99), "en");
            assert!(window.language_pending);
            assert_eq!(window.tentative_language.as_deref(), Some("uk"));
        }

        #[test]
        fn a_pending_language_still_types_the_whole_utterance_at_its_end() {
            let mut window = TranscriptWindow::default();
            window.language_pending = true;
            window.update(words("Kaydet"), 16_000, false);
            assert_eq!(window.update(words("Kaydet"), 24_000, true).committed, "Kaydet");
        }

        #[test]
        fn a_retimed_final_decode_never_drops_words_that_were_not_typed() {
            // The final decode moved the retained words a second earlier, so
            // no word shares its audio with the typed ones. Only the words not
            // yet typed follow, never fewer.
            let mut window = TranscriptWindow {
                confirmed: timed_words(&[("kullanıcı", 32_000, 44_000), ("ayarlarını", 44_000, 56_000), ("kaydeden", 56_000, 64_000)]),
                ..Default::default()
            };
            let retimed = timed_words(&[("kullanıcı", 8_000, 16_000), ("ayarlarını", 16_000, 24_000), ("kaydeden", 24_000, 30_000),
                ("fonksiyonu", 30_000, 40_000), ("yeniden", 40_000, 48_000), ("yazacağız.", 48_000, 60_000), ("Birlikte", 60_000, 70_000)]);
            assert_eq!(window.update(retimed, 72_000, true).committed, "fonksiyonu yeniden yazacağız. Birlikte");
        }

        #[test]
        fn stretched_words_mark_a_hypothesis_that_skipped_speech() {
            // Seen on a busy machine: the end of an 11.7 s window spread over all of it.
            assert!(skipped_speech(&timed_words(&[("Sonuçları", 0, 62_880), ("birlikte", 62_880, 108_800), ("kontrol", 108_800, 149_120), ("edelim.", 149_120, 183_680)])));
            // A long last word is trailing silence, and long unspaced sentences read fast.
            assert!(!skipped_speech(&timed_words(&[("Önce", 0, 6_400), ("düzelteceğiz,", 6_400, 37_000), ("sonra", 37_000, 42_000), ("bittik.", 42_000, 90_000)])));
            assert!(!skipped_speech(&timed_words(&[("設定を開いてファイルを保存してください。", 0, 48_000), ("明日", 48_000, 56_000)])));
        }

        #[test]
        fn hypotheses_from_clearly_different_audio_type_words_sooner() {
            for (duration, typed) in [(56_000, ""), (72_000, "three four")] {
                let mut window = TranscriptWindow::default();
                window.update(words("one two tree four"), 40_000, false);
                assert_eq!(window.update(words("one two three four five"), 48_000, false).committed, "one two");
                // Half a second later the revised word still needs a third
                // agreeing pass; a second and a half later two passes suffice.
                assert_eq!(window.update(words("one two three four five six"), duration, false).committed, typed);
            }
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

        // 16 kHz audio over the level gate, digital silence, and the voice
        // model's verdict on `seconds` of audio.
        fn loud(seconds: f32) -> Vec<f32> {
            (0..(seconds * 16_000.0) as usize).map(|index| (index as f32 * 0.07).sin() * 0.1).collect()
        }

        fn quiet(seconds: f32) -> Vec<f32> {
            vec![0.0; (seconds * 16_000.0) as usize]
        }

        fn heard(seconds: f32, probability: f32) -> Vec<Option<f32>> {
            vec![Some(probability); (seconds * 50.0).round() as usize]
        }

        fn mask(audio: &[f32], voice: &[Vec<Option<f32>>]) -> super::super::SpeechMask {
            super::super::SpeechMask::new(audio, &voice.concat())
        }

        const PREROLL: usize = 16_000 / 5;

        #[test]
        fn windows_without_speech_are_let_go_without_decoding() {
            let skip = |window: &mut TranscriptWindow, audio: &[f32], speech: &super::super::SpeechMask, finalizing: bool| {
                unspoken_audio(window, speech, audio.len(), None, audio.len(), 16_000, finalizing)
            };
            let mut window = TranscriptWindow::default();
            // Silence, live and at the final pass.
            let silence = quiet(2.0);
            let silent = mask(&silence, &[heard(2.0, 0.02)]);
            assert_eq!(skip(&mut window, &silence, &silent, false), Some(silence.len() - PREROLL));
            assert_eq!(skip(&mut window, &silence, &silent, true), Some(silence.len()));
            // Low noise over the level gate that the voice model calls noise;
            // without the model the level decides, as it always did.
            let noise: Vec<f32> = (0..32_000).map(|index| (((index * 7919) % 1000) as f32 / 1000.0 - 0.5) * 0.04).collect();
            assert_eq!(skip(&mut window, &noise, &mask(&noise, &[heard(2.0, 0.1)]), false), Some(noise.len() - PREROLL));
            assert_eq!(skip(&mut window, &noise, &mask(&noise, &[]), false), None);
            // A 0.3 s tone burst in silence is decoded, by the level and by the model.
            let burst = [quiet(0.5), loud(0.3), quiet(0.5)].concat();
            assert_eq!(skip(&mut window, &burst, &mask(&burst, &[]), false), None);
            assert_eq!(skip(&mut window, &burst, &mask(&burst, &[heard(0.5, 0.02), heard(0.3, 0.9), heard(0.5, 0.05)]), false), None);
            // A boundary lets go of its utterance only, never the next phrase after it.
            assert_eq!(unspoken_audio(&mut window, &silent, silence.len(), Some(12_800), 40_000, 16_000, false), Some(12_800));
        }

        #[test]
        fn the_pause_after_typed_words_and_the_final_leftover_type_nothing() {
            let typed = timed_words(&[("open", 8_000, 16_000), ("settings", 16_000, 32_000)]);
            let typed_window = || TranscriptWindow { confirmed: typed.clone(), previous: typed.clone(), ..Default::default() };
            // A short pause after typed words: nothing decoded or let go, their context kept.
            let pause = [loud(2.0), quiet(0.6)].concat();
            let pause_heard = mask(&pause, &[heard(2.0, 0.95), heard(0.6, 0.03)]);
            let mut window = typed_window();
            assert_eq!(unspoken_audio(&mut window, &pause_heard, pause.len(), None, pause.len(), 16_000, false), Some(0));
            assert_eq!(window.confirmed.len(), 2);
            // The same pause in the final pass's leftover: let go, nothing typed.
            assert_eq!(unspoken_audio(&mut window, &pause_heard, pause.len(), None, pause.len(), 16_000, true), Some(pause.len()));
            assert!(window.confirmed.is_empty() && window.previous.is_empty());
            // A longer pause ends the utterance, live.
            let long = [loud(2.0), quiet(1.2)].concat();
            let mut window = typed_window();
            assert_eq!(unspoken_audio(&mut window, &mask(&long, &[heard(2.0, 0.95), heard(1.2, 0.03)]), long.len(), None, long.len(), 16_000, false),
                Some(long.len() - PREROLL));
            assert!(window.confirmed.is_empty());
            // Speech after the typed words is decoded, including the newest
            // audio the voice model has not analyzed yet.
            let next = [loud(2.0), quiet(0.6), loud(0.3)].concat();
            let mut window = typed_window();
            assert_eq!(unspoken_audio(&mut window, &mask(&next, &[heard(2.0, 0.95), heard(0.6, 0.03)]), next.len(), None, next.len(), 16_000, true), None);
            assert_eq!(unspoken_audio(&mut window, &mask(&next, &[heard(2.0, 0.95), heard(0.6, 0.03), heard(0.3, 0.8)]), next.len(), None, next.len(), 16_000, false), None);
            // Low noise after the typed words is not speech to the model.
            let noisy: Vec<f32> = loud(2.0).into_iter().chain((0..24_000).map(|index| (((index * 7919) % 1000) as f32 / 1000.0 - 0.5) * 0.04)).collect();
            let mut window = typed_window();
            assert_eq!(unspoken_audio(&mut window, &mask(&noisy, &[heard(2.0, 0.95), heard(1.5, 0.12)]), noisy.len(), None, noisy.len(), 16_000, true), Some(noisy.len()));
        }

        #[test]
        fn words_decoded_from_unspoken_audio_are_dropped() {
            // One second of speech, then three of silence.
            let audio = [loud(1.0), quiet(3.0)].concat();
            let speech = mask(&audio, &[heard(1.0, 0.9), heard(3.0, 0.02)]);
            let mut words = timed_words(&[
                ("Open", 3_200, 8_000), ("settings.", 9_600, 16_000),
                // A known silence phrase just after the speech, made-up words
                // far from it, and a word timed into the padding after the window.
                ("Thank", 20_000, 23_000), ("you.", 23_000, 26_000), ("Adobe", 40_000, 44_000), ("RG", 44_000, 48_000), ("you", 70_000, 72_000),
            ]);
            drop_unspoken(&mut words, &speech);
            assert_eq!(word_text(&words), "Open settings.");
            // Spoken, the same phrase stays, also when its timestamps run late into the pause.
            let audio = [loud(2.0), quiet(1.0)].concat();
            let speech = mask(&audio, &[heard(2.0, 0.9), heard(1.0, 0.02)]);
            for late in [0, 3_000, 6_000] {
                let mut words = timed_words(&[("Okay,", 0, 8_000), ("thank", 9_600 + late, 20_000 + late), ("you.", 20_000 + late, 32_000 + late)]);
                drop_unspoken(&mut words, &speech);
                assert_eq!(word_text(&words), "Okay, thank you.", "{late} samples late");
            }
            // Without the voice model the level decides, and text alone removes nothing.
            let audio = [loud(1.0), quiet(3.0)].concat();
            let mut words = timed_words(&[("Open", 3_200, 8_000), ("settings.", 9_600, 16_000), ("Thank", 20_000, 23_000), ("you.", 23_000, 26_000), ("Adobe", 40_000, 44_000)]);
            drop_unspoken(&mut words, &mask(&audio, &[]));
            assert_eq!(word_text(&words), "Open settings. Thank you.");
        }

        #[test]
        fn voice_frames_follow_the_audio_a_window_starts_at() {
            let capture = capture();
            // At 48 kHz a 20 ms block is 960 samples. Blocks 3 and 4 were
            // never analyzed (recognition drained them first).
            capture.record_voice(0, &[Some(0.1), Some(0.2), None]);
            capture.record_voice(5, &[Some(0.9), Some(0.8)]);
            assert_eq!(capture.window_voice(1_920, 5_760, 48_000), vec![None, None, None, Some(0.9), Some(0.8), None]);
            assert_eq!(capture.window_voice(0, 1_920, 48_000), vec![Some(0.1), Some(0.2)]);
            // A later analysis of the same blocks replaces them.
            capture.record_voice(1, &[Some(0.7)]);
            assert_eq!(capture.window_voice(0, 2_880, 48_000), vec![Some(0.1), Some(0.7), None]);
        }

        #[test]
        #[ignore = "Requires the installed speech model, float PCM audio and its original transcript"]
        fn real_model_streams_words_before_stop_and_recovers_after_cancel() {
            whisper_rs::install_logging_hooks();
            let model = std::env::var_os("PZZA_DICTATION_TEST_MODEL").expect("Set PZZA_DICTATION_TEST_MODEL");
            let fixture = std::env::var_os("PZZA_DICTATION_TEST_AUDIO").expect("Set PZZA_DICTATION_TEST_AUDIO");
            let expected = std::env::var("PZZA_DICTATION_TEST_EXPECTED")
                .expect("Set PZZA_DICTATION_TEST_EXPECTED to the original, unmodified transcript");
            assert!(!expected.trim().is_empty(), "The reference transcript must not be empty");
            let rate = std::env::var("PZZA_DICTATION_TEST_RATE").unwrap_or_else(|_| "16000".into())
                .parse::<u32>().expect("The fixture sample rate must be an integer");
            assert!((1..=192_000).contains(&rate), "Unsupported fixture sample rate");
            let bytes = std::fs::read(&fixture).unwrap();
            assert!(!bytes.is_empty() && bytes.len() % 4 == 0, "Expected complete float32 PCM samples");
            let samples: Vec<f32> = bytes.chunks_exact(4)
                .map(|sample| f32::from_le_bytes(sample.try_into().unwrap())).collect();
            assert!(samples.iter().all(|sample| sample.is_finite()), "PCM samples must be finite");
            let preparing = Instant::now();
            let mut engine = Engine::load(Path::new(&model), Arc::new(AtomicBool::new(false))).unwrap();
            let preparation_seconds = preparing.elapsed().as_secs_f64();
            let capture = capture();
            *capture.rate.lock().unwrap() = rate;
            let language = "auto";
            let mut window = TranscriptWindow::default();
            let mut committed = String::new();
            let mut offset = 0;
            let mut live_updates = 0;
            let mut events = Vec::new();
            let quarter_second = (rate as usize / 4).max(1);
            let realtime = std::env::var_os("PZZA_DICTATION_TEST_REALTIME").is_some();
            let started = Instant::now();
            while offset < samples.len() {
                // In live capture, audio also arrives while inference is running.
                // Exercise that cadence as well as deterministic quarter-second steps.
                let end = if realtime {
                    let available = (started.elapsed().as_secs_f64() * rate as f64) as usize;
                    if available.saturating_sub(offset) < quarter_second && available < samples.len() {
                        std::thread::sleep(Duration::from_millis(15));
                        continue;
                    }
                    available.min(samples.len())
                } else { (offset + quarter_second).min(samples.len()) };
                capture.samples.lock().unwrap().extend_from_slice(&samples[offset..end]);
                offset = end;
                let audio = capture.samples.lock().unwrap().clone();
                let transcript = transcribe_samples(&mut engine, &capture, language, &mut window, &audio, &[], rate, false).unwrap();
                if !transcript.committed.is_empty() && offset < samples.len() {
                    live_updates += 1;
                }
                let preview = format!("{} {}", committed, transcript.preview).trim().to_owned();
                apply(&capture, &transcript, &mut committed).unwrap();
                events.push(serde_json::json!({ "seconds": started.elapsed().as_secs_f64(),
                    "inputSamples": offset, "finalizing": false, "committed": committed, "preview": preview,
                    "rawWords": transcript.raw_words }));
            }
            while !capture.samples.lock().unwrap().is_empty() {
                let audio = capture.samples.lock().unwrap().clone();
                let transcript = transcribe_samples(&mut engine, &capture, language, &mut window, &audio, &[], rate, true).unwrap();
                assert!(transcript.consumed > 0, "Finalization must consume the remaining audio");
                apply(&capture, &transcript, &mut committed).unwrap();
                events.push(serde_json::json!({ "seconds": started.elapsed().as_secs_f64(),
                    "inputSamples": offset, "finalizing": true, "committed": committed,
                    "rawWords": transcript.raw_words }));
            }
            // Preserve failed recognitions too. The oracle is always the original
            // reference, never a transcript rewritten to fit the model's output.
            if let Some(report) = std::env::var_os("PZZA_DICTATION_TEST_REPORT") {
                let file = std::fs::OpenOptions::new().write(true).create_new(true).open(report).unwrap();
                serde_json::to_writer_pretty(file, &serde_json::json!({
                    "sampleRate": rate, "audioSamples": samples.len(), "realtime": realtime,
                    "preparationSeconds": preparation_seconds, "elapsedSeconds": started.elapsed().as_secs_f64(),
                    "modelBytes": std::fs::metadata(&model).unwrap().len(),
                    "reference": expected, "transcript": committed, "liveUpdates": live_updates, "events": events,
                })).unwrap();
            }
            assert!(live_updates >= 2, "Expected multiple terminal updates before Stop, got {live_updates}");
            let normalize = |text: &str| text.to_lowercase().chars()
                .filter(|character| character.is_alphanumeric() || character.is_whitespace()).collect::<String>()
                .split_whitespace().collect::<Vec<_>>().join(" ");
            assert_eq!(normalize(&committed), normalize(&expected));
            let decoded_audio = super::super::resample(&samples, rate);
            capture.cancel.store(true, Ordering::Release);
            engine.recognize(&decoded_audio, language, &capture, audio_context(decoded_audio.len()), true).unwrap();
            capture.cancel.store(false, Ordering::Release);
            engine.recognize(&decoded_audio, language, &capture, audio_context(decoded_audio.len()), true).unwrap();
            assert!(engine.decoder.full_n_segments() > 0, "The next recording must remain usable after cancellation");
        }

        pub(super) fn normalized_words(text: &str) -> Vec<String> {
            text.to_lowercase().chars()
                .filter(|character| character.is_alphanumeric() || character.is_whitespace()).collect::<String>()
                .split_whitespace().map(str::to_owned).collect()
        }

        // Word-level edit distance plus, for each left word, its aligned right word.
        pub(super) fn align_words(left: &[String], right: &[String]) -> (usize, Vec<Option<usize>>) {
            let mut distance = vec![vec![0usize; right.len() + 1]; left.len() + 1];
            for (index, row) in distance.iter_mut().enumerate() { row[0] = index; }
            for (index, cell) in distance[0].iter_mut().enumerate() { *cell = index; }
            for i in 1..=left.len() {
                for j in 1..=right.len() {
                    let substitution = distance[i - 1][j - 1] + usize::from(left[i - 1] != right[j - 1]);
                    distance[i][j] = substitution.min(distance[i - 1][j] + 1).min(distance[i][j - 1] + 1);
                }
            }
            let mut mapping = vec![None; left.len()];
            let (mut i, mut j) = (left.len(), right.len());
            while i > 0 && j > 0 {
                if distance[i][j] == distance[i - 1][j - 1] + usize::from(left[i - 1] != right[j - 1]) {
                    mapping[i - 1] = Some(j - 1);
                    i -= 1;
                    j -= 1;
                } else if distance[i][j] == distance[i - 1][j] + 1 { i -= 1; } else { j -= 1; }
            }
            (distance[left.len()][right.len()], mapping)
        }

        pub(super) fn percentile(values: &[f64], fraction: f64) -> Option<f64> {
            let mut sorted = values.to_vec();
            sorted.sort_by(f64::total_cmp);
            sorted.get(((sorted.len().max(1) - 1) as f64 * fraction).round() as usize).copied()
        }

        struct ReplayEvent {
            seconds: f64,
            committed_words: usize,
            preview: Vec<String>,
            finalizing: bool,
        }

        // Replays a recording at wall-clock speed with the worker's polling
        // cadence, so audio keeps arriving while each decode runs.
        fn replay(engine: &mut Engine, samples: &[f32], language: &str) -> (Vec<ReplayEvent>, String, Vec<PassStats>) {
            let rate = 16_000;
            let capture = capture();
            let mut window = TranscriptWindow::default();
            let mut committed = String::new();
            let mut events = Vec::new();
            let mut offset = 0;
            let started = Instant::now();
            while offset < samples.len() {
                let available = ((started.elapsed().as_secs_f64() * rate as f64) as usize).min(samples.len());
                if decode_due(available - offset, rate) || available == samples.len() {
                    capture.samples.lock().unwrap().extend_from_slice(&samples[offset..available]);
                    offset = available;
                    let audio: Vec<f32> = capture.samples.lock().unwrap().iter().take(rate * 27).copied().collect();
                    let transcript = transcribe_samples(engine, &capture, language, &mut window, &audio, &[], rate as u32, false).unwrap();
                    let preview = format!("{} {}", committed, transcript.preview);
                    apply(&capture, &transcript, &mut committed).unwrap();
                    events.push(ReplayEvent { seconds: started.elapsed().as_secs_f64(),
                        committed_words: normalized_words(&committed).len(), preview: normalized_words(&preview), finalizing: false });
                    continue;
                }
                std::thread::sleep(DECODE_POLL);
            }
            while !capture.samples.lock().unwrap().is_empty() {
                let audio: Vec<f32> = capture.samples.lock().unwrap().iter().take(rate * 27).copied().collect();
                let transcript = transcribe_samples(engine, &capture, language, &mut window, &audio, &[], rate as u32, true).unwrap();
                apply(&capture, &transcript, &mut committed).unwrap();
                events.push(ReplayEvent { seconds: started.elapsed().as_secs_f64(),
                    committed_words: normalized_words(&committed).len(), preview: normalized_words(&committed), finalizing: true });
            }
            let stats = capture.stats.lock().unwrap().clone();
            (events, committed, stats)
        }

        #[test]
        #[ignore = "Requires the installed speech model and a directory of float PCM fixtures with transcripts"]
        fn real_model_latency_benchmark() {
            whisper_rs::install_logging_hooks();
            let model = std::env::var_os("PZZA_DICTATION_TEST_MODEL").expect("Set PZZA_DICTATION_TEST_MODEL");
            // Each fixture is <name>.<language>.f32 (16 kHz mono float32 little
            // endian) beside <name>.<language>.txt holding the spoken script.
            let directory = std::env::var_os("PZZA_DICTATION_BENCH_DIR").expect("Set PZZA_DICTATION_BENCH_DIR");
            let filter = std::env::var("PZZA_DICTATION_BENCH_ONLY").ok();
            let mut fixtures: Vec<_> = std::fs::read_dir(&directory).unwrap().filter_map(Result::ok).map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|extension| extension == "f32"))
                .filter(|path| filter.as_deref().is_none_or(|only| path.to_string_lossy().contains(only))).collect();
            fixtures.sort();
            assert!(!fixtures.is_empty(), "No fixtures found");
            let mut engine = Engine::load(Path::new(&model), Arc::new(AtomicBool::new(false))).unwrap();
            let mut report = Vec::new();
            let mut table = vec![format!("{:<8} {:<5} {:>6} {:>7} {:>7} {:>7} {:>7} {:>6} {:>6} {:>6} {:>5} {:>5} {:>6} {:>6}",
                "fixture", "mode", "ttfp", "prev50", "prev90", "comm50", "comm90", "dec50", "dec90", "decmax", "det", "ctx15", "wer", "oracle")];
            for fixture in fixtures {
                let stem = fixture.file_stem().unwrap().to_string_lossy().into_owned();
                let (name, pinned) = stem.rsplit_once('.').expect("Fixture names must be <name>.<language>.f32");
                let reference = std::fs::read_to_string(fixture.with_extension("txt")).unwrap();
                let bytes = std::fs::read(&fixture).unwrap();
                let samples: Vec<f32> = bytes.chunks_exact(4).map(|sample| f32::from_le_bytes(sample.try_into().unwrap())).collect();
                // Offline reference timing: one full-context decode of the whole recording.
                let oracle_capture = capture();
                let mut padded = samples.clone();
                padded.resize(padded.len().max(16_000), 0.0);
                engine.recognize(&padded, pinned, &oracle_capture, 1500, true).unwrap();
                let oracle = decoded_words(&engine.decoder, samples.len()).unwrap();
                // Leave the decoder at the live encoder context, as preparation does.
                engine.recognize(&[0.0; 16_000], "en", &oracle_capture, audio_context(16_000), false).unwrap();
                let oracle_text = word_text(&oracle);
                let oracle_words: Vec<(String, f64, f64)> = oracle.iter().flat_map(|word| {
                    normalized_words(&word.text).into_iter().map(|text| (text, word.start as f64 / 16_000.0, word.end as f64 / 16_000.0)).collect::<Vec<_>>()
                }).collect();
                let reference_words = normalized_words(&reference);
                let oracle_names: Vec<String> = oracle_words.iter().map(|(text, _, _)| text.clone()).collect();
                let oracle_wer = align_words(&oracle_names, &reference_words).0 as f64 / reference_words.len() as f64;
                for mode in ["auto", pinned] {
                    let (events, transcript, stats) = replay(&mut engine, &samples, mode);
                    let final_words = normalized_words(&transcript);
                    let wer = align_words(&final_words, &reference_words).0 as f64 / reference_words.len() as f64;
                    // Spoken end time of each final word, from its aligned offline word.
                    let (_, mapping) = align_words(&final_words, &oracle_names);
                    let mut spoken = Vec::with_capacity(final_words.len());
                    let mut last = oracle_words.first().map_or(0.0, |word| word.2);
                    for aligned in &mapping {
                        if let Some(index) = aligned { last = oracle_words[*index].2; }
                        spoken.push(last);
                    }
                    let first_speech = oracle_words.first().map_or(0.0, |word| word.1);
                    let ttfp = events.iter().find(|event| !event.preview.is_empty()).map(|event| event.seconds - first_speech);
                    let mut preview_latency = Vec::new();
                    let mut commit_latency = Vec::new();
                    let mut live_commits = 0;
                    for (index, word) in final_words.iter().enumerate() {
                        let commit = events.iter().find(|event| event.committed_words > index);
                        if commit.is_some_and(|event| !event.finalizing) { live_commits += 1; }
                        let preview = events.iter().find(|event| event.preview.get(index) == Some(word)).or(commit);
                        if let Some(event) = preview { preview_latency.push(event.seconds - spoken[index]); }
                        if let Some(event) = commit { commit_latency.push(event.seconds - spoken[index]); }
                    }
                    let live: Vec<&PassStats> = stats.iter().filter(|pass| !pass.finalizing).collect();
                    let decode: Vec<f64> = live.iter().map(|pass| pass.decode_ms).collect();
                    let detections: Vec<f64> = stats.iter().filter_map(|pass| pass.detect_ms).collect();
                    let full_context = live.iter().filter(|pass| pass.audio_ctx == 1500).count();
                    let ms = |value: Option<f64>| value.map_or("-".into(), |value| format!("{:.0}", value * 1_000.0));
                    table.push(format!("{:<8} {:<5} {:>6} {:>7} {:>7} {:>7} {:>7} {:>6.0} {:>6.0} {:>6.0} {:>5} {:>5} {:>6.3} {:>6.3}",
                        name, mode, ms(ttfp), ms(percentile(&preview_latency, 0.5)), ms(percentile(&preview_latency, 0.9)),
                        ms(percentile(&commit_latency, 0.5)), ms(percentile(&commit_latency, 0.9)),
                        percentile(&decode, 0.5).unwrap_or(0.0), percentile(&decode, 0.9).unwrap_or(0.0),
                        decode.iter().copied().fold(0.0, f64::max),
                        format!("{}/{:.0}", detections.len(), detections.iter().sum::<f64>() / detections.len().max(1) as f64),
                        format!("{full_context}/{}", live.len()), wer, oracle_wer));
                    eprintln!("{}", table.last().unwrap());
                    eprintln!("  transcript: {transcript}");
                    report.push(serde_json::json!({
                        "fixture": name, "mode": mode, "reference": reference, "oracle": oracle_text, "transcript": transcript,
                        "wer": wer, "oracleWer": oracle_wer, "timeToFirstPreview": ttfp, "liveCommittedWords": live_commits,
                        "words": final_words.iter().enumerate().map(|(index, word)| serde_json::json!({
                            "word": word, "spokenEnd": spoken[index],
                            "previewLatency": preview_latency.get(index), "commitLatency": commit_latency.get(index),
                        })).collect::<Vec<_>>(),
                        "passes": stats,
                        "events": events.iter().map(|event| serde_json::json!({ "seconds": event.seconds,
                            "committedWords": event.committed_words, "preview": event.preview.join(" "), "finalizing": event.finalizing })).collect::<Vec<_>>(),
                    }));
                }
            }
            eprintln!("\n{}", table.join("\n"));
            if let Some(path) = std::env::var_os("PZZA_DICTATION_BENCH_REPORT") {
                serde_json::to_writer_pretty(std::fs::File::create(path).unwrap(), &serde_json::json!({ "runs": report, "table": table })).unwrap();
            }
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

    // How often the idle worker checks for new audio.
    const DECODE_POLL: Duration = Duration::from_millis(10);

    fn decode_due(new_samples: usize, rate: usize) -> bool {
        new_samples >= rate / 4
    }

    fn run(app: AppHandle, capture: Arc<Capture>, language: String, input_device_id: Option<String>) {
        let result = (|| {
            emit(&app, &capture, "loading", None, None, None);
            if capture.stop.load(Ordering::Acquire) {
                return Ok(String::new());
            }
            let audio_app = app.clone();
            let audio_capture = capture.clone();
            let microphone = std::thread::spawn(move || capture_audio(audio_app, audio_capture, input_device_id));
            // The microphone starts listening while the model loads (after an
            // idle release); decoding begins once it is ready, from the start
            // of the recorded audio.
            if let Err(error) = prepare(&app) {
                capture.stop.store(true, Ordering::Release);
                let _ = microphone.join();
                return Err(error);
            }
            let mut processed_samples = 0;
            let mut committed = String::new();
            let mut window = TranscriptWindow::default();
            // Words shown as pending in the last preview, for the stop diagnostic.
            let mut pending_words = 0;
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
                if !capture.stop.load(Ordering::Acquire) && decode_due(captured_samples.saturating_sub(processed_samples), rate) {
                    // Decode each new quarter-second of audio as soon as the engine
                    // is free, including audio captured while the last decode ran.
                    processed_samples = captured_samples;
                    match transcribe(&app, &capture, &language, &mut window, false) {
                        Ok(transcript) => {
                            pending_words = transcript.preview.split_whitespace().count();
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
                    // A decode outlasts the audio quantum, so the next one is
                    // usually due already. Start it without an idle wait.
                    continue;
                }
                std::thread::sleep(DECODE_POLL);
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
            let left = capture.samples.lock().map_err(|_| "Audio lock failed")?.len();
            let typed_before = committed.split_whitespace().count();
            while !capture
                .samples
                .lock()
                .map_err(|_| "Audio lock failed")?
                .is_empty()
            {
                let transcript = transcribe(&app, &capture, &language, &mut window, true)?;
                apply(&capture, &transcript, &mut committed)?;
            }
            // Counts only, never the words: dictation can hold anything.
            let rate = capture.rate.lock().map(|rate| *rate).unwrap_or(16_000).max(1);
            crate::voice_log::log(&app, format!(
                "dictation {} stopped: {pending_words} words pending in the last preview, {:.1} s of audio left for the final pass, which typed {} words ({} words in all)",
                capture.id, left as f64 / rate as f64, committed.split_whitespace().count().saturating_sub(typed_before), committed.split_whitespace().count(),
            ));
            Ok(committed)
        })();
        // Idleness counts from the end of the recording.
        app.state::<SpeechState>().touch();
        // Release the singleton before notifying the interface so a new recording can start immediately.
        if let Ok(mut active) = app.state::<SpeechState>().active.lock() {
            *active = None;
        }
        capture.finished.store(true, Ordering::Release);
        match result {
            Ok(text) => {
                // The language heard most with confidence, so the app can learn the
                // user's languages.
                let language = capture.heard.lock().ok()
                    .and_then(|heard| heard.iter().max_by_key(|(_, samples)| *samples).map(|(language, _)| language.clone()));
                if !capture.cancel.load(Ordering::Acquire) {
                    let _ = app.emit(CHANNEL, Event {
                        id: &capture.id, kind: "final", text: Some(&text), level: None, error: None, active: None,
                        language: language.as_deref(),
                    });
                }
            }
            Err(error) => emit(&app, &capture, "error", None, None, Some(&error)),
        }
    }

    #[cfg(test)]
    mod shutdown_tests {
        use super::*;
        use std::sync::mpsc;

        #[test]
        fn shutdown_cancels_and_joins_an_active_worker() {
            let state = SpeechState::default();
            let capture = Arc::new(Capture::new("shutdown-test".into()));
            *state.active.lock().unwrap() = Some(capture.clone());
            let worker_capture = capture.clone();
            *state.worker.lock().unwrap() = Some(std::thread::spawn(move || {
                while !worker_capture.cancel.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                worker_capture.finished.store(true, Ordering::Release);
            }));
            state.shutdown(Duration::from_secs(1)).unwrap();
            assert!(capture.stop.load(Ordering::Acquire));
            assert!(capture.finished.load(Ordering::Acquire));
            assert!(state.worker.lock().unwrap().is_none());
            assert!(state.shutting_down.load(Ordering::Acquire));
            state.shutdown(Duration::ZERO).unwrap();
        }

        #[test]
        fn shutdown_timeout_retains_worker_ownership_for_retry() {
            let state = SpeechState::default();
            let (release, waiting) = mpsc::channel();
            *state.worker.lock().unwrap() = Some(std::thread::spawn(move || {
                waiting.recv_timeout(Duration::from_secs(2)).unwrap();
            }));
            assert!(state.shutdown(Duration::from_millis(10)).is_err());
            assert!(state.worker.lock().unwrap().is_some());
            release.send(()).unwrap();
            state.shutdown(Duration::from_secs(1)).unwrap();
            assert!(state.worker.lock().unwrap().is_none());
        }

        #[test]
        fn preparation_lock_timeout_does_not_claim_cleanup_completed() {
            let state = SpeechState::default();
            let held = state.context.lock().unwrap();
            assert!(state.shutdown(Duration::from_millis(10)).is_err());
            drop(held);
            state.shutdown(Duration::ZERO).unwrap();
        }
    }

    #[cfg(test)]
    mod idle_tests {
        use super::*;
        use std::sync::mpsc;

        #[test]
        fn idle_release_waits_for_the_recording_and_the_idle_period() {
            let now = Instant::now() + Duration::from_secs(3600);
            let idle = Duration::from_secs(600);
            assert!(!idle_release_due(true, None, now, idle), "never while recording");
            assert!(!idle_release_due(true, Some(now - Duration::from_secs(7200)), now, idle), "never while recording, however long ago");
            assert!(!idle_release_due(false, Some(now - Duration::from_secs(599)), now, idle), "not before the idle period");
            assert!(idle_release_due(false, Some(now - idle), now, idle));
            assert!(idle_release_due(false, None, now, idle));
        }

        #[test]
        fn idle_release_skips_recordings_running_workers_and_shutdown() {
            let state = SpeechState::default();
            let later = Instant::now() + Duration::from_secs(3600);
            *state.active.lock().unwrap() = Some(Arc::new(Capture::new("idle-test".into())));
            assert!(!state.release_if_idle(later, Duration::ZERO));
            *state.active.lock().unwrap() = None;
            let (finish, waiting) = mpsc::channel::<()>();
            *state.worker.lock().unwrap() = Some(std::thread::spawn(move || { let _ = waiting.recv_timeout(Duration::from_secs(2)); }));
            assert!(!state.release_if_idle(later, Duration::ZERO));
            finish.send(()).unwrap();
            state.worker.lock().unwrap().take().unwrap().join().unwrap();
            // A held lock (a recording starting, a model loading) is waited out, never blocked on.
            let held = state.active.lock().unwrap();
            assert!(!state.release_if_idle(later, Duration::ZERO));
            drop(held);
            state.shutdown(Duration::ZERO).unwrap();
            assert!(!state.release_if_idle(later, Duration::ZERO));
        }

        fn resident_megabytes() -> f64 {
            let output = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().unwrap();
            String::from_utf8_lossy(&output.stdout).trim().parse::<f64>().unwrap() / 1024.0
        }

        #[test]
        #[ignore = "Requires the installed speech model (PZZA_DICTATION_TEST_MODEL)"]
        fn real_model_is_released_only_when_idle_and_frees_its_memory() {
            let model = std::env::var_os("PZZA_DICTATION_TEST_MODEL").expect("Set PZZA_DICTATION_TEST_MODEL");
            let state = SpeechState::default();
            let baseline = resident_megabytes();
            *state.context.lock().unwrap() = Some(Engine::load(Path::new(&model), state.shutting_down.clone()).unwrap());
            state.touch();
            let loaded = resident_megabytes();
            let later = Instant::now() + IDLE_RELEASE;
            // A recording keeps the model however long ago it was last used.
            *state.active.lock().unwrap() = Some(Arc::new(Capture::new("idle-recording".into())));
            assert!(!state.release_if_idle(later, IDLE_RELEASE));
            assert!(state.context.lock().unwrap().is_some());
            *state.active.lock().unwrap() = None;
            assert!(!state.release_if_idle(Instant::now(), IDLE_RELEASE), "recently used");
            assert!(state.context.lock().unwrap().is_some());
            assert!(state.release_if_idle(later, IDLE_RELEASE));
            assert!(state.context.lock().unwrap().is_none());
            let released = resident_megabytes();
            eprintln!("dictation model memory: {baseline:.0} MB before load, {loaded:.0} MB loaded, {released:.0} MB after the idle release");
            assert!(loaded - released > 0.5 * (loaded - baseline), "the release returns most of the model's memory");
            state.shutdown(Duration::from_secs(5)).unwrap();
        }
    }

    #[cfg(test)]
    pub fn prepare_shutdown_regression(app: &AppHandle, model: &Path, in_flight: bool) {
        let state = app.state::<SpeechState>();
        *state.context.lock().unwrap() = Some(Engine::load(model, state.shutting_down.clone()).unwrap());
        if !in_flight { return; }
        let capture = Arc::new(Capture {
            wait_for_cancellation: true,
            ..Capture::new("native-shutdown-regression".into())
        });
        *state.active.lock().unwrap() = Some(capture.clone());
        let worker_capture = capture.clone();
        let handle = app.clone();
        *state.worker.lock().unwrap() = Some(std::thread::spawn(move || {
            let state = handle.state::<SpeechState>();
            let audio: Vec<f32> = (0..480_000).map(|i| ((i as f32) * 0.07).sin() * 0.1).collect();
            state.context.lock().unwrap().as_mut().unwrap()
                .recognize(&audio, "en", &worker_capture, audio_context(audio.len()), true).unwrap();
            worker_capture.finished.store(true, Ordering::Release);
        }));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !capture.decoding.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline, "Native decoder did not begin");
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(!capture.finished.load(Ordering::Acquire), "Native decoder already finished");
    }

    #[cfg(test)]
    pub fn assert_cancelled_quit_regression(app: &AppHandle) {
        prepare(app).unwrap();
        let state = app.state::<SpeechState>();
        assert!(!state.shutting_down.load(Ordering::Acquire));
        let capture = Arc::new(Capture::new("cancelled-quit-regression".into()));
        state.context.lock().unwrap().as_mut().unwrap()
            .recognize(&[0.0; 16_000], "en", &capture, audio_context(16_000), true).unwrap();
    }

    #[cfg(test)]
    pub fn assert_shutdown_regression(app: &AppHandle, in_flight: bool) {
        let state = app.state::<SpeechState>();
        assert!(state.context.lock().unwrap().is_none());
        assert!(state.worker.lock().unwrap().is_none());
        if in_flight {
            let capture = state.active.lock().unwrap().clone().unwrap();
            assert!(capture.cancel.load(Ordering::Acquire));
            assert!(capture.cancellation_seen.load(Ordering::Acquire), "Native inference must observe cancellation before exit");
            assert!(capture.finished.load(Ordering::Acquire));
        }
    }

    fn supported_language(language: &str) -> bool {
        language == "auto" || super::supported_languages().contains(&language)
    }

    // "My languages": distinct supported languages, main language first.
    fn speech_languages(languages: Option<Vec<String>>) -> Result<Vec<String>, String> {
        let languages = languages.unwrap_or_default();
        let valid = languages.len() <= super::supported_languages().len()
            && languages.iter().enumerate().all(|(index, language)| {
                language != "auto" && supported_language(language) && !languages[..index].contains(language)
            });
        if valid { Ok(languages) } else { Err("Invalid speech languages".into()) }
    }

    #[cfg(test)]
    mod language_tests {
        use super::{speech_languages, supported_language};

        #[test]
        fn accepts_exactly_the_supported_languages_and_auto() {
            assert!(supported_language("auto"));
            for language in super::super::supported_languages() {
                assert!(supported_language(language));
            }
            // Engine languages outside the supported set are refused too.
            for invalid in ["", "English", "TR", "en-US", "en\0", "turkish", "az", "sw", "haw"] {
                assert!(!supported_language(invalid));
            }
        }

        #[test]
        fn my_languages_are_distinct_supported_codes() {
            let list = |codes: &[&str]| Some(codes.iter().map(|code| (*code).to_owned()).collect::<Vec<_>>());
            assert_eq!(speech_languages(list(&["tr", "en"])).unwrap(), ["tr", "en"]);
            assert!(speech_languages(None).unwrap().is_empty());
            for invalid in [&["auto"][..], &["tr", "tr"], &["az"], &["EN"]] {
                assert!(speech_languages(list(invalid)).is_err());
            }
        }
    }

    #[cfg(test)]
    mod device_tests {
        use super::{select_input_device, select_voice_input, valid_input_device_id, InputDevice};

        fn microphone(object: u32, id: &str, is_default: bool) -> (u32, InputDevice) {
            (object, InputDevice { id: id.into(), name: "USB microphone".into(), is_default, built_in: false, bluetooth: false })
        }

        fn device(object: u32, id: &str, is_default: bool, built_in: bool, bluetooth: bool) -> (u32, InputDevice) {
            (object, InputDevice { id: id.into(), name: id.into(), is_default, built_in, bluetooth })
        }

        #[test]
        fn dictation_avoids_bluetooth_microphones() {
            let airpods_default = vec![device(1, "airpods", true, false, true), device(2, "builtin", false, true, false), device(3, "usb", false, false, false)];
            // A Bluetooth default input falls back to the built-in microphone.
            assert_eq!(select_voice_input(&airpods_default, None, false).unwrap(), 2);
            // So does a wired default input while Bluetooth headphones play the output.
            let usb_default = vec![device(1, "airpods", false, false, true), device(2, "builtin", false, true, false), device(3, "usb", true, false, false)];
            assert_eq!(select_voice_input(&usb_default, None, true).unwrap(), 2);
            assert_eq!(select_voice_input(&usb_default, None, false).unwrap(), 3);
            // An explicit choice always wins, even a Bluetooth one.
            assert_eq!(select_voice_input(&airpods_default, Some("airpods"), true).unwrap(), 1);
            assert!(select_voice_input(&airpods_default, Some("missing"), false).is_err());
            // Without a built-in microphone the default is used rather than failing.
            let headset_only = vec![device(1, "airpods", true, false, true)];
            assert_eq!(select_voice_input(&headset_only, None, true).unwrap(), 1);
        }

        // Prints this Mac's input devices, their transport and the dictation choice.
        #[test]
        #[ignore = "reads the real audio devices of this Mac"]
        fn this_macs_devices_and_dictation_choice() {
            let devices = super::input_devices().unwrap();
            for (object, device) in &devices {
                println!("input {object}: {:?} default={} built_in={} bluetooth={}", device.name, device.is_default, device.built_in, device.bluetooth);
            }
            let output_bluetooth = super::output_is_bluetooth();
            println!("default output is Bluetooth: {output_bluetooth}");
            let chosen = select_voice_input(&devices, None, output_bluetooth).unwrap();
            println!("dictation uses input {chosen}");
        }

        // Dictation reads the microphone through a deadlock-free tap;
        // repeated starts must neither hang nor drop audio.
        #[test]
        #[ignore = "opens this Mac's microphone"]
        fn dictation_microphone_restarts_and_records() {
            let device = super::voice_input_device(None).unwrap();
            for round in 0..10 {
                let capture = std::sync::Arc::new(super::Capture::new(format!("test-{round}")));
                let (mut stream, rate) = super::input(device, capture.clone()).unwrap();
                stream.start().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(300));
                drop(stream);
                let samples = capture.captured_samples.load(std::sync::atomic::Ordering::Acquire);
                assert!(samples > rate as usize / 10, "round {round}: only {samples} samples at {rate} Hz");
            }
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
    pub fn speech_start(app: AppHandle, id: String, language: String, languages: Option<Vec<String>>, input_device_id: Option<String>, silence_stop_ms: Option<u64>) -> Result<(), String> {
        let languages = speech_languages(languages).map_err(|_| "Invalid dictation request")?;
        if id.is_empty() || id.len() > 128 || !supported_language(&language)
            || input_device_id.as_deref().is_some_and(|id| !valid_input_device_id(id))
            || silence_stop_ms.is_some_and(|ms| !super::SILENCE_STOP_RANGE_MS.contains(&ms)) {
            return Err("Invalid dictation request".into());
        }
        let state = app.state::<SpeechState>();
        let mut active = state
            .active
            .lock()
            .map_err(|_| "Speech session lock failed")?;
        if state.shutting_down.load(Ordering::Acquire) {
            return Err("The application is shutting down".into());
        }
        let mut worker = state.worker.lock().map_err(|_| "Speech worker lock failed")?;
        if active.is_some() || worker.as_ref().is_some_and(|worker| !worker.is_finished()) {
            return Err("Dictation is already running. Wait for it to finish.".into());
        }
        if let Some(previous) = worker.take() {
            previous.join().map_err(|_| "The previous dictation worker failed")?;
        }
        let silence_stop_ms = silence_stop_ms.map(|ms| ms as usize);
        let capture = Arc::new(Capture { languages, silence_stop_ms, ..Capture::new(id) });
        *active = Some(capture.clone());
        let worker_app = app.clone();
        *worker = Some(std::thread::spawn(move || run(worker_app, capture, language, input_device_id)));
        Ok(())
    }

    // Language detection and transcription quality on a synthetic set that
    // mimics a Turkish developer: Turkish with English technical words, pure
    // Turkish and English, alternating sentences in one recording, short
    // commands, numbers and paths, and every supported language with a system
    // voice, over room noise and quiet distant speech. Clips run through one
    // engine in a fixed order, so language memory carries over as in real use,
    // through the dictation streaming path (wall-clock replay). Audio is
    // synthesized into PZZA_STT_EVAL_DIR once and reused, so every run hears
    // identical input.
    #[cfg(test)]
    mod language_eval_tests {
        use super::*;
        use super::streaming_tests::{align_words, normalized_words, percentile};

        const TR: &str = "Yelda (Turkish (Türkiye))";
        const EN: &str = "Samantha (English (US))";
        const EN_UK: &str = "Daniel (English (UK))";
        const RATE: usize = 16_000;

        #[derive(Clone, Copy)]
        enum Condition { Clean, Room, Noisy, Distant }

        impl Condition {
            // Speech level (active speech, dBFS), noise level (dBFS), reverberation.
            fn levels(self) -> (f32, f32, bool) {
                match self {
                    Condition::Clean => (-24.0, -70.0, false),
                    Condition::Room => (-26.0, -54.0, false),
                    // Above the pause detector's floor: no utterance boundaries.
                    Condition::Noisy => (-28.0, -44.0, false),
                    Condition::Distant => (-40.0, -58.0, true),
                }
            }

            fn name(self) -> &'static str {
                match self { Condition::Clean => "clean", Condition::Room => "room", Condition::Noisy => "noisy", Condition::Distant => "distant" }
            }
        }

        struct Clip {
            id: &'static str,
            category: &'static str,
            condition: Condition,
            pause_ms: usize,
            // Speaking rate in words per minute; 0 keeps the voice's default.
            words_per_minute: u32,
            parts: &'static [(&'static str, &'static str, &'static str)],
        }

        const fn clip(id: &'static str, category: &'static str, condition: Condition, pause_ms: usize, words_per_minute: u32,
            parts: &'static [(&'static str, &'static str, &'static str)]) -> Clip {
            Clip { id, category, condition, pause_ms, words_per_minute, parts }
        }

        use Condition::{Clean, Distant, Noisy, Room};
        // Ordered so Turkish often follows English or another language, the
        // situation in which a remembered language used to decode Turkish as
        // an English translation.
        const CLIPS: &[Clip] = &[
            clip("01-en-settings", "en", Room, 0, 0, &[(EN, "en", "Please open the settings panel and enable dark mode.")]),
            clip("02-tr-failure", "tr", Room, 0, 200, &[(TR, "tr", "Ne yapman gerekiyorsa yapman lazım.")]),
            clip("03-short-en-stop", "short", Clean, 0, 0, &[(EN, "en", "Stop.")]),
            clip("04-short-tr-save", "short", Room, 0, 0, &[(TR, "tr", "Kaydet.")]),
            clip("05-tech-refactor", "tr-tech", Clean, 0, 190, &[(TR, "tr", "Şu component'i refactor edelim, sonra testleri tekrar çalıştıralım.")]),
            clip("06-mixed-tests", "mixed", Room, 800, 0, &[
                (EN, "en", "First, open the terminal and run the tests."), (TR, "tr", "Sonra hataları tek tek düzeltelim."),
                (EN, "en", "Then push the branch."), (TR, "tr", "Ne yapman gerekiyorsa yapman lazım."),
            ]),
            clip("07-en-build", "en", Noisy, 0, 0, &[(EN_UK, "en", "The build failed because the tests timed out on the server.")]),
            clip("08-tech-merge", "tr-tech", Noisy, 0, 0, &[(TR, "tr", "PR'ı merge etmeden önce testleri çalıştır.")]),
            clip("09-short-tr-yes", "short", Distant, 0, 0, &[(TR, "tr", "Evet.")]),
            clip("10-de-settings", "other", Room, 0, 0, &[("Anna (German (Germany))", "de", "Öffne bitte die Einstellungen und speichere die Datei.")]),
            clip("11-short-tr-cancel", "short", Room, 0, 0, &[(TR, "tr", "Hayır, iptal et.")]),
            clip("12-es-config", "other", Clean, 0, 0, &[("Mónica (Spanish (Spain))", "es", "Abre el archivo de configuración y guarda los cambios.")]),
            clip("13-tr-evening", "tr", Distant, 0, 0, &[(TR, "tr", "Bugün akşam toplantıdan sonra eve gideceğim.")]),
            clip("14-mixed-continuous", "mixed", Room, 300, 0, &[
                (TR, "tr", "Bu fonksiyonu biraz daha hızlandırmamız lazım."), (EN, "en", "I think the cache is the problem."),
                (TR, "tr", "Yarın birlikte bakalım."),
            ]),
            clip("15-en-async", "en", Distant, 0, 0, &[(EN, "en", "Can you refactor this function to use async await?")]),
            clip("16-tech-cache", "tr-tech", Room, 0, 0, &[(TR, "tr", "Bu endpoint'in response'u çok yavaş, cache ekleyelim.")]),
            clip("17-ja-settings", "other", Room, 0, 0, &[("Kyoko (Japanese (Japan))", "ja", "設定を開いてファイルを保存してください。")]),
            clip("18-short-tr-tests", "short", Clean, 0, 0, &[(TR, "tr", "Testleri çalıştır.")]),
            clip("19-num-tr-port", "numbers", Room, 0, 0, &[(TR, "tr", "Port numarasını 8080 yap ve sunucuyu yeniden başlat.")]),
            clip("20-num-en-timeout", "numbers", Room, 0, 0, &[(EN, "en", "Change the timeout to 30 seconds and retry 3 times.")]),
            clip("21-mixed-commit", "mixed", Noisy, 700, 0, &[
                (EN, "en", "Okay, that looks good."), (TR, "tr", "Şimdi commit atıp push'layalım."),
                (EN, "en", "And then create a pull request."),
            ]),
            clip("22-tech-deploy", "tr-tech", Distant, 0, 0, &[(TR, "tr", "Deploy pipeline'ı fail oldu, log'lara bakar mısın?")]),
            clip("23-short-en-yes", "short", Room, 0, 0, &[(EN, "en", "Yes, do it.")]),
            clip("24-tr-save-file", "tr", Room, 0, 0, &[(TR, "tr", "Bu dosyayı kaydet ve pencereyi kapat.")]),
            clip("25-de-time", "other", Noisy, 0, 0, &[("Anna (German (Germany))", "de", "Wie spät ist es heute Abend in Berlin?")]),
            clip("26-tech-hook", "tr-tech", Room, 0, 0, &[(TR, "tr", "State management için yeni bir hook yazmamız lazım.")]),
            clip("27-es-review", "other", Room, 0, 0, &[("Paulina", "es", "Necesito revisar el código antes de la reunión.")]),
            clip("28-short-tr-stop", "short", Noisy, 0, 0, &[(TR, "tr", "Durdur.")]),
            clip("29-path-tr", "numbers", Clean, 0, 0, &[(TR, "tr", "src klasöründeki App.tsx dosyasını aç.")]),
            clip("30-path-en", "numbers", Room, 0, 0, &[(EN, "en", "Open the main.rs file in the src folder.")]),
            clip("31-ja-meeting", "other", Room, 0, 0, &[("Kyoko (Japanese (Japan))", "ja", "明日の会議は十時からです。")]),
            clip("32-mixed-question", "mixed", Room, 600, 0, &[
                (TR, "tr", "Bunu bitirmek için ne yapman lazım?"), (TR, "tr", "Ne yapman gerekiyorsa yapman lazım."),
                (EN, "en", "Got it, thanks."),
            ]),
            clip("33-tech-rebase", "tr-tech", Noisy, 0, 0, &[(TR, "tr", "Branch'i rebase et ve conflict'leri çöz.")]),
            clip("34-en-ship", "en", Room, 0, 0, &[(EN, "en", "Let's ship the release after the review is done.")]),
            clip("35-tr-morning", "tr", Room, 0, 210, &[(TR, "tr", "Yarın sabah erkenden kalkıp işe başlamam gerekiyor.")]),
            clip("36-short-en-open", "short", Distant, 0, 0, &[(EN, "en", "Open settings.")]),
            clip("37-tr-failure-again", "tr", Clean, 0, 200, &[(TR, "tr", "Ne yapman gerekiyorsa yapman lazım.")]),
            clip("38-tr-long", "tr-tech", Room, 500, 0, &[
                (TR, "tr", "Bu hafta yeni özelliği bitirmemiz lazım."), (TR, "tr", "Önce API tarafını yazalım, sonra arayüzü bağlarız."),
                (TR, "tr", "Testleri de unutmayalım."),
            ]),
            // Every other supported language with a system voice (Persian has none).
            clip("40-zh", "other", Room, 0, 0, &[("Tingting (Chinese (China mainland))", "zh", "请打开设置并保存文件。")]),
            clip("41-hi", "other", Room, 0, 0, &[("Lekha", "hi", "कृपया सेटिंग्स खोलें और फ़ाइल सेव करें।")]),
            clip("42-tr-after-hi", "tr", Room, 0, 0, &[(TR, "tr", "Bu satırı silip yeniden yaz.")]),
            clip("43-pt", "other", Room, 0, 0, &[("Luciana (Portuguese (Brazil))", "pt", "Abra o arquivo de configuração e salve as alterações.")]),
            clip("44-ru", "other", Room, 0, 0, &[("Milena", "ru", "Пожалуйста, откройте настройки и сохраните файл.")]),
            clip("45-fr", "other", Room, 0, 0, &[("Jacques", "fr", "Ouvre les paramètres et enregistre le fichier.")]),
            clip("46-ko", "other", Room, 0, 0, &[("Yuna", "ko", "설정을 열고 파일을 저장해 주세요.")]),
            clip("47-id", "other", Room, 0, 0, &[("Damayanti", "id", "Tolong buka pengaturan dan simpan berkasnya.")]),
            clip("48-vi", "other", Room, 0, 0, &[("Linh", "vi", "Hãy mở phần cài đặt và lưu tệp lại.")]),
            clip("49-pl", "other", Room, 0, 0, &[("Zosia", "pl", "Otwórz ustawienia i zapisz plik.")]),
            clip("50-uk", "other", Room, 0, 0, &[("Lesya", "uk", "Будь ласка, відкрийте налаштування і збережіть файл.")]),
            clip("51-short-tr-after-uk", "short", Room, 0, 0, &[(TR, "tr", "Tamam, devam et.")]),
            clip("52-it", "other", Room, 0, 0, &[("Alice (Italian (Italy))", "it", "Apri le impostazioni e salva il file.")]),
            clip("53-ar", "other", Room, 0, 0, &[("Majed", "ar", "من فضلك افتح الإعدادات واحفظ الملف.")]),
            clip("54-nl", "other", Room, 0, 0, &[("Xander", "nl", "Open de instellingen en sla het bestand op.")]),
            clip("55-bn", "other", Room, 0, 0, &[("Piya", "bn", "অনুগ্রহ করে সেটিংস খুলুন এবং ফাইলটি সংরক্ষণ করুন।")]),
            clip("56-th", "other", Room, 0, 0, &[("Kanya", "th", "กรุณาเปิดการตั้งค่าและบันทึกไฟล์")]),
            clip("57-he", "other", Room, 0, 0, &[("Carmit", "he", "בבקשה פתח את ההגדרות ושמור את הקובץ.")]),
            clip("58-sv", "other", Room, 0, 0, &[("Alva", "sv", "Öppna inställningarna och spara filen.")]),
            clip("59-cs", "other", Room, 0, 0, &[("Zuzana", "cs", "Otevři nastavení a ulož soubor.")]),
            clip("60-ro", "other", Room, 0, 0, &[("Ioana", "ro", "Deschide setările și salvează fișierul.")]),
            clip("61-el", "other", Room, 0, 0, &[("Melina", "el", "Άνοιξε τις ρυθμίσεις και αποθήκευσε το αρχείο.")]),
            clip("62-hu", "other", Room, 0, 0, &[("Tünde", "hu", "Nyisd meg a beállításokat és mentsd el a fájlt.")]),
            clip("63-ms", "other", Room, 0, 0, &[("Amira", "ms", "Sila buka tetapan dan simpan fail itu.")]),
            clip("64-da", "other", Room, 0, 0, &[("Sara", "da", "Åbn indstillingerne og gem filen.")]),
            clip("65-fi", "other", Room, 0, 0, &[("Satu", "fi", "Avaa asetukset ja tallenna tiedosto.")]),
            clip("66-no", "other", Room, 0, 0, &[("Nora", "no", "Åpne innstillingene og lagre filen.")]),
            clip("68-sk", "other", Room, 0, 0, &[("Laura", "sk", "Otvor nastavenia a ulož súbor.")]),
            clip("69-bg", "other", Room, 0, 0, &[("Daria", "bg", "Моля, отвори настройките и запази файла.")]),
            clip("70-sl", "other", Room, 0, 0, &[("Tina", "sl", "Odpri nastavitve in shrani datoteko.")]),
            clip("71-tr-after-sl", "tr", Room, 0, 0, &[(TR, "tr", "Bunu da listeye ekle.")]),
            clip("67-tr-after-no", "tr", Room, 0, 0, &[(TR, "tr", "Şimdi sunucuyu yeniden başlatalım.")]),
        ];

        struct Rng(u64);

        impl Rng {
            fn next(&mut self) -> f32 {
                self.0 ^= self.0 << 13;
                self.0 ^= self.0 >> 7;
                self.0 ^= self.0 << 17;
                (self.0 >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0
            }
        }

        fn decibels(level: f32) -> f32 { 10f32.powf(level / 20.0) }

        fn rms(samples: &[f32]) -> f32 {
            (samples.iter().map(|value| value * value).sum::<f32>() / samples.len().max(1) as f32).sqrt()
        }

        // Level of the voiced 20 ms frames only, so pauses do not dilute it.
        fn active_rms(samples: &[f32]) -> f32 {
            let energies: Vec<f32> = samples.chunks(320).map(|frame| frame.iter().map(|value| value * value).sum::<f32>() / frame.len() as f32).collect();
            let peak = energies.iter().copied().fold(0.0, f32::max);
            let active: Vec<f32> = energies.into_iter().filter(|energy| *energy > peak / 1_000.0).collect();
            (active.iter().sum::<f32>() / active.len().max(1) as f32).sqrt()
        }

        // Fan rumble, broadband hiss and a little mains hum, at unit level.
        fn room_noise(length: usize, seed: u64) -> Vec<f32> {
            let mut rng = Rng(seed | 1);
            let mut brown = 0.0f32;
            let noise: Vec<f32> = (0..length).map(|index| {
                let white = rng.next();
                brown = 0.995 * brown + 0.05 * white;
                let time = index as f32 / RATE as f32;
                2.0 * brown + 0.5 * white + 0.1 * (std::f32::consts::TAU * 100.0 * time).sin() + 0.04 * (std::f32::consts::TAU * 200.0 * time).sin()
            }).collect();
            let level = rms(&noise);
            noise.into_iter().map(|value| value / level).collect()
        }

        // A small room heard from across the desk: Schroeder reverberation and
        // the high-frequency loss of distance.
        fn distant(samples: &[f32]) -> Vec<f32> {
            let length = samples.len() + RATE / 2;
            let dry: Vec<f32> = samples.iter().copied().chain(std::iter::repeat_n(0.0, RATE / 2)).collect();
            let mut wet = vec![0.0f32; length];
            for (delay, gain) in [(475usize, 0.80f32), (594, 0.79), (658, 0.78), (699, 0.77)] {
                let mut comb = vec![0.0f32; length];
                for index in 0..length {
                    comb[index] = dry[index] + if index >= delay { gain * comb[index - delay] } else { 0.0 };
                    wet[index] += comb[index] * 0.25;
                }
            }
            for (delay, gain) in [(80usize, 0.7f32), (27, 0.7)] {
                let input = wet.clone();
                for index in delay..length {
                    wet[index] = -gain * input[index] + input[index - delay] + gain * wet[index - delay];
                }
            }
            let mut low = 0.0f32;
            dry.iter().zip(&wet).map(|(dry, wet)| {
                low += 0.35 * (0.6 * dry + 0.5 * wet - low);
                low
            }).collect()
        }

        fn say(voice: &str, text: &str, words_per_minute: u32) -> Vec<f32> {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!("pzza-eval-{}-{}.wav", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
            let mut command = std::process::Command::new("/usr/bin/say");
            command.args(["-v", voice, "--data-format=LEF32@16000", "-o"]).arg(&path);
            if words_per_minute > 0 { command.args(["-r", &words_per_minute.to_string()]); }
            assert!(command.arg(text).status().unwrap().success(), "say failed for {voice}");
            let bytes = std::fs::read(&path).unwrap();
            let _ = std::fs::remove_file(&path);
            let data = bytes.windows(4).position(|window| window == b"data").expect("WAV data chunk");
            bytes[data + 8..].chunks_exact(4).map(|sample| f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]])).collect()
        }

        struct Sentence { language: String, text: String, start: usize, end: usize }

        // Synthesizes a clip once and caches it with its transcript and the
        // span of each sentence.
        /// Recordings of a real voice (each <id>.f32 at RATE with its <id>.json,
        /// as load_or_create reads them), evaluated in place of the synthetic
        /// clips: a system voice reading a script is not how people speak.
        fn recorded_clips(directory: &Path) -> Vec<Clip> {
            let keep = |text: &str| -> &'static str { Box::leak(text.to_owned().into_boxed_str()) };
            let mut clips: Vec<Clip> = std::fs::read_dir(directory).unwrap().flatten().map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|extension| extension == "json") && path.with_extension("f32").exists())
                .map(|path| {
                    let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                    let parts: Vec<(&'static str, &'static str, &'static str)> = meta["sentences"].as_array().unwrap().iter()
                        .map(|sentence| ("", keep(sentence["language"].as_str().unwrap()), keep(sentence["text"].as_str().unwrap()))).collect();
                    Clip {
                        id: keep(&path.file_stem().unwrap().to_string_lossy()), category: keep(meta["category"].as_str().unwrap_or("recorded")),
                        condition: Condition::Room, pause_ms: 0, words_per_minute: 0, parts: Box::leak(parts.into_boxed_slice()),
                    }
                }).collect();
            clips.sort_by_key(|clip| clip.id);
            clips
        }

        fn load_or_create(directory: &Path, clip: &Clip) -> (Vec<f32>, Vec<Sentence>) {
            let audio_path = directory.join(format!("{}.f32", clip.id));
            let meta_path = directory.join(format!("{}.json", clip.id));
            if audio_path.exists() && meta_path.exists() {
                let bytes = std::fs::read(&audio_path).unwrap();
                let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
                let sentences = meta["sentences"].as_array().unwrap().iter().map(|sentence| Sentence {
                    language: sentence["language"].as_str().unwrap().into(), text: sentence["text"].as_str().unwrap().into(),
                    start: sentence["start"].as_u64().unwrap() as usize, end: sentence["end"].as_u64().unwrap() as usize,
                }).collect();
                return (bytes.chunks_exact(4).map(|sample| f32::from_le_bytes(sample.try_into().unwrap())).collect(), sentences);
            }
            let (speech_level, noise_level, reverberant) = clip.condition.levels();
            let mut speech = vec![0.0f32; RATE / 2];
            let mut sentences = Vec::new();
            for (index, (voice, language, text)) in clip.parts.iter().enumerate() {
                if index > 0 { speech.extend(std::iter::repeat_n(0.0, clip.pause_ms * RATE / 1_000)); }
                let part = say(voice, text, clip.words_per_minute);
                let level = active_rms(&part);
                let start = speech.len();
                speech.extend(part.iter().map(|value| value / level));
                sentences.push(Sentence { language: (*language).into(), text: (*text).into(), start, end: speech.len() });
            }
            speech.extend(std::iter::repeat_n(0.0, RATE * 6 / 10));
            if reverberant { speech = distant(&speech); }
            let gain = decibels(speech_level) / active_rms(&speech);
            let seed = clip.id.bytes().fold(1469598103934665603u64, |hash, byte| (hash ^ byte as u64).wrapping_mul(1099511628211));
            let noise = room_noise(speech.len(), seed);
            let audio: Vec<f32> = speech.iter().zip(&noise).map(|(speech, noise)| speech * gain + noise * decibels(noise_level)).collect();
            std::fs::write(&audio_path, audio.iter().flat_map(|sample| sample.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
            std::fs::write(&meta_path, serde_json::to_vec_pretty(&serde_json::json!({
                "id": clip.id, "category": clip.category, "condition": clip.condition.name(),
                "sentences": sentences.iter().map(|sentence| serde_json::json!({
                    "language": sentence.language, "text": sentence.text, "start": sentence.start, "end": sentence.end,
                })).collect::<Vec<_>>(),
            })).unwrap()).unwrap();
            (audio, sentences)
        }

        // The dictation worker's loop at wall-clock speed. Returns the typed
        // text, each decode pass with the absolute sample its audio starts at,
        // and the time from the end of the audio to the final text.
        fn dictate(engine: &mut Engine, capture: &Arc<Capture>, samples: &[f32]) -> (String, Vec<(usize, PassStats)>, f64) {
            let mut window = TranscriptWindow::default();
            let mut committed = String::new();
            let mut passes = Vec::new();
            let (mut offset, mut consumed) = (0, 0);
            let voice = voice_probabilities(samples);
            let mut pass = |engine: &mut Engine, window: &mut TranscriptWindow, committed: &mut String, consumed: &mut usize, finalizing: bool, offset: usize| {
                // The capture thread analyzes the audio a little behind the
                // microphone, and all of it before the final pass.
                if let Some(voice) = &voice {
                    let analyzed = if finalizing { offset } else { offset.saturating_sub(VOICE_LAG) };
                    capture.record_voice(0, &voice[..(analyzed / 320).min(voice.len())]);
                }
                let audio: Vec<f32> = capture.samples.lock().unwrap().iter().take(RATE * 27).copied().collect();
                let heard = capture.window_voice(*consumed, audio.len(), RATE as u32);
                let before = capture.stats.lock().unwrap().len();
                let transcript = transcribe_samples(engine, capture, "auto", window, &audio, &heard, RATE as u32, finalizing).unwrap();
                if let Some(stats) = capture.stats.lock().unwrap().get(before).cloned() { passes.push((*consumed, stats)); }
                *consumed += transcript.consumed;
                apply(capture, &transcript, committed).unwrap();
                transcript.consumed
            };
            let started = Instant::now();
            while offset < samples.len() {
                let available = ((started.elapsed().as_secs_f64() * RATE as f64) as usize).min(samples.len());
                if decode_due(available - offset, RATE) || available == samples.len() {
                    capture.samples.lock().unwrap().extend_from_slice(&samples[offset..available]);
                    offset = available;
                    pass(engine, &mut window, &mut committed, &mut consumed, false, offset);
                    continue;
                }
                std::thread::sleep(DECODE_POLL);
            }
            while !capture.samples.lock().unwrap().is_empty() {
                assert!(pass(engine, &mut window, &mut committed, &mut consumed, true, offset) > 0, "Finalization must consume audio");
            }
            let latency = (started.elapsed().as_secs_f64() - samples.len() as f64 / RATE as f64).max(0.0);
            (committed, passes, latency)
        }

        // How far the capture thread's voice analysis trails the microphone:
        // its 50 ms polling plus the model's 32 ms window.
        const VOICE_LAG: usize = RATE / 10;

        // The voice model's speech probability for every 20 ms frame, as the
        // capture thread computes it. None (the level alone decides, as when
        // the model is unavailable) without ONNX Runtime and the model
        // (PZZA_VAD_MODEL, else the installed one), or with
        // PZZA_DICTATION_TEST_VAD=off.
        fn voice_probabilities(samples: &[f32]) -> Option<Vec<Option<f32>>> {
            if std::env::var("PZZA_DICTATION_TEST_VAD").is_ok_and(|value| value == "off") { return None; }
            let model = std::env::var_os("PZZA_VAD_MODEL").map(std::path::PathBuf::from).unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/com.pzzacode.app/speech/silero_vad.onnx")
            });
            match crate::voice_vad::Vad::load(&model) {
                Ok(mut vad) => Some(samples.chunks_exact(320).map(|frame| vad.push(frame).ok()).collect()),
                Err(error) => {
                    eprintln!("voice activity model unavailable, the level alone decides: {error}");
                    None
                }
            }
        }

        const ENGLISH_MARKERS: &[&str] = &["the", "you", "your", "to", "do", "does", "need", "what", "is", "are", "it", "this", "that", "and", "of",
            "for", "with", "we", "i", "me", "my", "our", "be", "have", "has", "can", "would", "should", "must", "let", "lets", "please", "then",
            "there", "here", "from", "by", "if", "so", "not", "dont", "after", "before", "now", "just", "how", "why", "when", "where", "which",
            "who", "yes", "stop", "save", "open", "file", "settings", "tomorrow", "today", "evening", "morning", "meeting", "home", "close",
            "window", "cancel", "run", "tests", "okay"];
        const TURKISH_MARKERS: &[&str] = &["bir", "ve", "bu", "şu", "ne", "için", "ile", "mi", "var", "yok", "sonra", "önce", "gibi", "ama",
            "çok", "daha", "lazım", "şimdi", "yap", "et", "evet", "hayır", "kaydet", "aç", "kapat", "dosyayı", "tamam"];

        fn latin_script(language: &str) -> bool {
            !["zh", "ja", "ko", "ru", "uk", "bg", "ar", "fa", "hi", "bn", "th", "he", "el"].contains(&language)
        }

        fn char_distance(left: &[char], right: &[char]) -> usize {
            let mut previous: Vec<usize> = (0..=right.len()).collect();
            for (i, a) in left.iter().enumerate() {
                let mut current = vec![i + 1];
                for (j, b) in right.iter().enumerate() {
                    current.push((previous[j] + usize::from(a != b)).min(previous[j + 1] + 1).min(current[j] + 1));
                }
                previous = current;
            }
            previous[right.len()]
        }

        #[derive(Default, Clone, Copy)]
        struct Score { words: usize, word_errors: usize, chars: usize, char_errors: usize, translations: usize }

        impl std::ops::AddAssign for Score {
            fn add_assign(&mut self, other: Self) {
                self.words += other.words;
                self.word_errors += other.word_errors;
                self.chars += other.chars;
                self.char_errors += other.char_errors;
                self.translations += other.translations;
            }
        }

        // Error rates against the reference, plus wrong-language events: a
        // sentence whose aligned output carries another language's common
        // words or script (a translation instead of a transcript).
        fn score(transcript: &str, sentences: &[Sentence], notes: &mut Vec<String>) -> Score {
            let heard = normalized_words(transcript);
            let mut reference = Vec::new();
            let mut owner = Vec::new();
            for (index, sentence) in sentences.iter().enumerate() {
                let words = normalized_words(&sentence.text);
                owner.extend(std::iter::repeat_n(index, words.len()));
                reference.extend(words);
            }
            let (word_errors, mapping) = align_words(&heard, &reference);
            let heard_chars: Vec<char> = heard.concat().chars().collect();
            let reference_chars: Vec<char> = reference.concat().chars().collect();
            let mut assigned: Vec<Vec<&str>> = vec![Vec::new(); sentences.len()];
            let mut current = 0;
            for (index, word) in heard.iter().enumerate() {
                if let Some(position) = mapping[index] { current = owner[position]; }
                assigned[current].push(word.as_str());
            }
            let mut translations = 0;
            for (index, sentence) in sentences.iter().enumerate() {
                let own = normalized_words(&sentence.text);
                let foreign = assigned[index].iter().copied().filter(|word| !own.contains(&word.to_string()) && (
                    (sentence.language != "en" && ENGLISH_MARKERS.contains(word))
                    || (sentence.language != "tr" && (TURKISH_MARKERS.contains(word) || word.contains(['ğ', 'ı'])))
                )).count();
                let letters: Vec<char> = assigned[index].iter().flat_map(|word| word.chars()).filter(|c| c.is_alphabetic()).collect();
                let latin = letters.iter().filter(|c| c.is_ascii_alphabetic() || ('\u{c0}'..='\u{24f}').contains(*c)).count();
                let wrong_script = !letters.is_empty() && if latin_script(&sentence.language) { latin * 2 < letters.len() } else { latin * 2 > letters.len() };
                if foreign >= 2 || (foreign >= 1 && own.len() <= 3) || wrong_script {
                    translations += 1;
                    notes.push(format!("wrong language in {} sentence {:?}: {:?}", sentence.language, sentence.text, assigned[index].join(" ")));
                }
            }
            Score { words: reference.len(), word_errors, chars: reference_chars.len(), char_errors: char_distance(&heard_chars, &reference_chars), translations }
        }

        // The language spoken in most of [start, end).
        fn spoken_language(sentences: &[Sentence], start: usize, end: usize) -> Option<&str> {
            sentences.iter().map(|sentence| (sentence.end.min(end).saturating_sub(sentence.start.max(start)), sentence.language.as_str()))
                .filter(|(overlap, _)| *overlap > 0).max_by_key(|(overlap, _)| *overlap).map(|(_, language)| language)
        }

        #[derive(Default)]
        struct Tally { clips: usize, dictation: Score, passes: usize, passes_right: usize, dictation_latency: Vec<f64> }

        #[test]
        #[ignore = "needs the installed speech model, macOS voices and PZZA_STT_EVAL_DIR"]
        fn real_model_language_evaluation() {
            whisper_rs::install_logging_hooks();
            let directory = std::path::PathBuf::from(std::env::var_os("PZZA_STT_EVAL_DIR").expect("Set PZZA_STT_EVAL_DIR"));
            std::fs::create_dir_all(&directory).unwrap();
            let model = std::env::var_os("PZZA_DICTATION_TEST_MODEL").map(std::path::PathBuf::from).unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/com.pzzacode.app/speech/ggml-large-v3-q5_0.bin")
            });
            let filter = std::env::var("PZZA_STT_EVAL_ONLY").ok();
            // My languages, main first, e.g. "tr,en"; empty for none.
            let preferred: Vec<String> = std::env::var("PZZA_STT_EVAL_LANGUAGES").unwrap_or_default()
                .split(',').map(str::trim).filter(|code| !code.is_empty()).map(str::to_owned).collect();
            // Re-aggregates an earlier run's report instead of recognizing, so a
            // baseline can be compared on the current language list.
            let rescore: Option<serde_json::Value> = std::env::var_os("PZZA_STT_EVAL_RESCORE")
                .map(|path| serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap());
            let mut engine = rescore.is_none().then(|| Engine::load(&model, Arc::new(AtomicBool::new(false))).unwrap());
            let mut categories: std::collections::BTreeMap<String, Tally> = Default::default();
            let mut languages: std::collections::BTreeMap<String, Tally> = Default::default();
            let mut decode_ms = Vec::new();
            // Single decodes at the smallest encoder context: a machine load reference.
            let mut reference_ms = Vec::new();
            let mut redecodes = 0;
            let mut report = Vec::new();
            let supported = |clip: &&Clip| clip.parts.iter().all(|(_, language, _)| super::super::supported_languages().contains(language));
            // PZZA_STT_EVAL_RECORDED: the recordings in the directory instead of CLIPS.
            let recorded = std::env::var_os("PZZA_STT_EVAL_RECORDED").map(|_| recorded_clips(&directory));
            for clip in recorded.as_deref().unwrap_or(CLIPS).iter().filter(supported).filter(|clip| filter.as_deref().is_none_or(|only| clip.id.contains(only))) {
                let (samples, sentences) = load_or_create(&directory, clip);
                let single = sentences.iter().all(|sentence| sentence.language == sentences[0].language).then(|| sentences[0].language.clone());
                let mut notes = Vec::new();

                let (typed, passes, latency) = match (&rescore, engine.as_mut()) {
                    (Some(earlier), _) => {
                        let Some(entry) = earlier["clips"].as_array().unwrap().iter().find(|entry| entry["id"] == clip.id) else {
                            eprintln!("{} is not in the earlier report", clip.id);
                            continue;
                        };
                        let passes: Vec<(usize, PassStats)> = entry["passes"].as_array().unwrap().iter().map(|pass| {
                            (pass["start"].as_u64().unwrap() as usize, serde_json::from_value(pass["stats"].clone()).unwrap())
                        }).collect();
                        (entry["dictation"].as_str().unwrap().to_owned(), passes, entry["dictationLatency"].as_f64().unwrap())
                    }
                    (None, Some(engine)) => {
                        let capture = Arc::new(Capture { languages: preferred.clone(), ..Capture::new(format!("eval-{}", clip.id)) });
                        dictate(engine, &capture, &samples)
                    }
                    (None, None) => unreachable!("The engine loads unless rescoring"),
                };
                let dictation = score(&typed, &sentences, &mut notes);
                let mut decisions = (0, 0);
                for (start, pass) in &passes {
                    if !pass.finalizing { decode_ms.push(pass.decode_ms); }
                    if !pass.finalizing && !pass.redecoded && pass.audio_ctx == 768 { reference_ms.push(pass.decode_ms); }
                    redecodes += usize::from(pass.redecoded);
                    if pass.committed.is_empty() { continue; }
                    if let Some(expected) = spoken_language(&sentences, *start, start + pass.audio_samples) {
                        decisions.0 += 1;
                        decisions.1 += usize::from(pass.language == expected);
                        let tally = languages.entry(expected.into()).or_default();
                        tally.passes += 1;
                        tally.passes_right += usize::from(pass.language == expected);
                        if pass.language != expected { notes.push(format!("dictation typed {:?} decoded as {} over {expected} speech", pass.committed, pass.language)); }
                    }
                }

                for key in [clip.category.to_owned(), "all".to_owned()] {
                    let tally = categories.entry(key).or_default();
                    tally.clips += 1;
                    tally.dictation += dictation;
                    tally.passes += decisions.0;
                    tally.passes_right += decisions.1;
                    tally.dictation_latency.push(latency);
                }
                if let Some(expected) = &single {
                    let tally = languages.entry(expected.clone()).or_default();
                    tally.clips += 1;
                    tally.dictation += dictation;
                }
                eprintln!("[{}] {} {}\n  reference: {}\n  dictation: {typed}",
                    clip.category, clip.id, clip.condition.name(), sentences.iter().map(|sentence| sentence.text.as_str()).collect::<Vec<_>>().join(" "));
                for note in &notes { eprintln!("  ! {note}"); }
                report.push(serde_json::json!({
                    "id": clip.id, "category": clip.category, "condition": clip.condition.name(),
                    "reference": sentences.iter().map(|sentence| serde_json::json!({ "language": sentence.language, "text": sentence.text })).collect::<Vec<_>>(),
                    "dictation": typed, "dictationLatency": latency, "notes": notes,
                    "passes": passes.iter().map(|(start, pass)| serde_json::json!({ "start": start, "stats": pass })).collect::<Vec<_>>(),
                }));
            }
            let rate = |errors: usize, total: usize| if total == 0 { "-".to_owned() } else { format!("{:.3}", errors as f64 / total as f64) };
            let share = |right: usize, total: usize| if total == 0 { "-".to_owned() } else { format!("{right}/{total}") };
            let ms = |values: &[f64], fraction: f64, scale: f64| percentile(values, fraction).map_or("-".into(), |value| format!("{:.0}", value * scale));
            let mut table = vec![format!("{:<10} {:>5} {:>6} {:>6} {:>5} {:>8} {:>7} {:>7}",
                "category", "clips", "d.wer", "d.cer", "d.wl", "d.lang", "fin50", "fin90")];
            for (name, tally) in &categories {
                table.push(format!("{:<10} {:>5} {:>6} {:>6} {:>5} {:>8} {:>7} {:>7}",
                    name, tally.clips, rate(tally.dictation.word_errors, tally.dictation.words), rate(tally.dictation.char_errors, tally.dictation.chars),
                    tally.dictation.translations, share(tally.passes_right, tally.passes),
                    ms(&tally.dictation_latency, 0.5, 1_000.0), ms(&tally.dictation_latency, 0.9, 1_000.0)));
            }
            table.push(format!("{:<10} {:>8} {:>6} {:>5}", "language", "d.cer", "d.wl", "d.lang"));
            for (name, tally) in &languages {
                table.push(format!("{:<10} {:>8} {:>6} {:>5}", name,
                    rate(tally.dictation.char_errors, tally.dictation.chars), tally.dictation.translations, share(tally.passes_right, tally.passes)));
            }
            table.push(format!("live decode ms p50 {} p90 {} max {:.0}; passes {}; re-decodes {redecodes}; load reference (single decode at ctx 768) p50 {} ms",
                ms(&decode_ms, 0.5, 1.0), ms(&decode_ms, 0.9, 1.0), decode_ms.iter().copied().fold(0.0, f64::max), decode_ms.len(), ms(&reference_ms, 0.5, 1.0)));
            eprintln!("\n{}", table.join("\n"));
            if let Some(path) = std::env::var_os("PZZA_STT_EVAL_REPORT") {
                serde_json::to_writer_pretty(std::fs::File::create(path).unwrap(), &serde_json::json!({ "clips": report, "table": table })).unwrap();
            }
        }

        // Stopping right on the last word (no quiet after it) must still type
        // the words said last, which the live preview already showed.
        #[test]
        #[ignore = "needs the installed speech model and macOS voices"]
        fn real_model_stopping_on_the_last_word_types_it() {
            whisper_rs::install_logging_hooks();
            let model = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/com.pzzacode.app/speech/ggml-large-v3-q5_0.bin");
            let mut engine = Engine::load(&model, Arc::new(AtomicBool::new(false))).unwrap();
            let sentences = [
                (TR, "Bugün akşam toplantıdan sonra raporu bitirip ekibe göndereceğim, sonra da yeni tasarımı inceleyeceğiz."),
                (TR, "Bu dosyadaki hatayı düzeltip testleri tekrar çalıştır ve sonucu bana bildir."),
                (EN, "Please open the settings page, check the spacing value and then send me a short summary of the changes."),
                (EN, "Run the tests again after you fix the login flow."),
            ];
            let mut missing = 0;
            for (voice, text) in sentences {
                for trailing in [0, RATE * 6 / 10] {
                    let mut samples = vec![0.0f32; RATE / 2];
                    let speech = say(voice, text, 0);
                    let level = active_rms(&speech);
                    samples.extend(speech.iter().map(|value| value / level * 0.1));
                    samples.extend(std::iter::repeat_n(0.0, trailing));
                    let capture = Arc::new(Capture { languages: vec!["en".into(), "tr".into()], ..Capture::new("tail".into()) });
                    let (typed, _, _) = dictate(&mut engine, &capture, &samples);
                    let last: Vec<String> = normalized_words(text).into_iter().rev().take(2).collect();
                    let typed_words = normalized_words(&typed);
                    let kept = last.iter().all(|word| typed_words.iter().rev().take(4).any(|typed| typed == word));
                    if !kept && trailing == 0 { missing += 1; }
                    eprintln!("TAIL {} quiet {:.1}s: {} typed {typed:?}", if kept { "ok  " } else { "LOST" }, trailing as f64 / RATE as f64, text);
                }
            }
            assert_eq!(missing, 0, "the last words were lost when stopping right after them");
        }

        // Speech followed by seconds of silence or room noise before Stop, and
        // recordings with nothing said: nothing may be typed beyond the spoken
        // words. A spoken "thank you" (a phrase the decoder also invents from
        // silence) is still typed.
        #[test]
        #[ignore = "needs the installed speech model, the voice activity model and macOS voices"]
        fn real_model_types_nothing_from_the_silence_after_speech() {
            whisper_rs::install_logging_hooks();
            let model = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/com.pzzacode.app/speech/ggml-large-v3-q5_0.bin");
            let mut engine = Engine::load(&model, Arc::new(AtomicBool::new(false))).unwrap();
            let sentences = [
                (EN, "Please open the settings page and check the spacing value."),
                (TR, "Bu dosyadaki hatayı düzeltip testleri tekrar çalıştır."),
                (EN, "Okay, thank you."),
                (TR, "Tamam, teşekkür ederim."),
            ];
            let mut failures = Vec::new();
            for (noise_level, condition) in [(None, "silence"), (Some(-50.0), "room noise")] {
                let mix = |speech: &[f32], seed: u64| -> Vec<f32> {
                    let noise = room_noise(speech.len(), seed);
                    speech.iter().zip(&noise).map(|(sample, noise)| sample + noise_level.map_or(0.0, |level| noise * decibels(level))).collect()
                };
                // Nothing said at all, then Stop.
                let capture = Arc::new(Capture { languages: vec!["en".into(), "tr".into()], ..Capture::new("silent".into()) });
                let (typed, _, _) = dictate(&mut engine, &capture, &mix(&vec![0.0; RATE * 6], 7));
                eprintln!("SILENT {condition}: typed {typed:?}");
                if !typed.trim().is_empty() { failures.push(format!("{condition} alone typed {typed:?}")); }
                for (voice, text) in sentences {
                    let mut speech = vec![0.0f32; RATE / 2];
                    let spoken = say(voice, text, 0);
                    let level = active_rms(&spoken);
                    speech.extend(spoken.iter().map(|value| value / level * 0.1));
                    speech.extend(std::iter::repeat_n(0.0, RATE * 5));
                    let capture = Arc::new(Capture { languages: vec!["en".into(), "tr".into()], ..Capture::new("trailing".into()) });
                    let (typed, _, _) = dictate(&mut engine, &capture, &mix(&speech, 11));
                    let expected = normalized_words(text);
                    let typed_words = normalized_words(&typed);
                    // Recognition may vary a word; it may not add any after the last.
                    let extra = typed_words.len() > expected.len()
                        || typed_words.last() != expected.last();
                    eprintln!("TRAILING {} {condition}: {text} typed {typed:?}", if extra { "FAIL" } else { "ok  " });
                    if extra { failures.push(format!("{condition} after {text:?} typed {typed:?}")); }
                }
            }
            assert!(failures.is_empty(), "{failures:#?}");
        }
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
pub fn speech_start(id: String, language: String, languages: Option<Vec<String>>, input_device_id: Option<String>, silence_stop_ms: Option<u64>) -> Result<(), String> {
    let _ = (id, language, languages, input_device_id, silence_stop_ms);
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
    const TARGET_RATE: usize = 16_000;
    if rate == 0 || samples.is_empty() {
        return Vec::new();
    }
    if rate as usize == TARGET_RATE {
        return samples.to_vec();
    }
    let length = (samples.len() as u128 * TARGET_RATE as u128 / rate as u128) as usize;
    if length == 0 {
        return Vec::new();
    }

    // A centered Blackman-windowed sinc keeps snapshot timestamps unchanged. At
    // 44.1/48 kHz, its 7.2 kHz cutoff preserves speech through 6.4 kHz and rejects
    // frequencies above the output Nyquist limit instead of folding them into speech.
    let ratio = rate as f64 / TARGET_RATE as f64;
    let cutoff = 0.45 / ratio.max(1.0);
    let radius = (32.0 * ratio.max(1.0)).ceil().min(512.0) as usize;
    let (mut divisor, mut remainder) = (rate as usize, TARGET_RATE);
    while remainder != 0 {
        (divisor, remainder) = (remainder, divisor % remainder);
    }
    let rational_phases = TARGET_RATE / divisor;
    // Common capture rates use exact rational phases (160 for 44.1 kHz, one for
    // 48 kHz). Interpolate a bounded table for unusual rates rather than allocating
    // thousands of kernels. Trigonometry is confined to this table construction.
    let phases = rational_phases.min(512);
    let kernel_count = phases + usize::from(rational_phases > phases);
    let kernels: Vec<Vec<f32>> = (0..kernel_count)
        .map(|phase| {
            let fraction = phase as f64 / phases as f64;
            let weights: Vec<f64> = (0..=2 * radius)
                .map(|tap| {
                    let distance = tap as f64 - radius as f64 - fraction;
                    if distance.abs() >= radius as f64 {
                        return 0.0;
                    }
                    let angle = std::f64::consts::PI * distance / radius as f64;
                    let window = 0.42 + 0.5 * angle.cos() + 0.08 * (2.0 * angle).cos();
                    let sinc_angle = 2.0 * std::f64::consts::PI * cutoff * distance;
                    let sinc = if sinc_angle == 0.0 {
                        1.0
                    } else {
                        sinc_angle.sin() / sinc_angle
                    };
                    2.0 * cutoff * sinc * window
                })
                .collect();
            let sum: f64 = weights.iter().sum();
            weights
                .into_iter()
                .map(|weight| (weight / sum) as f32)
                .collect()
        })
        .collect();

    let mut output = Vec::with_capacity(length);
    let (mut center, mut fraction) = (0usize, 0usize);
    for _ in 0..length {
        let table_position = fraction * phases;
        let phase = table_position / TARGET_RATE;
        let blend = (table_position % TARGET_RATE) as f32 / TARGET_RATE as f32;
        let convolve = |kernel: &[f32]| {
            if center >= radius && center + radius < samples.len() {
                samples[center - radius..=center + radius]
                    .iter()
                    .zip(kernel)
                    .map(|(sample, weight)| sample * weight)
                    .sum::<f32>()
            } else {
                // Extend endpoints to preserve DC even for very short snapshots.
                // Only the last filter radius can change when a snapshot grows.
                kernel
                    .iter()
                    .enumerate()
                    .map(|(tap, weight)| {
                        let source = (center + tap).saturating_sub(radius).min(samples.len() - 1);
                        samples[source] * weight
                    })
                    .sum::<f32>()
            }
        };
        let value = convolve(&kernels[phase]);
        output.push(if blend == 0.0 {
            value
        } else {
            value + (convolve(&kernels[phase + 1]) - value) * blend
        });
        // Integer source positions avoid cumulative phase drift across long takes
        // and keep every existing interior sample identical on the next snapshot.
        fraction += rate as usize;
        center += fraction / TARGET_RATE;
        fraction %= TARGET_RATE;
    }
    output
}

#[cfg(any(target_os = "macos", test))]
/// Brings quiet speech (a soft voice, a microphone across the desk: -50 to
/// -65 dBFS) up to a normal level before the speech gates, which use fixed
/// thresholds and dropped it whole. Applied only when the loud frames stand
/// clearly above the quiet ones (speech over a noise floor); silence and
/// steady noise are left as they are, so nothing is made out of them.
/// Recognition itself is level-independent (its spectrogram is normalized).
fn normalize_level(audio: &mut [f32]) {
    const FRAME: usize = 320;
    const TARGET: f32 = 0.0025; // mean square of -26 dBFS speech
    const MIN_CONTRAST: f32 = 8.0; // loud over quiet frames: about 9 dB
    const MAX_GAIN: f32 = 31.6; // 30 dB
    let mut energies: Vec<f32> = audio.chunks_exact(FRAME).map(|frame| frame.iter().map(|sample| sample * sample).sum::<f32>() / FRAME as f32).collect();
    if energies.len() < 10 {
        return;
    }
    energies.sort_by(f32::total_cmp);
    let floor = energies[energies.len() / 10].max(1e-10);
    let speech = energies[energies.len() * 95 / 100];
    if speech >= TARGET || speech < floor * MIN_CONTRAST {
        return;
    }
    let peak = audio.iter().fold(0.0f32, |peak, sample| peak.max(sample.abs()));
    let gain = (TARGET / speech).sqrt().min(MAX_GAIN).min(0.95 / peak.max(1e-6));
    if gain > 1.0 {
        audio.iter_mut().for_each(|sample| *sample *= gain);
    }
}

// ---- Dictation: which audio of a decode window is speech ----

/// A frame the voice activity model gives at least this probability is
/// speech here. Lower than the threshold that starts the live indicator
/// (DictationActivity::SPEECH_ON): this decides what may be decoded and
/// typed, so soft and distant speech must still count.
#[cfg(any(target_os = "macos", test))]
const VOICED_PROBABILITY: f32 = 0.3;
/// Speech that makes a stretch of audio worth decoding: 60 ms the voice
/// model heard as speech, or, in audio it has not analyzed, 200 ms of
/// sustained level (rather than silence or a single click).
#[cfg(any(target_os = "macos", test))]
const VOICED_FRAMES: usize = 3;
#[cfg(any(target_os = "macos", test))]
const LOUD_FRAMES: usize = 10;
/// Word timestamps can be off by a few hundred milliseconds, so a word
/// counts as spoken when speech lies within this many frames (0.5 s) of it.
#[cfg(any(target_os = "macos", test))]
const WORD_MARGIN_FRAMES: usize = 25;
/// Within that margin, a known silence phrase is dropped only when the voice
/// model heard nothing for this many frames (0.2 s) around it too, so a
/// spoken "thank you" with a late timestamp is still typed.
#[cfg(any(target_os = "macos", test))]
const UNSPOKEN_MARGIN_FRAMES: usize = 10;

/// Speech in each 20 ms frame of a decode window's 16 kHz audio: the voice
/// activity model's verdict where it analyzed the frame, else the level.
#[cfg(any(target_os = "macos", test))]
struct SpeechMask {
    // Some(speech) where the voice model analyzed the frame.
    heard: Vec<Option<bool>>,
    // Mean square over -46 dBFS: the level gate used without the model.
    loud: Vec<bool>,
}

#[cfg(any(target_os = "macos", test))]
impl SpeechMask {
    const FRAME: usize = 320;

    /// `audio` is the (level-normalized) window and `probabilities` the voice
    /// model's per frame; missing or None frames are judged by the level.
    fn new(audio: &[f32], probabilities: &[Option<f32>]) -> Self {
        let loud: Vec<bool> = audio.chunks_exact(Self::FRAME)
            .map(|frame| frame.iter().map(|sample| sample * sample).sum::<f32>() / Self::FRAME as f32 > 0.000025)
            .collect();
        let heard = (0..loud.len())
            .map(|frame| probabilities.get(frame).copied().flatten().map(|probability| probability >= VOICED_PROBABILITY))
            .collect();
        Self { heard, loud }
    }

    fn voiced(&self, frame: usize) -> bool {
        self.heard[frame].unwrap_or(self.loud[frame])
    }

    /// Whether the audio from sample `from` on holds speech.
    fn speech_after(&self, from: usize) -> bool {
        let (mut heard, mut loud) = (0, 0);
        for frame in from / Self::FRAME..self.loud.len() {
            match self.heard[frame] {
                Some(speech) => heard += usize::from(speech),
                None => loud += usize::from(self.loud[frame]),
            }
        }
        heard >= VOICED_FRAMES || loud >= LOUD_FRAMES
    }

    /// The frames of a word's audio (`start..end` in samples), clamped to
    /// the window: a word timed into the padding after it maps to its end.
    fn frames(&self, start: usize, end: usize) -> Option<std::ops::RangeInclusive<usize>> {
        let last = self.loud.len().checked_sub(1)?;
        let first = (start / Self::FRAME).min(last);
        Some(first..=(end.saturating_sub(1) / Self::FRAME).clamp(first, last))
    }

    /// Whether speech lies within WORD_MARGIN_FRAMES of a word's audio.
    fn near_speech(&self, start: usize, end: usize) -> bool {
        self.frames(start, end).is_some_and(|span| {
            let last = self.loud.len() - 1;
            (span.start().saturating_sub(WORD_MARGIN_FRAMES)..=(span.end() + WORD_MARGIN_FRAMES).min(last))
                .any(|frame| self.voiced(frame))
        })
    }

    /// Whether the voice model analyzed a word's audio and the
    /// UNSPOKEN_MARGIN_FRAMES around it, and heard no speech in any of it.
    fn unspoken(&self, start: usize, end: usize) -> bool {
        self.frames(start, end).is_some_and(|span| {
            let last = self.loud.len() - 1;
            (span.start().saturating_sub(UNSPOKEN_MARGIN_FRAMES)..=(span.end() + UNSPOKEN_MARGIN_FRAMES).min(last))
                .all(|frame| self.heard[frame] == Some(false))
        })
    }
}

/// What speech models typically "hear" in silence: the closing lines of the
/// subtitled videos they learned from. Removed only from audio the voice
/// model heard no speech in (native::drop_unspoken), never by text alone.
#[cfg(any(target_os = "macos", test))]
const SILENCE_PHRASES: &[&str] = &[
    "you", "bye", "bye bye", "thank you", "thank you very much", "thanks for watching", "thank you for watching",
    "thank you so much for watching", "please subscribe", "subtitles by the amara.org community",
    "izlediğiniz için teşekkür ederim", "izlediğiniz için teşekkürler", "teşekkür ederim", "teşekkürler",
    "abone olmayı unutmayın", "altyazı m.k.",
    "untertitel der amara.org-community", "untertitel im auftrag des zdf für funk 2017", "vielen dank", "danke fürs zuschauen",
    "sous-titres réalisés para la communauté d'amara.org", "merci d'avoir regardé", "merci",
    "gracias", "gracias por ver", "subtítulos realizados por la comunidad de amara.org", "obrigado",
    "спасибо за просмотр", "продолжение следует", "ご視聴ありがとうございました", "谢谢观看", "시청해주셔서 감사합니다",
];

/// The most words in one SILENCE_PHRASES entry.
#[cfg(any(target_os = "macos", test))]
const SILENCE_PHRASE_WORDS: usize = 8;

/// Lowercase words without surrounding punctuation, for SILENCE_PHRASES.
/// Turkish "İ" lowercases to "i" plus a combining dot, which is dropped.
#[cfg(any(target_os = "macos", test))]
fn phrase_words<'a>(words: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    words.into_iter().flat_map(str::split_whitespace)
        .map(|word| word.trim_matches(|character: char| !character.is_alphanumeric()).to_lowercase().replace('\u{307}', ""))
        .filter(|word| !word.is_empty())
        .collect()
}

/// Whether decoded words read exactly as one of SILENCE_PHRASES.
#[cfg(any(target_os = "macos", test))]
fn silence_phrase<'a>(words: impl IntoIterator<Item = &'a str>) -> bool {
    let words = phrase_words(words);
    !words.is_empty() && SILENCE_PHRASES.iter().any(|phrase| phrase_words([*phrase]) == words)
}

/// The speech languages PzzaCode supports, in priority order, read from the
/// app's single list (src/supportedLanguages.ts) when compiled, so adding or
/// removing a language there changes recognition too.
#[cfg(any(target_os = "macos", test))]
fn supported_languages() -> &'static [&'static str] {
    static LANGUAGES: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    LANGUAGES.get_or_init(|| {
        include_str!("../../src/supportedLanguages.ts").split("code: \"").skip(1)
            .filter_map(|entry| entry.split('"').next()).collect()
    })
}

// A supported language outside "My languages" is chosen only when it holds
// at least this share of the supported languages' probability.
#[cfg(any(target_os = "macos", test))]
const OUTSIDE_LANGUAGE_SHARE: f32 = 0.9;
// Continuity between utterances: when the user's languages are this close,
// the language of the previous utterance stays. A clear switch (another
// language at least this many times as likely) is followed at once. There is
// deliberately no fixed "main language" bias: it used to be the most often
// detected language, so every misdetection strengthened itself.
#[cfg(any(target_os = "macos", test))]
const CONTINUITY_ADVANTAGE: f32 = 1.5;
// An unsure decision (short turns like "Selam" or "İyiyim, sen?" spread their
// weight over unrelated languages) keeps the previous language unless the top
// one is clearly ahead: measured with the real model, 1.5 let that noise switch
// Turkish speech to English and decode it in English.
#[cfg(any(target_os = "macos", test))]
const UNSURE_CONTINUITY_ADVANTAGE: f32 = 2.5;
// A decision with at least this share is certain enough to type live words
// and to remember.
#[cfg(any(target_os = "macos", test))]
const CONFIDENT_SHARE: f32 = 0.5;

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, PartialEq)]
struct LanguageChoice {
    language: String,
    // Share of the supported languages' probability.
    share: f32,
    confident: bool,
}

/// Decides the spoken language from the detector's probabilities for one
/// stretch of audio: restricted to the supported languages, then to the
/// user's own (`preferred`, in any order) unless another language is
/// overwhelmingly likely. The most likely of the user's languages wins; only
/// a close call keeps the `previous` utterance's language, so the reply
/// language follows the user when they switch.
#[cfg(any(target_os = "macos", test))]
fn choose_language(probabilities: &[(&str, f32)], preferred: &[String], previous: Option<&str>) -> Option<LanguageChoice> {
    let supported: Vec<(&str, f32)> = probabilities.iter().copied()
        .filter(|(language, probability)| supported_languages().contains(language) && probability.is_finite() && *probability > 0.0)
        .collect();
    let mass: f32 = supported.iter().map(|(_, probability)| probability).sum();
    if mass <= 0.0 { return None; }
    let share = |language: &str| supported.iter().find(|(code, _)| *code == language).map_or(0.0, |(_, probability)| probability / mass);
    let choice = |language: &str| {
        let share = share(language);
        LanguageChoice { language: language.to_owned(), share, confident: share >= CONFIDENT_SHARE }
    };
    let (best, _) = supported.iter().copied().fold(("", f32::NEG_INFINITY), |top, entry| if entry.1 > top.1 { entry } else { top });
    let own: Vec<&str> = preferred.iter().map(String::as_str).filter(|language| supported_languages().contains(language)).collect();
    if own.is_empty() || (!own.contains(&best) && share(best) >= OUTSIDE_LANGUAGE_SHARE) {
        return Some(choice(best));
    }
    let top = own.iter().copied().fold(own[0], |top, language| if share(language) > share(top) { language } else { top });
    let advantage = if share(top) >= CONFIDENT_SHARE { CONTINUITY_ADVANTAGE } else { UNSURE_CONTINUITY_ADVANTAGE };
    let kept = previous.filter(|language| own.contains(language) && *language != top && share(top) < share(language) * advantage);
    Some(choice(kept.unwrap_or(top)))
}

// ---- Dictation: speech activity and stopping after silence ----

/// Accepted "Stop after silence" values from the interface.
#[cfg(any(target_os = "macos", test))]
const SILENCE_STOP_RANGE_MS: std::ops::RangeInclusive<u64> = 1_000..=60_000;
/// Speech heard before the chosen quiet can end a recording.
#[cfg(any(target_os = "macos", test))]
const SILENCE_STOP_MIN_SPEECH_MS: usize = 300;
/// Quiet that ends a recording in which nothing was said yet: people often
/// start a recording and then think before speaking.
#[cfg(any(target_os = "macos", test))]
const SILENCE_STOP_GRACE_MS: usize = 8_000;

/// Whether a dictation should end on its own: `stop_after_ms` of unbroken
/// quiet once speech was heard (the longer grace before any), never while
/// speech is being heard and never when the setting is off.
#[cfg(any(target_os = "macos", test))]
fn silence_stop_due(stop_after_ms: Option<usize>, heard_ms: usize, quiet_ms: usize, hearing: bool) -> bool {
    let Some(after) = stop_after_ms.filter(|ms| *ms > 0) else { return false; };
    let needed = if heard_ms >= SILENCE_STOP_MIN_SPEECH_MS { after } else { after.max(SILENCE_STOP_GRACE_MS) };
    !hearing && quiet_ms >= needed
}

/// Speech activity on the dictation microphone, in 20 ms frames of 16 kHz
/// audio. `hearing` (speech now, with hysteresis) drives the live indicator
/// at the caret; `quiet_ms` counts frames in which both the level and the
/// voice activity model are quiet, so breath, a soft word or a short pause
/// mid-sentence restarts it and only real silence can end a recording.
#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct DictationActivity {
    noise: f32,
    frames: usize,
    recent: std::collections::VecDeque<bool>,
    hearing: bool,
    since_voiced_ms: usize,
    heard_ms: usize,
    quiet_ms: usize,
}

#[cfg(any(target_os = "macos", test))]
impl DictationActivity {
    const FRAME: usize = 320;
    // About -70 dBFS: digital silence never turns its own noise into speech.
    const MIN_GATE: f32 = 1e-7;
    // A level about 6 dB over the room's floor is sound worth waiting for.
    const OVER_NOISE: f32 = 4.0;
    // Voice activity probabilities that start speech, and keep it going.
    const SPEECH_ON: f32 = 0.5;
    const SPEECH_HOLD: f32 = 0.35;
    // Hearing turns on with 100 ms of speech in 200 ms and off after this
    // much without any, so the indicator does not flicker between words.
    const ONSET_WINDOW: usize = 10;
    const ONSET_FRAMES: usize = 5;
    const RELEASE_MS: usize = 700;

    /// Feeds one frame's mean-square energy and the voice activity model's
    /// probability (None while the model is unavailable: level alone then
    /// decides). Returns the new hearing state when it changes.
    fn frame(&mut self, energy: f32, probability: Option<f32>) -> Option<bool> {
        self.frames += 1;
        // Minimum statistics: the floor drops at once to quieter frames and
        // rises about 4 dB per second toward louder ones (0.4 dB while speech
        // is heard), so steady noise is learned but speech is not.
        let rise = if self.hearing { 1.002 } else { 1.02 };
        self.noise = if self.frames == 1 { energy } else if energy < self.noise { self.noise * 0.8 + energy * 0.2 } else { (self.noise * rise).min(energy) }.max(1e-12);
        let loud = energy > (self.noise * Self::OVER_NOISE).max(Self::MIN_GATE);
        let voice = probability.is_none_or(|p| p >= if self.hearing { Self::SPEECH_HOLD } else { Self::SPEECH_ON });
        let voiced = loud && voice;
        if voiced { self.heard_ms += 20; }
        let active = loud || probability.is_some_and(|p| p >= Self::SPEECH_HOLD);
        self.quiet_ms = if active { 0 } else { self.quiet_ms + 20 };
        self.recent.push_back(voiced);
        if self.recent.len() > Self::ONSET_WINDOW { self.recent.pop_front(); }
        self.since_voiced_ms = if voiced { 0 } else { self.since_voiced_ms + 20 };
        let hearing = if self.hearing {
            self.since_voiced_ms < Self::RELEASE_MS
        } else {
            self.recent.iter().filter(|voiced| **voiced).count() >= Self::ONSET_FRAMES
        };
        (hearing != self.hearing).then(|| { self.hearing = hearing; hearing })
    }

    fn stop_due(&self, stop_after_ms: Option<usize>) -> bool {
        silence_stop_due(stop_after_ms, self.heard_ms, self.quiet_ms, self.hearing)
    }
}

#[cfg(test)]
mod dictation_activity_tests {
    use super::*;

    fn feed(activity: &mut DictationActivity, ms: usize, energy: f32, probability: Option<f32>) -> Vec<bool> {
        (0..ms / 20).filter_map(|_| activity.frame(energy, probability)).collect()
    }

    // A recording that starts with a second of room noise.
    fn settled() -> DictationActivity {
        let mut activity = DictationActivity::default();
        feed(&mut activity, 1_000, 1e-6, Some(0.02));
        activity
    }

    #[test]
    fn silence_stop_needs_speech_quiet_and_the_setting() {
        assert!(!silence_stop_due(None, 5_000, 60_000, false), "Off never stops");
        assert!(!silence_stop_due(Some(5_000), 5_000, 4_980, false));
        assert!(silence_stop_due(Some(5_000), 5_000, 5_000, false));
        assert!(!silence_stop_due(Some(5_000), 5_000, 60_000, true), "Never while speech is heard");
        // Nothing said yet: the longer grace, or the setting when it is longer.
        assert!(!silence_stop_due(Some(3_000), 0, 7_980, false));
        assert!(silence_stop_due(Some(3_000), 0, SILENCE_STOP_GRACE_MS, false));
        assert!(!silence_stop_due(Some(10_000), 0, 9_980, false));
        assert!(silence_stop_due(Some(10_000), 200, 10_000, false));
        assert!(silence_stop_due(Some(3_000), SILENCE_STOP_MIN_SPEECH_MS, 3_000, false));
    }

    #[test]
    fn speech_is_heard_within_a_fraction_of_a_second_and_released_after_it() {
        let mut activity = settled();
        let changes: Vec<bool> = (0..20).filter_map(|_| activity.frame(1e-3, Some(0.9))).collect();
        assert_eq!(changes, vec![true]);
        // Hearing began on the fifth voiced frame: 100 ms after onset.
        let mut fresh = settled();
        let onset = (1..=20).find(|_| fresh.frame(1e-3, Some(0.9)) == Some(true)).unwrap();
        assert_eq!(onset, DictationActivity::ONSET_FRAMES);
        // Short gaps between words keep it on; a longer quiet turns it off.
        assert!(feed(&mut activity, 400, 1e-6, Some(0.05)).is_empty());
        assert!(feed(&mut activity, 200, 1e-3, Some(0.9)).is_empty());
        assert_eq!(feed(&mut activity, 1_000, 1e-6, Some(0.05)), vec![false]);
    }

    #[test]
    fn pauses_mid_sentence_never_end_a_recording() {
        let mut activity = settled();
        for _ in 0..10 {
            feed(&mut activity, 1_500, 2e-4, Some(0.9));
            // A long thinking pause, shorter than the setting.
            feed(&mut activity, 4_000, 1e-6, Some(0.05));
            assert!(!activity.stop_due(Some(5_000)));
        }
        // Breath or a soft word that the model still calls speech restarts
        // the count even when it is barely above the room.
        feed(&mut activity, 4_000, 1e-6, Some(0.05));
        feed(&mut activity, 40, 1.2e-6, Some(0.5));
        feed(&mut activity, 4_000, 1e-6, Some(0.05));
        assert!(!activity.stop_due(Some(5_000)));
        // A sound the model does not call speech still counts as not quiet.
        feed(&mut activity, 60, 5e-4, Some(0.1));
        feed(&mut activity, 4_960, 1e-6, Some(0.05));
        assert!(!activity.stop_due(Some(5_000)));
        feed(&mut activity, 40, 1e-6, Some(0.05));
        assert!(activity.stop_due(Some(5_000)), "Five seconds of quiet after speech end it");
    }

    #[test]
    fn a_silent_start_waits_for_the_grace_and_steady_noise_is_learned() {
        let mut activity = DictationActivity::default();
        feed(&mut activity, 5_000, 1e-6, Some(0.02));
        assert!(!activity.stop_due(Some(5_000)), "No speech yet: wait the longer grace");
        feed(&mut activity, 3_000, 1e-6, Some(0.02));
        assert!(activity.stop_due(Some(5_000)));
        // A fan that starts mid-recording becomes the floor instead of
        // holding the recording open forever.
        let mut activity = settled();
        feed(&mut activity, 1_000, 2e-4, Some(0.9));
        feed(&mut activity, 12_000, 1e-4, Some(0.05));
        assert!(activity.stop_due(Some(5_000)));
    }

    #[test]
    fn without_the_voice_model_the_level_alone_decides() {
        let mut activity = settled();
        assert_eq!(feed(&mut activity, 300, 1e-3, None), vec![true]);
        feed(&mut activity, 4_000, 1e-6, None);
        assert!(!activity.stop_due(Some(5_000)));
        feed(&mut activity, 1_000, 1e-6, None);
        assert!(activity.stop_due(Some(5_000)));
    }
}

#[cfg(test)]
mod language_choice_tests {
    use super::*;

    fn mine(languages: &[&str]) -> Vec<String> {
        languages.iter().map(|language| (*language).to_owned()).collect()
    }

    fn chosen(probabilities: &[(&str, f32)], preferred: &[&str]) -> (String, bool) {
        chosen_after(probabilities, preferred, None)
    }

    fn chosen_after(probabilities: &[(&str, f32)], preferred: &[&str], previous: Option<&str>) -> (String, bool) {
        let choice = choose_language(probabilities, &mine(preferred), previous).unwrap();
        (choice.language, choice.confident)
    }

    #[test]
    fn the_supported_list_comes_from_the_app_and_names_engine_languages() {
        let languages = supported_languages();
        // English and Turkish are mandatory and lead the list.
        assert_eq!(&languages[..2], ["en", "tr"]);
        assert_eq!(languages.len(), include_str!("../../src/supportedLanguages.ts").matches("code: \"").count());
        for (index, code) in languages.iter().enumerate() {
            assert!(!languages[..index].contains(code), "{code} is listed twice");
            assert_eq!(whisper_rs::get_lang_id(code).and_then(whisper_rs::get_lang_str), Some(*code), "{code} is not a speech engine language");
        }
    }


    #[test]
    fn the_most_likely_of_my_languages_wins_whatever_their_order() {
        // There is no fixed main language: the detector's evidence decides.
        assert_eq!(chosen(&[("en", 0.93), ("tr", 0.05)], &["tr", "en"]), ("en".into(), true));
        assert_eq!(chosen(&[("tr", 0.97), ("en", 0.02)], &["tr", "en"]), ("tr".into(), true));
        assert_eq!(chosen(&[("tr", 0.81), ("en", 0.12), ("az", 0.05)], &["en", "tr"]), ("tr".into(), true));
        assert_eq!(chosen(&[("en", 0.55), ("tr", 0.40)], &["tr", "en"]).0, "en");
        assert_eq!(chosen(&[("en", 0.55), ("tr", 0.40)], &["en", "tr"]).0, "en");
    }

    #[test]
    fn close_calls_keep_the_previous_language_and_clear_switches_follow_the_user() {
        // A close call stays in the language of the previous utterance...
        assert_eq!(chosen_after(&[("en", 0.55), ("tr", 0.40)], &["tr", "en"], Some("tr")).0, "tr");
        assert_eq!(chosen_after(&[("tr", 0.55), ("en", 0.40)], &["tr", "en"], Some("en")).0, "en");
        // ...but switching languages is followed at once, both ways.
        assert_eq!(chosen_after(&[("en", 0.70), ("tr", 0.25)], &["tr", "en"], Some("tr")).0, "en");
        assert_eq!(chosen_after(&[("tr", 0.81), ("en", 0.12)], &["tr", "en"], Some("en")), ("tr".into(), true));
        // A previous language outside the user's languages has no pull.
        assert_eq!(chosen_after(&[("en", 0.55), ("tr", 0.40)], &["tr", "en"], Some("de")).0, "en");
        // Short turns measured with the real model: the weight is spread over
        // unrelated languages, so an unsure lead does not switch the language...
        assert_eq!(chosen_after(&[("ru", 0.12), ("ja", 0.12), ("en", 0.12), ("de", 0.10), ("tr", 0.07)], &["en", "tr"], Some("tr")).0, "tr");
        assert_eq!(chosen_after(&[("en", 0.47), ("tr", 0.36), ("ar", 0.03)], &["en", "tr"], Some("tr")).0, "tr");
        // ...while a clear lead still does, even when unsure.
        assert_eq!(chosen_after(&[("ru", 0.63), ("tr", 0.26), ("en", 0.01)], &["en", "tr"], Some("en")).0, "tr");
    }

    #[test]
    fn a_close_call_is_not_settled() {
        // The dictation failure: Turkish right after English with a detector
        // unsure on short audio: the decision is not settled (share under 0.8),
        // so later audio of the turn can still change it.
        let unsure = [("en", 0.48), ("tr", 0.36), ("az", 0.08), ("de", 0.03)];
        let choice = choose_language(&unsure, &mine(&["tr", "en"]), Some("en")).unwrap();
        assert!(choice.share < 0.8, "share {}", choice.share);
    }

    #[test]
    fn detection_stays_within_the_supported_languages() {
        // Azerbaijani is close to Turkish but not supported: its weight cannot win.
        assert_eq!(chosen(&[("az", 0.6), ("tr", 0.3), ("en", 0.1)], &[]), ("tr".into(), true));
        assert_eq!(chosen(&[("nn", 0.5), ("no", 0.3), ("da", 0.2)], &[]), ("no".into(), true));
        assert!(choose_language(&[("az", 1.0)], &[], None).is_none());
        assert!(choose_language(&[], &mine(&["tr"]), None).is_none());
    }

    #[test]
    fn other_languages_need_overwhelming_evidence_when_my_languages_are_set() {
        assert_eq!(chosen(&[("de", 0.96), ("en", 0.03), ("tr", 0.01)], &["tr", "en"]), ("de".into(), true));
        // A merely likely outside language goes to the most likely of mine,
        // reported as unsure.
        assert_eq!(chosen(&[("de", 0.7), ("en", 0.2), ("tr", 0.1)], &["tr", "en"]), ("en".into(), false));
        // Unsupported or unknown preferences are ignored.
        assert_eq!(chosen(&[("de", 0.7), ("en", 0.3)], &["xx"]), ("de".into(), true));
        // Without preferences the most likely supported language wins.
        assert_eq!(chosen(&[("pl", 0.3), ("cs", 0.25), ("sk", 0.2)], &[]), ("pl".into(), false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tone(rate: u32, frequency: f64, phase: f64, length: usize) -> Vec<f32> {
        (0..length)
            .map(|i| {
                (0.5 * (std::f64::consts::TAU * frequency * i as f64 / rate as f64 + phase).sin())
                    as f32
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples
            .iter()
            .map(|sample| (*sample as f64).powi(2))
            .sum::<f64>()
            / samples.len() as f64)
            .sqrt()
    }

    #[test]
    fn resampling_preserves_duration_and_amplitude() {
        for (rate, input_length, expected_length) in [
            (8_000, 1, 2),
            (8_000, 2_003, 4_006),
            (44_100, 3, 1),
            (44_100, 44_199, 16_035),
            (48_000, 3, 1),
            (48_000, 48_002, 16_000),
            (48_001, 48_001, 16_000),
            (96_000, 96_000, 16_000),
            (192_000, 192_000, 16_000),
        ] {
            let converted = resample(&vec![0.25; input_length], rate);
            assert_eq!(converted.len(), expected_length, "duration at {rate} Hz");
            assert!(
                converted
                    .iter()
                    .all(|value| (*value - 0.25).abs() < 0.000001),
                "DC at {rate} Hz"
            );
        }
    }

    #[test]
    fn resampling_handles_empty_zero_rate_and_sub_sample_inputs() {
        assert!(resample(&[], 0).is_empty());
        assert!(resample(&[], 48_000).is_empty());
        assert!(resample(&[0.25; 3], 0).is_empty());
        assert!(resample(&[0.25; 2], 48_000).is_empty());
    }

    #[test]
    fn resampling_at_target_rate_is_bit_exact() {
        let samples = [
            0.0,
            -0.0,
            0.125,
            -1.0,
            f32::MIN_POSITIVE,
            f32::INFINITY,
            f32::NAN,
        ];
        let converted = resample(&samples, 16_000);
        assert_eq!(
            converted
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            samples
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn resampling_rejects_above_nyquist_tones() {
        // Exclude the finite snapshot edges, where endpoint extension is not periodic.
        // The old 48 kHz decimator aliases these tones at essentially full amplitude.
        for rate in [44_100, 48_000] {
            let mut worst_db = f64::NEG_INFINITY;
            for frequency in (8_000..rate / 2).step_by(100) {
                let frequency = frequency as f64;
                let input = tone(rate, frequency, 0.37, rate as usize / 4);
                let converted = resample(&input, rate);
                let gain_db = 20.0
                    * (rms(&converted[64..converted.len() - 64]) / (0.5 / 2.0f64.sqrt())).log10();
                worst_db = worst_db.max(gain_db);
                assert!(
                    gain_db < -65.0,
                    "{rate} Hz input, {frequency} Hz tone: {gain_db:.2} dB"
                );
            }
            eprintln!("resample {rate} Hz: worst tested stopband gain {worst_db:.2} dB");
        }
    }

    #[test]
    fn resampling_preserves_speech_passband() {
        for rate in [44_100, 48_000] {
            for frequency in [100.0, 1_000.0, 3_000.0, 6_000.0, 6_400.0] {
                let input = tone(rate, frequency, 0.37, rate as usize / 4);
                let converted = resample(&input, rate);
                let reference = tone(16_000, frequency, 0.37, converted.len());
                let interior = 64..converted.len() - 64;
                let gain_db =
                    20.0 * (rms(&converted[interior.clone()]) / rms(&reference[interior])).log10();
                assert!(
                    gain_db.abs() < 0.01,
                    "{rate} Hz input, {frequency} Hz tone: {gain_db:.5} dB"
                );
            }
        }
    }

    #[test]
    fn resampling_preserves_absolute_phase_without_filter_delay() {
        // 44.1 kHz exercises all 160 exact phases; 48,001 Hz exercises bounded-table
        // interpolation. Compare against output timestamps, not a shifted best fit.
        for (rate, frequency) in [
            (44_100, 6_100.0),
            (48_000, 6_100.0),
            (48_001, 6_100.0),
            (8_000, 1_200.0),
        ] {
            let input = tone(rate, frequency, 0.71, rate as usize);
            let converted = resample(&input, rate);
            let reference = tone(16_000, frequency, 0.71, converted.len());
            let max_error = converted[64..converted.len() - 64]
                .iter()
                .zip(&reference[64..reference.len() - 64])
                .map(|(actual, expected)| (actual - expected).abs())
                .fold(0.0f32, f32::max);
            assert!(max_error < 0.0001, "phase error at {rate} Hz: {max_error}");
        }
    }

    #[test]
    fn growing_snapshots_keep_the_existing_interior_bit_exact() {
        for rate in [44_100, 48_000, 48_001] {
            let input = tone(rate, 2_317.0, 0.71, rate as usize);
            let prefix = resample(&input[..rate as usize / 3 + 17], rate);
            let complete = resample(&input, rate);
            // The support is 32 output samples per side, rounded up in input units.
            let stable_length = prefix.len() - 34;
            assert_eq!(
                prefix[..stable_length],
                complete[..stable_length],
                "snapshot interior at {rate} Hz"
            );
            assert_ne!(
                prefix[stable_length..],
                complete[stable_length..prefix.len()],
                "fixture must exercise the growing right edge"
            );
        }
    }

    #[test]
    #[ignore = "Optimized conversion timing; no model required"]
    fn resampling_conversion_timing() {
        for rate in [44_100, 48_000] {
            for seconds in [8, 30] {
                let input = tone(rate, 1_317.0, 0.37, rate as usize * seconds);
                let iterations = 5;
                let started = std::time::Instant::now();
                for _ in 0..iterations {
                    let output = resample(std::hint::black_box(&input), rate);
                    assert_eq!(output.len(), seconds * 16_000);
                    std::hint::black_box(output);
                }
                let mean_ms = started.elapsed().as_secs_f64() * 1_000.0 / iterations as f64;
                eprintln!("resample {rate} Hz, {seconds}s snapshot: {mean_ms:.2} ms/call over {iterations} conversions");
            }
        }
    }
    // Without the voice model's verdict, the level alone decides.
    fn has_speech(audio: &[f32]) -> bool {
        SpeechMask::new(audio, &[]).speech_after(0)
    }

    #[test]
    fn silence_and_clicks_do_not_trigger_recognition() {
        assert!(!has_speech(&vec![0.0; 16_000]));
        let mut click = vec![0.0; 16_000];
        click[500] = 1.0;
        assert!(!has_speech(&click));
        assert!(has_speech(&vec![0.02; 3_200]));
    }

    #[test]
    fn the_voice_model_decides_where_it_listened_and_the_level_elsewhere() {
        let probabilities = |parts: &[(usize, Option<f32>)]| parts.iter().flat_map(|(frames, probability)| vec![*probability; *frames]).collect::<Vec<_>>();
        // Steady noise over the level gate (a fan, typing) that the model calls noise.
        let noise: Vec<f32> = (0..32_000).map(|index| (((index * 7919) % 1000) as f32 / 1000.0 - 0.5) * 0.04).collect();
        assert!(has_speech(&noise));
        assert!(!SpeechMask::new(&noise, &probabilities(&[(100, Some(0.1))])).speech_after(0));
        // Soft speech the level misses but the model hears.
        let soft = vec![0.001; 32_000];
        assert!(!has_speech(&soft));
        assert!(SpeechMask::new(&soft, &probabilities(&[(40, Some(0.02)), (10, Some(0.6)), (50, Some(0.02))])).speech_after(0));
        // A 40 ms blip of probability is not speech; 60 ms is.
        assert!(!SpeechMask::new(&soft, &probabilities(&[(40, Some(0.02)), (2, Some(0.9)), (58, Some(0.02))])).speech_after(0));
        assert!(SpeechMask::new(&soft, &probabilities(&[(40, Some(0.02)), (3, Some(0.9)), (57, Some(0.02))])).speech_after(0));
        // Frames not analyzed yet (the newest audio) fall back to the level.
        let mut tail = vec![0.0f32; 24_000];
        tail.extend(vec![0.02; 8_000]);
        assert!(SpeechMask::new(&tail, &probabilities(&[(75, Some(0.02))])).speech_after(0));
        assert!(!SpeechMask::new(&tail, &probabilities(&[(100, Some(0.02))])).speech_after(0));
        // Only audio from the given sample on counts.
        let speech_then_quiet = SpeechMask::new(&vec![0.02; 32_000], &probabilities(&[(50, Some(0.9)), (50, Some(0.05))]));
        assert!(speech_then_quiet.speech_after(0));
        assert!(!speech_then_quiet.speech_after(16_000));
    }

    #[test]
    fn words_near_speech_count_as_spoken_and_padding_maps_to_the_end() {
        let mut probabilities = vec![Some(0.9); 50];
        probabilities.extend(vec![Some(0.02); 100]);
        let mask = SpeechMask::new(&vec![0.0; 48_000], &probabilities);
        // Within half a second of the last voiced frame (frame 49, 1.0 s).
        assert!(mask.near_speech(23_000, 26_000));
        assert!(!mask.near_speech(26_000, 30_000));
        // Zero-length and reversed spans, and spans past the window, stay in range.
        assert!(mask.near_speech(10_000, 10_000));
        assert!(!mask.near_speech(90_000, 80_000));
        assert!(!SpeechMask::new(&[], &[]).near_speech(0, 1_000));
        // Unspoken: the model heard nothing in the word and 0.2 s around it.
        assert!(!mask.unspoken(17_000, 20_000));
        assert!(mask.unspoken(20_000, 26_000));
        assert!(!SpeechMask::new(&vec![0.0; 48_000], &[]).unspoken(20_000, 26_000), "without the model, never");
    }

    #[test]
    fn silence_phrases_match_whole_phrases_in_any_case_and_punctuation() {
        assert!(silence_phrase(["Thank", "you."]));
        assert!(silence_phrase(["İzlediğiniz", "için", "teşekkür", "ederim."]));
        assert!(silence_phrase(["Altyazı", "M.K."]));
        assert!(silence_phrase(["ご視聴ありがとうございました"]));
        assert!(!silence_phrase(["Thank", "you", "Berke."]));
        assert!(!silence_phrase(["Open", "settings."]));
        assert!(!silence_phrase(["..."]));
        let longest = SILENCE_PHRASES.iter().map(|phrase| phrase_words([*phrase]).len()).max().unwrap();
        assert_eq!(SILENCE_PHRASE_WORDS, longest);
    }

    #[test]
    fn quiet_speech_is_raised_and_noise_is_left_alone() {
        const RATE: usize = 16_000;
        let noise = |level: f32, seconds: f32| (0..(seconds * RATE as f32) as usize).map(|index| (((index * 7919) % 1000) as f32 / 1000.0 - 0.5) * level).collect::<Vec<f32>>();
        let tone = |level: f32, seconds: f32| (0..(seconds * RATE as f32) as usize).map(|index| (index as f32 * 0.07).sin() * level).collect::<Vec<f32>>();
        // Speech at about -60 dBFS over a -85 dBFS room: dropped before, kept now.
        let mut quiet: Vec<f32> = [noise(0.0002, 0.5), tone(0.0014, 2.0), noise(0.0002, 0.5)].concat();
        assert!(!has_speech(&quiet));
        normalize_level(&mut quiet);
        assert!(has_speech(&quiet));
        // Steady noise alone is never amplified into speech.
        let mut room = noise(0.0004, 3.0);
        let before = room.clone();
        normalize_level(&mut room);
        assert_eq!(room, before);
        // Normal speech is left as it is.
        let mut loud: Vec<f32> = [noise(0.001, 0.5), tone(0.2, 2.0)].concat();
        let before = loud.clone();
        normalize_level(&mut loud);
        assert_eq!(loud, before);
    }
}
