use super::limits::MAX_DIMENSION;
use super::mailbox::FrameMailbox;
use super::mailbox::RawFrame;
use crate::servers::engine::LogEmitter;
use anyhow::Context as _;
use anyhow::bail;
use pipewire::channel;
use pipewire::context::ContextRc;
use pipewire::keys::MEDIA_CATEGORY;
use pipewire::keys::MEDIA_ROLE;
use pipewire::keys::MEDIA_TYPE;
use pipewire::main_loop::MainLoopRc;
use pipewire::properties;
use pipewire::spa::param::ParamType;
use pipewire::spa::param::format::FormatProperties;
use pipewire::spa::param::format::MediaSubtype;
use pipewire::spa::param::format::MediaType;
use pipewire::spa::param::format_utils;
use pipewire::spa::param::video::VideoFormat;
use pipewire::spa::param::video::VideoInfoRaw;
use pipewire::spa::pod;
use pipewire::spa::pod::Pod;
use pipewire::spa::pod::serialize::PodSerializer;
use pipewire::spa::utils::Direction;
use pipewire::spa::utils::Fraction;
use pipewire::spa::utils::Rectangle;
use pipewire::spa::utils::SpaTypes;
use pipewire::stream::StreamFlags;
use pipewire::stream::StreamRc;
use std::io::Cursor;
use std::os::fd::OwnedFd;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

#[derive(Default)]
pub(super) struct ListenerData {
    pub(super) format: VideoInfoRaw,
}

pub(super) fn spawn_pipewire_capture(
    remote_fd: OwnedFd,
    stream_node: u32,
    mailbox: Arc<FrameMailbox>,
    log: LogEmitter,
) -> anyhow::Result<channel::Sender<()>> {
    let (stop_tx, stop_rx) = channel::channel();
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("rdp-pipewire".to_string())
        .spawn(move || {
            let worker_mailbox = mailbox.clone();
            let result = run_pipewire(remote_fd, stream_node, worker_mailbox, stop_rx, ready_tx);
            mailbox.close();
            if let Err(error) = result {
                log.line(format!("Wayland PipeWire capture stopped: {error}"));
                tracing::warn!(%error, "Wayland PipeWire capture stopped");
            }
        })
        .context("start PipeWire capture thread")?;
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| anyhow::anyhow!("PipeWire capture initialization timed out"))??;
    Ok(stop_tx)
}

pub(super) fn run_pipewire(
    remote_fd: OwnedFd,
    stream_node: u32,
    mailbox: Arc<FrameMailbox>,
    stop_rx: channel::Receiver<()>,
    ready_tx: std::sync::mpsc::SyncSender<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    pipewire::init();
    let main_loop = MainLoopRc::new(None).context("create PipeWire main loop")?;
    let context = ContextRc::new(&main_loop, None).context("create PipeWire context")?;
    let core = context
        .connect_fd_rc(remote_fd, None)
        .context("connect to portal PipeWire remote")?;
    let stream = StreamRc::new(
        core,
        "Taomni RDP Wayland capture",
        properties::properties! {
            *MEDIA_TYPE => "Video",
            *MEDIA_CATEGORY => "Capture",
            *MEDIA_ROLE => "Screen",
        },
    )
    .context("create PipeWire stream")?;

    let listener = stream
        .add_local_listener_with_user_data(ListenerData::default())
        .param_changed(|_, state, id, param| {
            let Some(param) = param else { return };
            if id != ParamType::Format.as_raw() {
                return;
            }
            if let Ok((MediaType::Video, MediaSubtype::Raw)) = format_utils::parse_format(param) {
                if let Err(error) = state.format.parse(param) {
                    tracing::warn!(?error, "could not parse Wayland PipeWire video format");
                } else {
                    log::info!(
                        "Wayland PipeWire format: {:?}, {}x{}, rate={}/{}, max={}/{}",
                        state.format.format(),
                        state.format.size().width,
                        state.format.size().height,
                        state.format.framerate().num,
                        state.format.framerate().denom,
                        state.format.max_framerate().num,
                        state.format.max_framerate().denom,
                    );
                }
            }
        })
        .process(move |stream, state| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            // The callback can run after several producer frames were queued.
            // Drain to the newest buffer before copying pixels; a latest-frame
            // mailbox downstream cannot remove latency already in PipeWire.
            while let Some(newer) = stream.dequeue_buffer() {
                buffer = newer;
            }
            let Some(data) = buffer.datas_mut().first_mut() else {
                return;
            };
            let chunk = data.chunk();
            if chunk
                .flags()
                .contains(pipewire::spa::buffer::ChunkFlags::CORRUPTED)
            {
                return;
            }
            let offset = chunk.offset() as usize;
            let size = chunk.size() as usize;
            let stride = chunk.stride();
            let Some(mapped) = data.data() else {
                tracing::warn!("Wayland PipeWire offered an unmapped DMA buffer");
                return;
            };
            let dimensions = state.format.size();
            match copy_pipewire_bgra(
                mapped,
                offset,
                size,
                stride,
                dimensions.width,
                dimensions.height,
                state.format.format(),
            ) {
                Ok(frame) => mailbox.publish(frame),
                Err(error) => tracing::warn!(%error, "discarding invalid PipeWire frame"),
            }
        })
        .register()
        .context("register PipeWire listener")?;

    let format = pod::object!(
        SpaTypes::ObjectParamFormat,
        ParamType::EnumFormat,
        pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
        pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
        pod::property!(
            FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            VideoFormat::BGRx,
            VideoFormat::BGRA,
            VideoFormat::RGBx,
            VideoFormat::RGBA,
            VideoFormat::BGR,
            VideoFormat::RGB
        ),
        pod::property!(
            FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            Rectangle {
                width: 1920,
                height: 1080
            },
            Rectangle {
                width: 1,
                height: 1
            },
            Rectangle {
                width: MAX_DIMENSION,
                height: MAX_DIMENSION
            }
        ),
        pod::property!(
            FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            Fraction { num: 60, denom: 1 },
            Fraction { num: 0, denom: 1 },
            Fraction { num: 60, denom: 1 }
        )
    );
    let bytes = PodSerializer::serialize(Cursor::new(Vec::new()), &pod::Value::Object(format))
        .map_err(|error| anyhow::anyhow!("serialize PipeWire format: {error}"))?
        .0
        .into_inner();
    let mut params =
        [Pod::from_bytes(&bytes).ok_or_else(|| anyhow::anyhow!("build PipeWire format pod"))?];
    stream
        .connect(
            Direction::Input,
            Some(stream_node),
            StreamFlags::AUTOCONNECT | StreamFlags::MAP_BUFFERS,
            &mut params,
        )
        .context("connect PipeWire stream")?;

    let stop_listener = stop_rx.attach(main_loop.loop_(), {
        let main_loop = main_loop.clone();
        move |_| main_loop.quit()
    });
    let _ = ready_tx.send(Ok(()));
    main_loop.run();
    drop(stop_listener);
    drop(listener);
    Ok(())
}

