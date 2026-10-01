//! AUDIO_INPUT (MS-RDPEAI) microphone redirection for the RDP server
//! (TASK-08, design §4.4).
//!
//! The client's microphone arrives as PCM over the AUDIO_INPUT dynamic
//! channel and is played into a host input local applications record from:
//! - Linux: a PipeWire `Audio/Source` node "Taomni RDP Microphone";
//! - Windows/macOS: the playback side of a virtual cable (VB-CABLE "CABLE
//!   Input", BlackHole, Background Music); applications record from its
//!   capture side.
//!
//! Without a usable host input the channel is not offered and the server log
//! says why. Protocol: Version ↔ Version, Sound Formats ↔ client subset,
//! Open → Format Change + Open Reply, then Incoming Data + Data packets.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ironrdp::core::{Encode, EncodeResult, WriteCursor, impl_as_any};
use ironrdp::dvc::{DrdynvcServer, DvcEncode, DvcMessage, DvcProcessor, DvcServerProcessor};
use ironrdp::pdu::PduResult;
use ironrdp::server::DvcServerFactory;

use super::sound::Resampler;
use crate::servers::engine::LogEmitter;

pub(crate) const CHANNEL_NAME: &str = "AUDIO_INPUT";

const MSG_VERSION: u8 = 0x01;
const MSG_FORMATS: u8 = 0x02;
const MSG_OPEN: u8 = 0x03;
const MSG_OPEN_REPLY: u8 = 0x04;
const MSG_DATA_INCOMING: u8 = 0x05;
const MSG_DATA: u8 = 0x06;
const MSG_FORMAT_CHANGE: u8 = 0x07;

const SERVER_VERSION: u32 = 2;
const WAVE_FORMAT_PCM: u16 = 1;
/// Client packets carry 20 ms, like Windows Remote Desktop.
const PACKET_MS: u32 = 20;
/// Host-side buffer; older audio is dropped so the latency stays bounded.
const RING_MS: u32 = 250;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PcmFormat {
    pub tag: u16,
    pub channels: u16,
    pub rate: u32,
    pub bits: u16,
}

impl PcmFormat {
    const fn pcm16(rate: u32, channels: u16) -> Self {
        Self {
            tag: WAVE_FORMAT_PCM,
            channels,
            rate,
            bits: 16,
        }
    }

    fn block_align(&self) -> u16 {
        self.channels * (self.bits / 8)
    }
}

/// Offered to the client, in preference order.
const SERVER_FORMATS: [PcmFormat; 4] = [
    PcmFormat::pcm16(48_000, 2),
    PcmFormat::pcm16(44_100, 2),
    PcmFormat::pcm16(22_050, 2),
    PcmFormat::pcm16(16_000, 1),
];

/// Already-serialized DVC payload.
struct RawDvc(Vec<u8>);

impl Encode for RawDvc {
    fn encode(&self, dst: &mut WriteCursor<'_>) -> EncodeResult<()> {
        dst.write_slice(&self.0);
        Ok(())
    }
    fn name(&self) -> &'static str {
        "AUDIO_INPUT server payload"
    }
    fn size(&self) -> usize {
        self.0.len()
    }
}

impl DvcEncode for RawDvc {}

fn message(bytes: Vec<u8>) -> DvcMessage {
    Box::new(RawDvc(bytes))
}

