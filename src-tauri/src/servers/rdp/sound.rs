//! RDPSND audio playback for the RDP server (TASK-07, design §4.3).
//!
//! Whatever this computer plays is captured as a loopback stream and sent to
//! the client as PCM waves, like Windows Remote Desktop's "play on this
//! computer" redirection:
//! - Windows: WASAPI loopback (a cpal input stream on the output device);
//! - Linux: a PipeWire capture stream on the default sink's monitor;
//! - macOS 13+: ScreenCaptureKit system audio (`sound_macos.rs`).
//!
//! Capture runs on its own thread and pushes interleaved `f32` frames into a
//! [`WavePump`], which converts them to the negotiated 16-bit PCM format and
//! emits ~20 ms waves through the server event channel. A capture failure
//! only disables audio for that session.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use ironrdp::rdpsnd::pdu::{AudioFormat, WaveFormat};
use ironrdp::rdpsnd::server::{
    NegotiatedFormat, RdpsndError, RdpsndServerHandler, RdpsndServerMessage,
};
use ironrdp::server::tokio::sync::mpsc::UnboundedSender;
use ironrdp::server::{ServerEvent, ServerEventSender, SoundServerFactory};

use crate::servers::engine::LogEmitter;

/// Packet length: MS-RDPEA clients buffer a few of these; 20 ms keeps latency
/// close to Windows Remote Desktop without flooding the channel.
const WAVE_MS: u32 = 20;

fn pcm16(rate: u32, channels: u16) -> AudioFormat {
    AudioFormat {
        format: WaveFormat::PCM,
        n_channels: channels,
        n_samples_per_sec: rate,
        n_avg_bytes_per_sec: rate * u32::from(channels) * 2,
        n_block_align: channels * 2,
        bits_per_sample: 16,
        data: None,
    }
}

/// Formats offered to the client, in preference order.
fn server_formats() -> Vec<AudioFormat> {
    vec![pcm16(48_000, 2), pcm16(44_100, 2), pcm16(22_050, 2)]
}

/// Channel mapping + linear resampling of interleaved `f32` frames. Shared by
/// playback ([`WavePump`]) and microphone redirection (`audio_input.rs`).
pub(crate) struct Resampler {
    in_channels: usize,
    out_channels: usize,
    /// Input frames advanced per output frame.
    step: f64,
    /// Position of the next output frame between `prev` (0) and the
    /// incoming frame (1).
    phase: f64,
    prev: Option<Vec<f32>>,
}

impl Resampler {
    pub(crate) fn new(in_rate: u32, in_channels: u16, out_rate: u32, out_channels: u16) -> Self {
        Self {
            in_channels: usize::from(in_channels.max(1)),
            out_channels: usize::from(out_channels.max(1)),
            step: f64::from(in_rate.max(1)) / f64::from(out_rate.max(1)),
            phase: 0.0,
            prev: None,
        }
    }

    /// Mono is duplicated to every output channel; extra channels are dropped.
    fn map(&self, frame: &[f32]) -> Vec<f32> {
        (0..self.out_channels)
            .map(|channel| frame[channel.min(frame.len() - 1)])
            .collect()
    }

    /// Feed interleaved input; `emit` receives every interleaved output sample.
    pub(crate) fn process(&mut self, samples: &[f32], mut emit: impl FnMut(f32)) {
        for frame in samples.chunks_exact(self.in_channels) {
            let current = self.map(frame);
            let Some(prev) = self.prev.take() else {
                self.prev = Some(current);
                continue;
            };
            while self.phase < 1.0 {
                for (a, b) in prev.iter().zip(&current) {
                    emit(a + (b - a) * self.phase as f32);
                }
                self.phase += self.step;
            }
            self.phase -= 1.0;
            self.prev = Some(current);
        }
    }
}

