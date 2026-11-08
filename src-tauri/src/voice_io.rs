// Microphone capture through our own input callback (see TappedUnit), used by
// dictation.
#[cfg(target_os = "macos")]
mod native {
    use coreaudio::audio_unit::{AudioUnit, Element, Scope};

    /// An audio unit whose microphone is read through our own input callback.
    ///
    /// The library's input callback queries the unit's stream format on the
    /// audio thread whenever the buffer size changes. AudioOutputUnitStart
    /// holds the unit's lock while it waits for that thread, so the two can
    /// deadlock and leave the microphone on, blocking every later start. Here
    /// the buffer is allocated before the unit starts and the audio thread
    /// only renders into it.
    pub struct TappedUnit {
        unit: std::mem::ManuallyDrop<AudioUnit>,
        tap: *mut Tap,
    }

    struct Tap {
        unit: objc2_audio_toolbox::AudioUnit,
        channels: u32,
        buffer: Vec<f32>,
        on_input: Box<dyn FnMut(&[f32])>,
    }

    // Slices are normally a few hundred frames; units announce their maximum.
    const MIN_TAP_FRAMES: usize = 8192;

    impl TappedUnit {
        /// Installs the input callback on `unit` (not started yet). Samples
        /// arrive interleaved, `channels` per frame, in the unit's client format.
        pub fn new(mut unit: AudioUnit, channels: u32, on_input: impl FnMut(&[f32]) + 'static) -> Result<Self, String> {
            let largest: u32 = unit
                .get_property(objc2_audio_toolbox::kAudioUnitProperty_MaximumFramesPerSlice, Scope::Global, Element::Output)
                .unwrap_or(0);
            let frames = (largest as usize).max(MIN_TAP_FRAMES);
            let tap = Box::into_raw(Box::new(Tap {
                unit: *unit.as_ref(),
                channels,
                buffer: vec![0.0; frames * channels.max(1) as usize],
                on_input: Box::new(on_input),
            }));
            let callback = objc2_audio_toolbox::AURenderCallbackStruct { inputProc: Some(tap_input), inputProcRefCon: tap.cast() };
            if unit.set_property(objc2_audio_toolbox::kAudioOutputUnitProperty_SetInputCallback, Scope::Global, Element::Output, Some(&callback)).is_err() {
                // SAFETY: the callback was not installed, so nothing else holds `tap`.
                unsafe { drop(Box::from_raw(tap)) };
                return Err("Could not initialize microphone capture".into());
            }
            Ok(Self { unit: std::mem::ManuallyDrop::new(unit), tap })
        }
    }

    impl std::ops::Deref for TappedUnit {
        type Target = AudioUnit;
        fn deref(&self) -> &AudioUnit { &self.unit }
    }

    impl std::ops::DerefMut for TappedUnit {
        fn deref_mut(&mut self) -> &mut AudioUnit { &mut self.unit }
    }

    impl Drop for TappedUnit {
        fn drop(&mut self) {
            // Stop (synchronous: no callback runs afterwards) and dispose of the
            // unit before freeing the state its callback reads.
            let _ = self.unit.stop();
            // SAFETY: the unit is dropped exactly once, here, and the tap was
            // created by Box::into_raw in new() and is no longer referenced.
            unsafe {
                std::mem::ManuallyDrop::drop(&mut self.unit);
                drop(Box::from_raw(self.tap));
            }
        }
    }

    unsafe extern "C-unwind" fn tap_input(
        refcon: std::ptr::NonNull<std::ffi::c_void>,
        flags: std::ptr::NonNull<objc2_audio_toolbox::AudioUnitRenderActionFlags>,
        time: std::ptr::NonNull<objc2_core_audio_types::AudioTimeStamp>,
        bus: u32,
        frames: u32,
        _data: *mut objc2_core_audio_types::AudioBufferList,
    ) -> i32 {
        // SAFETY: refcon is the Tap installed in TappedUnit::new, alive until
        // the unit is stopped and disposed; the audio thread is its only user.
        let tap = unsafe { &mut *refcon.as_ptr().cast::<Tap>() };
        let samples = frames as usize * tap.channels as usize;
        // Larger than any slice the unit announced: skip it rather than
        // allocate or query the unit on the audio thread.
        if samples > tap.buffer.len() {
            return 0;
        }
        let mut list = objc2_core_audio_types::AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [objc2_core_audio_types::AudioBuffer {
                mNumberChannels: tap.channels,
                mDataByteSize: (samples * std::mem::size_of::<f32>()) as u32,
                mData: tap.buffer.as_mut_ptr().cast(),
            }],
        };
        // SAFETY: the unit is valid while its callback runs and the buffer
        // holds `frames` frames of the client format.
        let status = unsafe { objc2_audio_toolbox::AudioUnitRender(tap.unit, flags.as_ptr(), time, bus, frames, std::ptr::NonNull::from(&mut list)) };
        if status == 0 {
            (tap.on_input)(&tap.buffer[..samples]);
        }
        status
    }
}

#[cfg(target_os = "macos")]
pub use native::*;