fn u32_at(src: &[u8], offset: usize) -> Option<u32> {
    let bytes = src.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn version_pdu(version: u32) -> Vec<u8> {
    let mut out = vec![MSG_VERSION];
    out.extend_from_slice(&version.to_le_bytes());
    out
}

/// WAVEFORMATEX without extra data.
fn encode_format(out: &mut Vec<u8>, format: &PcmFormat) {
    out.extend_from_slice(&format.tag.to_le_bytes());
    out.extend_from_slice(&format.channels.to_le_bytes());
    out.extend_from_slice(&format.rate.to_le_bytes());
    out.extend_from_slice(&(format.rate * u32::from(format.block_align())).to_le_bytes());
    out.extend_from_slice(&format.block_align().to_le_bytes());
    out.extend_from_slice(&format.bits.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
}

fn formats_pdu(formats: &[PcmFormat]) -> Vec<u8> {
    let mut body = Vec::new();
    for format in formats {
        encode_format(&mut body, format);
    }
    let mut out = vec![MSG_FORMATS];
    out.extend_from_slice(&(formats.len() as u32).to_le_bytes());
    // cbSizeFormatsPacket covers the whole PDU, header included.
    out.extend_from_slice(&((9 + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

fn open_pdu(frames_per_packet: u32, initial_format: u32, format: &PcmFormat) -> Vec<u8> {
    let mut out = vec![MSG_OPEN];
    out.extend_from_slice(&frames_per_packet.to_le_bytes());
    out.extend_from_slice(&initial_format.to_le_bytes());
    encode_format(&mut out, format);
    out
}

/// Parse the client's Sound Formats PDU body (after the message id).
fn parse_formats(body: &[u8]) -> Vec<PcmFormat> {
    let Some(count) = u32_at(body, 0) else {
        return Vec::new();
    };
    let mut formats = Vec::new();
    let mut offset = 8;
    for _ in 0..count.min(64) {
        let Some(src) = body.get(offset..offset + 18) else {
            break;
        };
        let u16_at = |o: usize| u16::from_le_bytes([src[o], src[o + 1]]);
        formats.push(PcmFormat {
            tag: u16_at(0),
            channels: u16_at(2),
            rate: u32::from_le_bytes([src[4], src[5], src[6], src[7]]),
            bits: u16_at(14),
        });
        offset += 18 + usize::from(u16_at(16));
    }
    formats
}

/// Index of the first client format this server plays, by server preference.
fn choose_format(client: &[PcmFormat]) -> Option<usize> {
    SERVER_FORMATS
        .iter()
        .find_map(|wanted| client.iter().position(|offered| offered == wanted))
}

/// Interleaved `f32` audio waiting for the host device, in the device format.
pub(crate) struct Ring {
    samples: Mutex<VecDeque<f32>>,
    capacity: usize,
}

impl Ring {
    fn new(rate: u32, channels: u16) -> Self {
        Self {
            samples: Mutex::new(VecDeque::new()),
            capacity: (rate * RING_MS / 1000) as usize * usize::from(channels.max(1)),
        }
    }

    fn push(&self, samples: &[f32]) {
        if let Ok(mut ring) = self.samples.lock() {
            ring.extend(samples);
            let excess = ring.len().saturating_sub(self.capacity);
            ring.drain(..excess);
        }
    }

    /// Fill `out` from the buffer; missing audio is silence.
    pub(crate) fn pull(&self, out: &mut [f32]) {
        let mut ring = self.samples.lock().ok();
        for sample in out.iter_mut() {
            *sample = ring.as_mut().and_then(|r| r.pop_front()).unwrap_or(0.0);
        }
    }
}

/// Host side of one open microphone: converts client PCM to the device format
/// and feeds the playback thread. Dropping it stops the device.
struct MicSink {
    ring: Arc<Ring>,
    resampler: Resampler,
    client: PcmFormat,
    stop: Option<std::sync::mpsc::SyncSender<()>>,
}

impl MicSink {
    fn start(client: PcmFormat, device: Option<&str>) -> Result<(Self, String), String> {
        let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let device = device.map(str::to_string);
        std::thread::Builder::new()
            .name("rdp-microphone".to_string())
            .spawn(move || platform::run(device.as_deref(), stop_rx, ready_tx))
            .map_err(|e| format!("could not start the microphone thread: {e}"))?;
        let (ring, rate, channels, target) = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "the host microphone did not start within 10 seconds".to_string())??;
        Ok((
            Self {
                ring,
                resampler: Resampler::new(client.rate, client.channels, rate, channels),
                client,
                stop: Some(stop_tx),
            },
            target,
        ))
    }

    fn push(&mut self, pcm: &[u8]) {
        if self.client.bits != 16 {
            return;
        }
        let samples: Vec<f32> = pcm
            .chunks_exact(2)
            .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
            .collect();
        let mut converted = Vec::with_capacity(samples.len() * 2);
        self.resampler
            .process(&samples, |value| converted.push(value));
        self.ring.push(&converted);
    }
}

impl Drop for MicSink {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.try_send(());
        }
    }
}

/// What the playback thread reports once the host device runs.
type Started = Result<(Arc<Ring>, u32, u16, String), String>;
type ReadySender = std::sync::mpsc::SyncSender<Started>;
type StopReceiver = std::sync::mpsc::Receiver<()>;

struct MicChannel {
    log: LogEmitter,
    device: Option<String>,
    client_formats: Vec<PcmFormat>,
    sink: Option<MicSink>,
    received_bytes: u64,
}

impl MicChannel {
    fn on_formats(&mut self, body: &[u8]) -> Vec<DvcMessage> {
        self.client_formats = parse_formats(body);
        let Some(index) = choose_format(&self.client_formats) else {
            self.log.line(format!(
                "RDP microphone: the client offered no usable PCM format ({} offered)",
                self.client_formats.len()
            ));
            return Vec::new();
        };
        let format = self.client_formats[index];
        vec![message(open_pdu(
            format.rate * PACKET_MS / 1000,
            index as u32,
            &format,
        ))]
    }

    fn on_format_change(&mut self, index: u32) {
        let Some(format) = self.client_formats.get(index as usize).copied() else {
            return;
        };
        if self.sink.as_ref().is_some_and(|sink| sink.client == format) {
            return;
        }
        self.sink = None;
        match MicSink::start(format, self.device.as_deref()) {
            Ok((sink, target)) => {
                self.log.line(format!(
                    "RDP microphone: client PCM {} Hz, {} channel(s) -> {target}",
                    format.rate, format.channels
                ));
                self.sink = Some(sink);
            }
            Err(error) => self
                .log
                .line(format!("RDP microphone unavailable on this computer: {error}")),
        }
    }
}

impl_as_any!(MicChannel);

impl DvcProcessor for MicChannel {
    fn channel_name(&self) -> &str {
        CHANNEL_NAME
    }

    fn start(&mut self, _channel_id: u32) -> PduResult<Vec<DvcMessage>> {
        Ok(vec![message(version_pdu(SERVER_VERSION))])
    }

    fn process(&mut self, _channel_id: u32, payload: &[u8]) -> PduResult<Vec<DvcMessage>> {
        let Some((&id, body)) = payload.split_first() else {
            return Ok(Vec::new());
        };
        let reply = match id {
            MSG_VERSION => vec![message(formats_pdu(&SERVER_FORMATS))],
            MSG_FORMATS => self.on_formats(body),
            MSG_FORMAT_CHANGE => {
                if let Some(index) = u32_at(body, 0) {
                    self.on_format_change(index);
                }
                Vec::new()
            }
            MSG_OPEN_REPLY => {
                if let Some(result) = u32_at(body, 0).filter(|r| *r != 0) {
                    self.log.line(format!(
                        "RDP microphone: the client could not open its microphone (0x{result:08x})"
                    ));
                }
                Vec::new()
            }
            MSG_DATA => {
                self.received_bytes += body.len() as u64;
                if let Some(sink) = self.sink.as_mut() {
                    sink.push(body);
                }
                Vec::new()
            }
            MSG_DATA_INCOMING => Vec::new(),
            _ => Vec::new(),
        };
        Ok(reply)
    }

    fn close(&mut self, _channel_id: u32) {
        if self.sink.take().is_some() {
            self.log.line(format!(
                "RDP microphone stopped ({} KiB received)",
                self.received_bytes / 1024
            ));
        }
    }
}

impl DvcServerProcessor for MicChannel {}

/// Adds the AUDIO_INPUT channel to every connection.
pub(crate) struct MicFactory {
    log: LogEmitter,
    device: Option<String>,
}

impl MicFactory {
    /// `None` (with the reason logged) when this computer has no host input
    /// the client microphone could play into.
    pub(crate) fn new(log: LogEmitter, device: Option<String>) -> Option<Self> {
        match platform::probe(device.as_deref()) {
            Ok(target) => {
                log.line(format!(
                    "RDP microphone: client microphones will play into {target}"
                ));
                Some(Self { log, device })
            }
            Err(reason) => {
                log.line(format!("RDP microphone unavailable: {reason}"));
                None
            }
        }
    }
}

impl DvcServerFactory for MicFactory {
    fn attach(&self, drdynvc: DrdynvcServer) -> DrdynvcServer {
        drdynvc.with_dynamic_channel(MicChannel {
            log: self.log.clone(),
            device: self.device.clone(),
            client_formats: Vec::new(),
            sink: None,
            received_bytes: 0,
        })
    }
}

/// Virtual cable playback endpoints, tried in order when no device is set.
#[cfg(any(
    all(any(target_os = "windows", target_os = "macos"), feature = "rdp-server-audio"),
    test
))]
const AUTO_DEVICES: [&str; 3] = ["CABLE Input", "BlackHole", "Background Music"];

