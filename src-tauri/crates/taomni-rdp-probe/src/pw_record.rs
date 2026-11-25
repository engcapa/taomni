//! Linux host recording from a named PipeWire node. The RDP server's
//! microphone is a PipeWire `Audio/Source` node, which ALSA (cpal) clients
//! only reach as the default source; targeting it by name keeps the host's
//! default devices untouched.

use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipewire::context::ContextRc;
use pipewire::main_loop::MainLoopRc;
use pipewire::properties::properties;
use pipewire::spa::param::ParamType;
use pipewire::spa::param::audio::{AudioFormat, AudioInfoRaw};
use pipewire::spa::pod::serialize::PodSerializer;
use pipewire::spa::pod::{Object, Pod, Value};
use pipewire::spa::utils::{Direction, SpaTypes};
use pipewire::stream::{StreamFlags, StreamRc};

const RATE: u32 = 48_000;
const CHANNELS: u32 = 2;

/// Record `seconds` of mono `f32` from the node whose `node.name` is `target`.
pub(crate) fn record(seconds: f64, target: &str) -> Result<(Vec<f32>, u32, String), String> {
    pipewire::init();
    let main_loop = MainLoopRc::new(None).map_err(|e| format!("PipeWire main loop: {e}"))?;
    let context = ContextRc::new(&main_loop, None).map_err(|e| format!("PipeWire context: {e}"))?;
    let core = context
        .connect_rc(None)
        .map_err(|e| format!("cannot reach PipeWire: {e}"))?;
    let stream = StreamRc::new(
        core,
        "rdp-probe host-record",
        properties! {
            *pipewire::keys::MEDIA_TYPE => "Audio",
            *pipewire::keys::MEDIA_CATEGORY => "Capture",
            *pipewire::keys::MEDIA_ROLE => "Communication",
            *pipewire::keys::TARGET_OBJECT => target,
        },
    )
    .map_err(|e| format!("PipeWire stream: {e}"))?;
    let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
    let _listener = stream
        .add_local_listener_with_user_data(Arc::clone(&samples))
        .process(|stream, samples| {
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
            let frame = 4 * CHANNELS as usize;
            if let Ok(mut out) = samples.lock() {
                out.extend(bytes[offset.min(end)..end].chunks_exact(frame).map(|f| {
                    f.chunks_exact(4)
                        .map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]]))
                        .sum::<f32>()
                        / CHANNELS as f32
                }));
            }
        })
        .register()
        .map_err(|e| format!("PipeWire listener: {e}"))?;

    let mut info = AudioInfoRaw::new();
    info.set_format(AudioFormat::F32LE);
    info.set_rate(RATE);
    info.set_channels(CHANNELS);
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
        .map_err(|e| format!("connect to {target}: {e}"))?;

    let (quit_tx, quit_rx) = pipewire::channel::channel::<()>();
    let _quit = quit_rx.attach(main_loop.loop_(), {
        let main_loop = main_loop.clone();
        move |_| main_loop.quit()
    });
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs_f64(seconds));
        let _ = quit_tx.send(());
    });
    main_loop.run();
    let samples = std::mem::take(&mut *samples.lock().map_err(|_| "recording lock poisoned")?);
    Ok((samples, RATE, format!("PipeWire node {target}")))
}