/// Converts captured interleaved `f32` frames to the negotiated PCM16 format
/// and cuts them into waves.
pub(crate) struct WavePump {
    resampler: Resampler,
    pending: Vec<u8>,
    packet_bytes: usize,
}

impl WavePump {
    pub(crate) fn new(in_rate: u32, in_channels: u16, out_rate: u32, out_channels: u16) -> Self {
        let out_channels = out_channels.max(1);
        Self {
            resampler: Resampler::new(in_rate, in_channels, out_rate, out_channels),
            pending: Vec::new(),
            packet_bytes: (out_rate as usize * WAVE_MS as usize / 1000)
                * usize::from(out_channels)
                * 2,
        }
    }

    /// Feed interleaved input; returns every completed wave packet.
    pub(crate) fn push(&mut self, samples: &[f32]) -> Vec<Vec<u8>> {
        let pending = &mut self.pending;
        self.resampler.process(samples, |value| {
            let sample = (value.clamp(-1.0, 1.0) * 32767.0).round() as i16;
            pending.extend_from_slice(&sample.to_le_bytes());
        });
        let mut packets = Vec::new();
        while self.packet_bytes > 0 && self.pending.len() >= self.packet_bytes {
            packets.push(self.pending.drain(..self.packet_bytes).collect());
        }
        packets
    }
}

type SharedSender = Arc<Mutex<Option<UnboundedSender<ServerEvent>>>>;

/// The server event channel of the running server, stamped per session.
#[derive(Clone)]
pub(crate) struct WaveSink {
    sender: SharedSender,
    started: Instant,
}

impl WaveSink {
    pub(crate) fn send(&self, packet: Vec<u8>) {
        // wTimeStamp is a wrapping millisecond clock.
        let timestamp = self.started.elapsed().as_millis() as u32;
        if let Ok(sender) = self.sender.lock()
            && let Some(sender) = sender.as_ref()
        {
            let _ = sender.send(ServerEvent::Rdpsnd(RdpsndServerMessage::Wave(
                packet, timestamp,
            )));
        }
    }
}

pub(crate) struct SoundFactory {
    log: LogEmitter,
    sender: SharedSender,
}

impl SoundFactory {
    pub(crate) fn new(log: LogEmitter) -> Self {
        Self {
            log,
            sender: Arc::new(Mutex::new(None)),
        }
    }
}

impl ServerEventSender for SoundFactory {
    fn set_sender(&mut self, sender: UnboundedSender<ServerEvent>) {
        if let Ok(mut slot) = self.sender.lock() {
            *slot = Some(sender);
        }
    }
}

impl SoundServerFactory for SoundFactory {
    fn build_backend(&self) -> Box<dyn RdpsndServerHandler> {
        Box::new(SoundBackend {
            log: self.log.clone(),
            sender: Arc::clone(&self.sender),
            formats: server_formats(),
            capture: None,
        })
    }
}

struct SoundBackend {
    log: LogEmitter,
    sender: SharedSender,
    formats: Vec<AudioFormat>,
    capture: Option<capture::Loopback>,
}

impl core::fmt::Debug for SoundBackend {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SoundBackend")
            .field("capturing", &self.capture.is_some())
            .finish()
    }
}

impl RdpsndServerHandler for SoundBackend {
    fn get_formats(&self) -> &[AudioFormat] {
        &self.formats
    }

    fn choose_format<'a>(
        &mut self,
        common: &'a [NegotiatedFormat],
    ) -> Option<&'a NegotiatedFormat> {
        common.first()
    }

    fn start(&mut self, format: &NegotiatedFormat) -> Result<(), Box<dyn RdpsndError>> {
        let format = format.format();
        let sink = WaveSink {
            sender: Arc::clone(&self.sender),
            started: Instant::now(),
        };
        match capture::Loopback::start(format.n_samples_per_sec, format.n_channels, sink) {
            Ok((loopback, source)) => {
                self.log.line(format!(
                    "RDP audio: streaming {source} as PCM {} Hz, {} channel(s)",
                    format.n_samples_per_sec, format.n_channels
                ));
                self.capture = Some(loopback);
                Ok(())
            }
            Err(error) => {
                self.log
                    .line(format!("RDP audio unavailable on this computer: {error}"));
                Err(Box::new(std::io::Error::other(error)))
            }
        }
    }

    fn stop(&mut self) {
        if self.capture.take().is_some() {
            self.log.line("RDP audio stopped");
        }
    }
}