#[cfg(all(any(target_os = "windows", target_os = "macos"), feature = "rdp-server-audio"))]
mod platform {
    use std::sync::Arc;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    use super::{AUTO_DEVICES, ReadySender, Ring, StopReceiver};

    fn name(device: &cpal::Device) -> String {
        device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_default()
    }

    fn find(wanted: Option<&str>) -> Result<cpal::Device, String> {
        let wanted = wanted.map(str::trim).filter(|w| !w.is_empty());
        let devices: Vec<cpal::Device> = cpal::default_host()
            .output_devices()
            .map_err(|e| e.to_string())?
            .collect();
        let names: Vec<String> = devices.iter().map(name).collect();
        let needles: Vec<String> = match wanted {
            Some(wanted) => vec![wanted.to_lowercase()],
            None => AUTO_DEVICES.iter().map(|d| d.to_lowercase()).collect(),
        };
        let index = needles
            .iter()
            .find_map(|needle| names.iter().position(|n| n.to_lowercase().contains(needle)));
        match index {
            Some(index) => Ok(devices.into_iter().nth(index).expect("index into names")),
            None => Err(match wanted {
                Some(wanted) => format!("no audio output named like {wanted:?} (outputs: {names:?})"),
                None => format!(
                    "no virtual audio cable (VB-CABLE on Windows, BlackHole on macOS) is installed (outputs: {names:?})"
                ),
            }),
        }
    }

