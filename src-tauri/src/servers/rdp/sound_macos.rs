//! macOS loopback for RDPSND: ScreenCaptureKit system audio (macOS 13+).
//!
//! ScreenCaptureKit mixes what applications play, whichever output device
//! they render to, and is covered by the Screen Recording permission the
//! display capture already needs. Taomni's own sounds are excluded. The stream
//! also requires a video output; it is reduced to 2x2 at 1 fps and ignored.

use std::ptr::{NonNull, null_mut};
use std::sync::Mutex;

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_core_audio_types::{
    AudioBuffer, kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved,
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
/// Planar audio carries one buffer per channel.
const MAX_BUFFERS: usize = 8;

/// `AudioBufferList` with room for [`MAX_BUFFERS`] buffers (the system type
/// declares a one-element variable-length array).
#[repr(C)]
struct BufferList {
    number_buffers: u32,
    buffers: [AudioBuffer; MAX_BUFFERS],
}

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
            let Some((samples, rate, channels)) = (unsafe { interleaved_f32(sample_buffer) })
            else {
                return;
            };
            let ivars = self.ivars();
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
        });
        unsafe { msg_send![super(this), init] }
    }
}

/// Copy one audio sample (32-bit float PCM, usually planar) into interleaved
/// frames. `None` for any other format or an unreadable buffer.
unsafe fn interleaved_f32(sample: &CMSampleBuffer) -> Option<(Vec<f32>, u32, u16)> {
    let description = unsafe { sample.format_description() }?;
    let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&description).as_ref() }?;
    if asbd.mFormatFlags & kAudioFormatFlagIsFloat == 0 || asbd.mBitsPerChannel != 32 {
        return None;
    }
    let empty = AudioBuffer {
        mNumberChannels: 0,
        mDataByteSize: 0,
        mData: null_mut(),
    };
    let mut list = BufferList {
        number_buffers: 0,
        buffers: [empty; MAX_BUFFERS],
    };
    let mut block: *mut CMBlockBuffer = null_mut();
    let status = unsafe {
        sample.audio_buffer_list_with_retained_block_buffer(
            null_mut(),
            (&raw mut list).cast(),
            size_of::<BufferList>(),
            None,
            None,
            kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            &mut block,
        )
    };
    // The retained block buffer owns the memory the list points into.
    let _block = NonNull::new(block).map(|block| unsafe { CFRetained::from_raw(block) });
    if status != 0 {
        return None;
    }
    let count = (list.number_buffers as usize).min(MAX_BUFFERS);
    let planes: Vec<&[f32]> = list.buffers[..count]
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
        let frames = planes.iter().map(|plane| plane.len()).min()?;
        let mut out = Vec::with_capacity(frames * planes.len());
        for frame in 0..frames {
            out.extend(planes.iter().map(|plane| plane[frame]));
        }
        Some((out, rate, u16::try_from(planes.len()).ok()?))
    } else {
        let channels = u16::try_from(asbd.mChannelsPerFrame).ok()?;
        Some((planes.first()?.to_vec(), rate, channels))
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
        unsafe { stream.addStreamOutput_type_sampleHandlerQueue_error(stream_output, kind, Some(&queue)) }
            .map_err(|_| format!("could not attach the ScreenCaptureKit output {kind:?}"))?;
    }
    sck::start_stream(&stream).map_err(|e| e.to_string())?;
    Ok((stream, output, queue))
}

pub(super) fn run(rate: u32, channels: u16, sink: WaveSink, stop: Stop, ready: Ready) {
    match start(rate, channels, sink) {
        Ok((stream, _output, _queue)) => {
            let _ = ready.send(Ok(format!(
                "ScreenCaptureKit system audio ({RATE} Hz)"
            )));
            let _ = stop.recv();
            sck::stop_stream(&stream);
        }
        Err(error) => {
            let _ = ready.send(Err(error));
        }
    }
}