mod capture {
    use std::sync::mpsc::{Receiver, SyncSender};
    use std::time::Duration;

    use super::WaveSink;

    /// A running loopback capture; dropping it stops the capture thread.
    pub(crate) struct Loopback {
        stop: Option<SyncSender<()>>,
    }

    impl Loopback {
        /// Start capturing this computer's audio output for a session that
        /// negotiated `rate`/`channels`. Returns a description of the source.
        pub(crate) fn start(
            rate: u32,
            channels: u16,
            sink: WaveSink,
        ) -> Result<(Self, String), String> {
            let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
            let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
            std::thread::Builder::new()
                .name("rdp-audio-capture".to_string())
                .spawn(move || super::platform::run(rate, channels, sink, stop_rx, ready_tx))
                .map_err(|e| format!("could not start the capture thread: {e}"))?;
            let source = ready_rx
                .recv_timeout(Duration::from_secs(10))
                .map_err(|_| "audio capture did not start within 10 seconds".to_string())??;
            Ok((
                Self {
                    stop: Some(stop_tx),
                },
                source,
            ))
        }
    }

    impl Drop for Loopback {
        fn drop(&mut self) {
            if let Some(stop) = self.stop.take() {
                let _ = stop.try_send(());
            }
        }
    }

    /// Signature every platform capture thread implements.
    pub(crate) type Ready = SyncSender<Result<String, String>>;
    pub(crate) type Stop = Receiver<()>;
}

#[cfg(all(target_os = "windows", feature = "rdp-server-audio"))]
mod platform {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    use super::capture::{Ready, Stop};
    use super::{WavePump, WaveSink};