    pub(super) fn probe(device: Option<&str>) -> Result<String, String> {
        find(device).map(|d| name(&d))
    }

    pub(super) fn run(device: Option<&str>, stop: StopReceiver, ready: ReadySender) {
        let result = (|| -> Result<(cpal::Stream, Arc<Ring>, u32, u16, String), String> {
            let device = find(device)?;
            let target = name(&device);
            let config = device
                .default_output_config()
                .map_err(|e| format!("output format of {target}: {e}"))?;
            let (rate, channels) = (config.sample_rate(), config.channels());
            let ring = Arc::new(Ring::new(rate, channels));
            let stream_config: cpal::StreamConfig = config.config();
            let on_error = |error: cpal::StreamError| {
                tracing::warn!(%error, "RDP microphone stream error");
            };
            let stream = match config.sample_format() {
                cpal::SampleFormat::F32 => {
                    let ring = Arc::clone(&ring);
                    device.build_output_stream(
                        &stream_config,
                        move |data: &mut [f32], _| ring.pull(data),
                        on_error,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let ring = Arc::clone(&ring);
                    let mut scratch = Vec::new();
                    device.build_output_stream(
                        &stream_config,
                        move |data: &mut [i16], _| {
                            scratch.resize(data.len(), 0.0f32);
                            ring.pull(&mut scratch);
                            for (out, value) in data.iter_mut().zip(&scratch) {
                                *out = (value.clamp(-1.0, 1.0) * 32767.0) as i16;
                            }
                        },
                        on_error,
                        None,
                    )
                }
                other => return Err(format!("unsupported output sample format {other:?}")),
            }
            .map_err(|e| format!("open {target}: {e}"))?;
            stream
                .play()
                .map_err(|e| format!("start {target}: {e}"))?;
            Ok((stream, ring, rate, channels, format!("{target} ({rate} Hz)")))
        })();
        match result {
            Ok((stream, ring, rate, channels, target)) => {
                let _ = ready.send(Ok((ring, rate, channels, target)));
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
    use std::sync::Arc;

    use pipewire::context::ContextRc;
    use pipewire::main_loop::MainLoopRc;
    use pipewire::properties::properties;
    use pipewire::spa::param::ParamType;
    use pipewire::spa::param::audio::{AudioFormat, AudioInfoRaw, MAX_CHANNELS};
    use pipewire::spa::pod::serialize::PodSerializer;
    use pipewire::spa::pod::{Object, Pod, Value};
    use pipewire::spa::utils::{Direction, SpaTypes};
    use pipewire::stream::{StreamFlags, StreamRc};

    use super::{ReadySender, Ring, StopReceiver};

    const RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;
    pub(crate) const NODE_NAME: &str = "taomni-rdp-microphone";
    const DESCRIPTION: &str = "Taomni RDP Microphone";

    fn connect() -> Result<(MainLoopRc, pipewire::core::CoreRc), String> {
        pipewire::init();
        let main_loop = MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
        let context =
            ContextRc::new(&main_loop, None).map_err(|e| format!("PipeWire context: {e}"))?;
        let core = context
            .connect_rc(None)
            .map_err(|e| format!("cannot reach PipeWire (is it running in this session?): {e}"))?;
        Ok((main_loop, core))
    }

    pub(super) fn probe(_device: Option<&str>) -> Result<String, String> {
        connect()?;
        Ok(format!("the PipeWire source \"{DESCRIPTION}\" ({NODE_NAME})"))
    }

    pub(super) fn run(_device: Option<&str>, stop: StopReceiver, ready: ReadySender) {
        if let Err(error) = source(stop, &ready) {
            let _ = ready.send(Err(error));
        }
    }

    /// A stream node with `media.class = Audio/Source` is itself a source
    /// recording applications can pick; it is not linked anywhere until one
    /// does.
    fn source(stop: StopReceiver, ready: &ReadySender) -> Result<(), String> {
        let (main_loop, core) = connect()?;
        let ring = Arc::new(Ring::new(RATE, CHANNELS));
        let stream = StreamRc::new(
            core,
            DESCRIPTION,
            properties! {
                *pipewire::keys::MEDIA_TYPE => "Audio",
                *pipewire::keys::MEDIA_CLASS => "Audio/Source",
                *pipewire::keys::NODE_NAME => NODE_NAME,
                *pipewire::keys::NODE_DESCRIPTION => DESCRIPTION,
            },
        )
        .map_err(|e| format!("PipeWire stream: {e}"))?;
        let listener = stream
            .add_local_listener_with_user_data(Arc::clone(&ring))
            .process(|stream, ring| {
                let Some(mut buffer) = stream.dequeue_buffer() else {
                    return;
                };
                let requested = buffer.requested() as usize;
                let Some(data) = buffer.datas_mut().first_mut() else {
                    return;
                };
                let stride = 4 * usize::from(CHANNELS);
                let frames = match data.data() {
                    Some(bytes) => {
                        let mut frames = bytes.len() / stride;
                        if requested > 0 {
                            frames = frames.min(requested);
                        }
                        let mut samples = vec![0.0f32; frames * usize::from(CHANNELS)];
                        ring.pull(&mut samples);
                        for (out, value) in bytes.chunks_exact_mut(4).zip(&samples) {
                            out.copy_from_slice(&value.to_le_bytes());
                        }
                        frames
                    }
                    None => 0,
                };
                let chunk = data.chunk_mut();
                *chunk.offset_mut() = 0;
                *chunk.stride_mut() = stride as i32;
                *chunk.size_mut() = (frames * stride) as u32;
            })
            .register()
            .map_err(|e| format!("PipeWire listener: {e}"))?;

        let mut info = AudioInfoRaw::new();
        info.set_format(AudioFormat::F32LE);
        info.set_rate(RATE);
        info.set_channels(u32::from(CHANNELS));
        let mut position = [0u32; MAX_CHANNELS];
        position[0] = pipewire::spa::sys::SPA_AUDIO_CHANNEL_FL;
        position[1] = pipewire::spa::sys::SPA_AUDIO_CHANNEL_FR;
        info.set_position(position);
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
                Direction::Output,
                None,
                StreamFlags::MAP_BUFFERS | StreamFlags::RT_PROCESS,
                &mut params,
            )
            .map_err(|e| format!("create the PipeWire microphone source: {e}"))?;

        let (quit_tx, quit_rx) = pipewire::channel::channel::<()>();
        let _quit = quit_rx.attach(main_loop.loop_(), {
            let main_loop = main_loop.clone();
            move |_| main_loop.quit()
        });
        std::thread::Builder::new()
            .name("rdp-microphone-stop".to_string())
            .spawn(move || {
                let _ = stop.recv();
                let _ = quit_tx.send(());
            })
            .map_err(|e| format!("microphone stop thread: {e}"))?;
        let _ = ready.send(Ok((
            ring,
            RATE,
            CHANNELS,
            format!("PipeWire source \"{DESCRIPTION}\" ({NODE_NAME})"),
        )));
        main_loop.run();
        drop(listener);
        Ok(())
    }
}

#[cfg(not(any(
    all(any(target_os = "windows", target_os = "macos"), feature = "rdp-server-audio"),
    target_os = "linux"
)))]
mod platform {
    use super::{ReadySender, StopReceiver};

