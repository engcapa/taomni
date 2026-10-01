//! macOS loopback for RDPSND: ScreenCaptureKit system audio (macOS 13+).
//!
//! ScreenCaptureKit mixes what applications play, whichever output device
//! they render to, and is covered by the Screen Recording permission the
//! display capture already needs. Taomni's own sounds are excluded. The stream
//! also requires a video output; it is reduced to 2x2 at 1 fps and ignored.

use std::mem::offset_of;
use std::ptr::{NonNull, null_mut};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime,
    kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
};
use objc2_foundation::{NSArray, NSError, NSObject};
use objc2_screen_capture_kit::{
    SCContentFilter, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamOutput,
    SCStreamOutputType,
};

use super::capture::{Ready, Stop};
use super::{WavePump, WaveSink};
use crate::servers::rdp::capture::mac::{permission_granted, sck};

/// Requested from ScreenCaptureKit; the delivered format is still read from
/// every sample.
const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;

struct Pump {
    rate: u32,
    channels: u16,
    pump: WavePump,
}

struct AudioOutputIvars {
    pump: Mutex<Pump>,
    sink: WaveSink,
    out_rate: u32,
    out_channels: u16,
    /// Audio sample buffers received / not convertible, for the stop note.
    buffers: AtomicU64,
    rejected: AtomicU64,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "TaomniRdpAudioCaptureOutput"]
    #[ivars = AudioOutputIvars]
    struct AudioOutput;

    unsafe impl SCStreamOutput for AudioOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn stream_did_output_sample_buffer(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            output_type: SCStreamOutputType,
        ) {
            if output_type != SCStreamOutputType::Audio {
                return;
            }
            let ivars = self.ivars();
            let index = ivars.buffers.fetch_add(1, Ordering::Relaxed);
            let (samples, rate, channels) = match unsafe { interleaved_f32(sample_buffer) } {
                Ok(converted) => converted,
                Err(reason) => {
                    if ivars.rejected.fetch_add(1, Ordering::Relaxed) == 0 {
                        ivars.sink.note(format!(
                            "RDP audio: unusable ScreenCaptureKit audio buffer: {reason}"
                        ));
                    }
                    return;
                }
            };
            if index == 0 {
                ivars.sink.note(format!(
                    "RDP audio: first ScreenCaptureKit audio buffer: {rate} Hz, {channels} channel(s), {} frame(s)",
                    samples.len() / usize::from(channels.max(1))
                ));
            }
            let Ok(mut state) = ivars.pump.lock() else {
                return;
            };
            if state.rate != rate || state.channels != channels {
                *state = Pump {
                    rate,
                    channels,
                    pump: WavePump::new(rate, channels, ivars.out_rate, ivars.out_channels),
                };
            }
            for packet in state.pump.push(&samples) {
                ivars.sink.send(packet);
            }
        }
    }

    unsafe impl SCStreamDelegate for AudioOutput {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn stream_did_stop_with_error(&self, _stream: &SCStream, _error: &NSError) {
            tracing::warn!("macOS stopped the RDP audio ScreenCaptureKit stream");
        }
    }
);

unsafe impl NSObjectProtocol for AudioOutput {}

impl AudioOutput {
    fn new(sink: WaveSink, out_rate: u32, out_channels: u16) -> Retained<Self> {
        let this = Self::alloc().set_ivars(AudioOutputIvars {
            pump: Mutex::new(Pump {
                rate: RATE,
                channels: CHANNELS,
                pump: WavePump::new(RATE, CHANNELS, out_rate, out_channels),
            }),
            sink,
            out_rate,
            out_channels,
            buffers: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
        });
        unsafe { msg_send![super(this), init] }
    }
}

/// Copy one audio sample (32-bit float PCM, usually planar) into interleaved
/// frames; the error says why a buffer is unusable.
unsafe fn interleaved_f32(sample: &CMSampleBuffer) -> Result<(Vec<f32>, u32, u16), String> {
    let description = unsafe { sample.format_description() }.ok_or("no format description")?;
    let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&description).as_ref() }
        .ok_or("not an audio format description")?;
    let format = format!(
        "{} Hz, {} channel(s), flags 0x{:x}, {} bits",
        asbd.mSampleRate, asbd.mChannelsPerFrame, asbd.mFormatFlags, asbd.mBitsPerChannel
    );
    if asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0 || asbd.mBitsPerChannel != 32 {
        return Err(format!("unsupported PCM ({format})"));
    }
    // Planar audio carries one buffer per channel, and the delivered channel
    // count is the device's, not necessarily the requested one: ask how
    // large the list must be instead of guessing.
    let flags = kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment;
    let mut needed = 0usize;
    let status = unsafe {
        sample.audio_buffer_list_with_retained_block_buffer(
            &mut needed,
            null_mut(),
            0,
            None,
            None,
            flags,
            null_mut(),
        )
    };
    let buffers_at = offset_of!(AudioBufferList, mBuffers);
    if status != 0 || needed < buffers_at {
        return Err(format!(
            "audio buffer list size unavailable (OSStatus {status}, {needed} bytes; {format})"
        ));
    }
    // u64 storage keeps the list pointer-aligned like the system type.
    let mut storage = vec![0u64; needed.div_ceil(size_of::<u64>())];
    let mut block: *mut CMBlockBuffer = null_mut();
    let status = unsafe {
        sample.audio_buffer_list_with_retained_block_buffer(
            null_mut(),
            storage.as_mut_ptr().cast(),
            storage.len() * size_of::<u64>(),
            None,
            None,
            flags,
            &mut block,
        )
    };
    // The retained block buffer owns the memory the list points into.
    let _block = NonNull::new(block).map(|block| unsafe { CFRetained::from_raw(block) });
    if status != 0 {
        return Err(format!(
            "audio buffer list unavailable (OSStatus {status}, {needed} bytes; {format})"
        ));
    }
    let list = storage.as_ptr().cast::<AudioBufferList>();
    let room = (storage.len() * size_of::<u64>() - buffers_at) / size_of::<AudioBuffer>();
    let count = (unsafe { (*list).mNumberBuffers } as usize).min(room);
    let buffers = unsafe {
        std::slice::from_raw_parts(
            storage
                .as_ptr()
                .cast::<u8>()
                .add(buffers_at)
                .cast::<AudioBuffer>(),
            count,
        )
    };
    let planes: Vec<&[f32]> = buffers
        .iter()
        .map(|buffer| {
            if buffer.mData.is_null() {
                &[][..]
            } else {
                unsafe {
                    std::slice::from_raw_parts(
                        buffer.mData.cast::<f32>(),
                        buffer.mDataByteSize as usize / 4,
                    )
                }
            }
        })
        .collect();
    let rate = asbd.mSampleRate as u32;
    if asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 {
        let frames = planes
            .iter()
            .map(|plane| plane.len())
            .min()
            .ok_or("no audio buffers")?;
        let mut out = Vec::with_capacity(frames * planes.len());
        for frame in 0..frames {
            out.extend(planes.iter().map(|plane| plane[frame]));
        }
        let channels = u16::try_from(planes.len()).map_err(|_| "too many channels")?;
        Ok((out, rate, channels))
    } else {
        let channels = u16::try_from(asbd.mChannelsPerFrame).map_err(|_| "too many channels")?;
        let samples = planes.first().ok_or("no audio buffers")?.to_vec();
        Ok((samples, rate, channels))
    }
}