    /// WASAPI loopback: cpal opens an input stream on an output device with
    /// AUDCLNT_STREAMFLAGS_LOOPBACK, i.e. "what this computer plays".
    pub(super) fn run(rate: u32, channels: u16, sink: WaveSink, stop: Stop, ready: Ready) {
        let result = (|| -> Result<(cpal::Stream, String), String> {
            let device = cpal::default_host()
                .default_output_device()
                .ok_or_else(|| "no default audio output device".to_string())?;
            let name = device
                .description()
                .map(|d| d.name().to_string())
                .unwrap_or_else(|_| "default output".to_string());
            let config = device
                .default_output_config()
                .map_err(|e| format!("output format of {name}: {e}"))?;
            let (in_rate, in_channels) = (config.sample_rate(), config.channels());
            let stream_config: cpal::StreamConfig = config.config();
            let on_error = |error: cpal::StreamError| {
                tracing::warn!(%error, "RDP audio loopback stream error");
            };
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    let mut pump = WavePump::new(in_rate, in_channels, rate, channels);
                    let sink = sink.clone();
                    device.build_input_stream(
                        &stream_config,
                        move |data: &[f32], _| {
                            pump.push(data).into_iter().for_each(|p| sink.send(p))
                        },
                        on_error,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let mut pump = WavePump::new(in_rate, in_channels, rate, channels);
                    let sink = sink.clone();
                    device.build_input_stream(
                        &stream_config,
                        move |data: &[i16], _| {
                            let samples: Vec<f32> =
                                data.iter().map(|s| f32::from(*s) / 32768.0).collect();
                            pump.push(&samples).into_iter().for_each(|p| sink.send(p));
                        },
                        on_error,
                        None,
                    )
                }
                other => return Err(format!("unsupported loopback sample format {other:?}")),
            }
            .map_err(|e| format!("open loopback on {name}: {e}"))?;
            stream
                .play()
                .map_err(|e| format!("start loopback on {name}: {e}"))?;
            Ok((stream, format!("{name} (WASAPI loopback, {in_rate} Hz)")))
        })();
        match result {
            Ok((stream, source)) => {
                let _ = ready.send(Ok(source));
                // Capture runs on cpal's thread until the session stops.
                let _ = stop.recv();
                drop(stream);
            }
            Err(error) => {
                let _ = ready.send(Err(error));
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::io::Cursor;

    use pipewire::context::ContextRc;
    use pipewire::main_loop::MainLoopRc;
    use pipewire::properties::properties;
    use pipewire::spa::param::ParamType;
    use pipewire::spa::param::audio::{AudioFormat, AudioInfoRaw};
    use pipewire::spa::pod::serialize::PodSerializer;
    use pipewire::spa::pod::{Object, Pod, Value};
    use pipewire::spa::utils::{Direction, SpaTypes};
    use pipewire::stream::{StreamFlags, StreamRc};

    use super::capture::{Ready, Stop};
    use super::{WavePump, WaveSink};

    /// The graph converts the default sink's monitor to this rate/layout.
    const RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;

    /// PipeWire capture of the default sink's monitor ports
    /// (`stream.capture.sink`), i.e. "what this computer plays".
    pub(super) fn run(rate: u32, channels: u16, sink: WaveSink, stop: Stop, ready: Ready) {
        if let Err(error) = capture(rate, channels, sink, stop, &ready) {
            let _ = ready.send(Err(error));
        }
    }

    fn capture(
        rate: u32,
        channels: u16,
        sink: WaveSink,
        stop: Stop,
        ready: &Ready,
    ) -> Result<(), String> {
        pipewire::init();
        let main_loop = MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
        let context =
            ContextRc::new(&main_loop, None).map_err(|e| format!("PipeWire context: {e}"))?;
        let core = context
            .connect_rc(None)
            .map_err(|e| format!("cannot reach PipeWire (is it running in this session?): {e}"))?;
        let stream = StreamRc::new(
            core,
            "Taomni RDP audio",
            properties! {
                *pipewire::keys::MEDIA_TYPE => "Audio",
                *pipewire::keys::MEDIA_CATEGORY => "Capture",
                *pipewire::keys::MEDIA_ROLE => "Music",
                *pipewire::keys::STREAM_CAPTURE_SINK => "true",
                *pipewire::keys::NODE_NAME => "taomni-rdp-audio",
            },
        )
        .map_err(|e| format!("PipeWire stream: {e}"))?;
        let listener = stream
            .add_local_listener_with_user_data(WavePump::new(RATE, CHANNELS, rate, channels))
            .process(move |stream, pump| {
                let Some(mut buffer) = stream.dequeue_buffer() else {
                    return;
                };
                let Some(data) = buffer.datas_mut().first_mut() else {
                    return;
                };
                let (offset, size) = (data.chunk().offset() as usize, data.chunk().size() as usize);
                let Some(bytes) = data.data() else {
                    return;
                };
                let end = offset.saturating_add(size).min(bytes.len());
                let samples: Vec<f32> = bytes[offset.min(end)..end]
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();
                for packet in pump.push(&samples) {
                    sink.send(packet);
                }
            })
            .register()
            .map_err(|e| format!("PipeWire listener: {e}"))?;

        let mut info = AudioInfoRaw::new();
        info.set_format(AudioFormat::F32LE);
        info.set_rate(RATE);
        info.set_channels(u32::from(CHANNELS));
        let object = Object {
            type_: SpaTypes::ObjectParamFormat.as_raw(),
            id: ParamType::EnumFormat.as_raw(),
            properties: info.into(),
        };
        let bytes = PodSerializer::serialize(Cursor::new(Vec::new()), &Value::Object(object))
            .map_err(|e| format!("PipeWire audio format: {e}"))?
            .0
            .into_inner();
        let mut params = [Pod::from_bytes(&bytes).ok_or("PipeWire audio format pod")?];
        stream
            .connect(
                Direction::Input,
                None,
                StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
                &mut params,
            )
            .map_err(|e| format!("connect PipeWire capture: {e}"))?;

        // The session's stop signal arrives on a std channel; forward it into
        // the PipeWire loop, which only wakes for its own sources.
        let (quit_tx, quit_rx) = pipewire::channel::channel::<()>();
        let _quit = quit_rx.attach(main_loop.loop_(), {
            let main_loop = main_loop.clone();
            move |_| main_loop.quit()
        });
        std::thread::Builder::new()
            .name("rdp-audio-stop".to_string())
            .spawn(move || {
                let _ = stop.recv();
                let _ = quit_tx.send(());
            })
            .map_err(|e| format!("audio stop thread: {e}"))?;
        let _ = ready.send(Ok(format!("PipeWire default sink monitor ({RATE} Hz)")));
        main_loop.run();
        drop(listener);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
#[path = "sound_macos.rs"]
mod platform;

#[cfg(not(any(
    all(target_os = "windows", feature = "rdp-server-audio"),
    target_os = "linux",
    target_os = "macos"
)))]
mod platform {
    use super::WaveSink;
    use super::capture::{Ready, Stop};