    const UNSUPPORTED: &str = "microphone redirection is not available in this build";

    pub(super) fn probe(_device: Option<&str>) -> Result<String, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub(super) fn run(_device: Option<&str>, _stop: StopReceiver, ready: ReadySender) {
        let _ = ready.send(Err(UNSUPPORTED.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_pdu_round_trips_through_the_client_parser() {
        let pdu = formats_pdu(&SERVER_FORMATS);
        assert_eq!(pdu[0], MSG_FORMATS);
        assert_eq!(u32_at(&pdu, 5), Some(pdu.len() as u32));
        assert_eq!(parse_formats(&pdu[1..]), SERVER_FORMATS.to_vec());
    }

    #[test]
    fn chooses_by_server_preference_and_indexes_the_client_list() {
        let client = [PcmFormat::pcm16(16_000, 1), PcmFormat::pcm16(44_100, 2)];
        assert_eq!(choose_format(&client), Some(1));
        let unusable = [PcmFormat {
            tag: 0x55,
            channels: 2,
            rate: 44_100,
            bits: 0,
        }];
        assert_eq!(choose_format(&unusable), None);
    }

    #[test]
    fn open_pdu_carries_packet_size_index_and_waveformat() {
        let format = PcmFormat::pcm16(44_100, 2);
        let pdu = open_pdu(882, 1, &format);
        assert_eq!(pdu[0], MSG_OPEN);
        assert_eq!(u32_at(&pdu, 1), Some(882));
        assert_eq!(u32_at(&pdu, 5), Some(1));
        assert_eq!(parse_formats(&[&1u32.to_le_bytes()[..], &[0; 4], &pdu[9..]].concat()), vec![format]);
    }

    #[test]
    fn ring_keeps_the_newest_audio_and_pads_with_silence() {
        let ring = Ring::new(1000, 1); // 250 samples of capacity
        ring.push(&vec![0.5; 300]);
        let mut out = vec![1.0; 260];
        ring.pull(&mut out);
        assert!(out[..250].iter().all(|s| *s == 0.5));
        assert!(out[250..].iter().all(|s| *s == 0.0));
    }

    #[test]
    fn auto_detection_covers_the_documented_virtual_cables() {
        assert!(AUTO_DEVICES.contains(&"CABLE Input"));
        assert!(AUTO_DEVICES.contains(&"BlackHole"));
    }
}