type Running = (
    Retained<SCStream>,
    Retained<AudioOutput>,
    dispatch2::DispatchRetained<DispatchQueue>,
);

fn start(rate: u32, channels: u16, sink: WaveSink) -> Result<Running, String> {
    if !objc2::available!(macos = 13.0) {
        return Err("system audio capture needs macOS 13 or later".to_string());
    }
    if !permission_granted() {
        return Err(
            "the Screen Recording permission (which also covers system audio) is not granted"
                .to_string(),
        );
    }
    let content = sck::shareable_content().map_err(|e| e.to_string())?;
    let (display, _) = sck::select_display(&content, None).map_err(|e| e.to_string())?;
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &display,
            &NSArray::new(),
        )
    };
    let configuration = unsafe { SCStreamConfiguration::new() };
    unsafe {
        configuration.setWidth(2);
        configuration.setHeight(2);
        configuration.setMinimumFrameInterval(CMTime::new(1, 1));
        configuration.setQueueDepth(3);
        configuration.setShowsCursor(false);
        configuration.setCapturesAudio(true);
        configuration.setSampleRate(RATE as isize);
        configuration.setChannelCount(CHANNELS as isize);
        configuration.setExcludesCurrentProcessAudio(true);
    }
    let output = AudioOutput::new(sink, rate, channels);
    let delegate: &ProtocolObject<dyn SCStreamDelegate> = ProtocolObject::from_ref(&*output);
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &configuration,
            Some(delegate),
        )
    };
    let queue = DispatchQueue::new("taomni.rdp.audio", None);
    let stream_output: &ProtocolObject<dyn SCStreamOutput> = ProtocolObject::from_ref(&*output);
    for kind in [SCStreamOutputType::Screen, SCStreamOutputType::Audio] {
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(stream_output, kind, Some(&queue))
        }
        .map_err(|_| format!("could not attach the ScreenCaptureKit output {kind:?}"))?;
    }
    sck::start_stream(&stream).map_err(|e| e.to_string())?;
    Ok((stream, output, queue))
}

/// Default outputs whose input side returns what is played to them.
#[cfg(feature = "rdp-server-audio")]
const LOOPBACK_DEVICES: [&str; 2] = ["BlackHole", "Background Music"];

/// When the default output is a loopback virtual device, its input side
/// carries exactly what every process plays — including command-line tools
/// ScreenCaptureKit may attribute to no application — so it is preferred.
#[cfg(feature = "rdp-server-audio")]
fn virtual_loopback() -> Option<(cpal::Device, cpal::SupportedStreamConfig)> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let output = host.default_output_device()?;
    let name = super::cpal_capture::device_name(&output);
    if !LOOPBACK_DEVICES.iter().any(|known| name.contains(known)) {
        return None;
    }
    let input = host
        .input_devices()
        .ok()?
        .find(|device| super::cpal_capture::device_name(device) == name)?;
    let config = input.default_input_config().ok()?;
    Some((input, config))
}

pub(super) fn run(rate: u32, channels: u16, sink: WaveSink, stop: Stop, ready: Ready) {
    #[cfg(feature = "rdp-server-audio")]
    if let Some((device, config)) = virtual_loopback() {
        super::cpal_capture::run(
            device,
            config,
            |name, in_rate| format!("{name} input (loopback virtual device, {in_rate} Hz)"),
            rate,
            channels,
            sink,
            stop,
            ready,
        );
        return;
    }
    let diagnostics = sink.clone();
    match start(rate, channels, sink) {
        Ok((stream, output, _queue)) => {
            let _ = ready.send(Ok(format!("ScreenCaptureKit system audio ({RATE} Hz)")));
            let _ = stop.recv();
            sck::stop_stream(&stream);
            let ivars = output.ivars();
            diagnostics.note(format!(
                "RDP audio: ScreenCaptureKit delivered {} audio buffer(s), {} unusable",
                ivars.buffers.load(Ordering::Relaxed),
                ivars.rejected.load(Ordering::Relaxed)
            ));
        }
        Err(error) => {
            let _ = ready.send(Err(error));
        }
    }
}