    pub(super) fn run(_rate: u32, _channels: u16, _sink: WaveSink, _stop: Stop, ready: Ready) {
        let _ = ready.send(Err(
            "capturing this computer's audio output is not supported on this platform yet"
                .to_string(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::{WavePump, server_formats};

    fn samples(packet: &[u8]) -> Vec<i16> {
        packet
            .chunks_exact(2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
            .collect()
    }

    #[test]
    fn offers_pcm16_stereo_at_common_rates() {
        let formats = server_formats();
        assert_eq!(formats[0].n_samples_per_sec, 48_000);
        assert!(
            formats
                .iter()
                .all(|f| f.bits_per_sample == 16 && f.n_channels == 2)
        );
        assert!(formats.iter().all(|f| f.n_block_align == 4));
    }

    #[test]
    fn same_rate_passes_samples_through_in_20ms_packets() {
        let mut pump = WavePump::new(48_000, 2, 48_000, 2);
        // 21 ms of a ramp: one 20 ms packet (960 frames = 3840 bytes) is due.
        let input: Vec<f32> = (0..1008 * 2).map(|i| (i / 2) as f32 / 2048.0).collect();
        let packets = pump.push(&input);
        assert_eq!(packets.len(), 1);
        assert_eq!(packets[0].len(), 3840);
        let out = samples(&packets[0]);
        assert_eq!(out[0], 0);
        assert_eq!(out[2], (32767.0f32 / 2048.0).round() as i16);
        assert_eq!(out[0], out[1], "channels stay aligned");
    }

    #[test]
    fn mono_is_duplicated_and_full_scale_is_clamped() {
        let mut pump = WavePump::new(48_000, 1, 48_000, 2);
        let input = vec![2.0f32; 961];
        let out = samples(&pump.push(&input)[0]);
        assert!(out.iter().all(|s| *s == 32767));
    }

    #[test]
    fn resampling_keeps_duration() {
        let mut pump = WavePump::new(48_000, 2, 44_100, 2);
        let input: Vec<f32> = (0..48_000 * 2)
            .map(|i| ((i / 2) as f32 * 0.05).sin() * 0.5)
            .collect();
        let bytes: usize = pump.push(&input).iter().map(Vec::len).sum();
        let frames = bytes / 4;
        // One second in, ~one second out (minus the partial last packet).
        assert!((43_000..=44_100).contains(&frames), "{frames} frames");
    }
}