pub(super) fn copy_pipewire_bgra(
    mapped: &[u8],
    offset: usize,
    chunk_size: usize,
    stride: i32,
    width: u32,
    height: u32,
    format: VideoFormat,
) -> anyhow::Result<RawFrame> {
    let captured_at = Instant::now();
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        bail!("invalid PipeWire dimensions {width}x{height}");
    }
    let bytes_per_pixel = if format == VideoFormat::RGB || format == VideoFormat::BGR {
        3usize
    } else if matches!(
        format,
        VideoFormat::BGRx | VideoFormat::BGRA | VideoFormat::RGBx | VideoFormat::RGBA
    ) {
        4usize
    } else {
        bail!("unsupported PipeWire pixel format {format:?}");
    };
    let row_bytes = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(bytes_per_pixel))
        .context("PipeWire row size overflow")?;
    let source_stride = if stride == 0 {
        row_bytes
    } else {
        usize::try_from(stride.unsigned_abs()).context("PipeWire stride overflow")?
    };
    if source_stride < row_bytes {
        bail!("PipeWire stride {source_stride} is smaller than row size {row_bytes}");
    }
    let required = source_stride
        .checked_mul(usize::try_from(height).unwrap())
        .context("PipeWire frame size overflow")?;
    let available = chunk_size.min(mapped.len().saturating_sub(offset));
    if offset > mapped.len() || available < required {
        bail!("PipeWire buffer has {available} bytes; expected {required}");
    }
    let source = &mapped[offset..offset + required];
    let pixel_count = usize::try_from(width)
        .unwrap()
        .checked_mul(usize::try_from(height).unwrap())
        .context("PipeWire pixel count overflow")?;
    let mut bgra = Vec::with_capacity(pixel_count * 4);
    for output_row in 0..usize::try_from(height).unwrap() {
        let source_row = if stride < 0 {
            usize::try_from(height).unwrap() - 1 - output_row
        } else {
            output_row
        };
        let row = &source[source_row * source_stride..source_row * source_stride + row_bytes];
        if bytes_per_pixel == 4 {
            let start = bgra.len();
            bgra.extend_from_slice(row);
            let swap = matches!(format, VideoFormat::RGBx | VideoFormat::RGBA);
            for pixel in bgra[start..].chunks_exact_mut(4) {
                if swap {
                    pixel.swap(0, 2);
                }
                pixel[3] = 0xff;
            }
        } else {
            for pixel in row.chunks_exact(3) {
                if format == VideoFormat::BGR {
                    bgra.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 0xff]);
                } else {
                    bgra.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 0xff]);
                }
            }
        }
    }
    Ok(RawFrame {
        width,
        height,
        bgra,
        captured_at,
    })
}
