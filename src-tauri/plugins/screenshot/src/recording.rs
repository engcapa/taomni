use std::{
    fs::File,
    io::{self, Read, Seek, Write},
    net::TcpStream,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, ensure};
use image::RgbaImage;
use taomni_plugin_api::{ErrorCode, RpcError};
use taomni_screenshot_api::{
    FrameHeader, MAX_CLIP_BYTES, MAX_IMAGE_BYTES, RecordFormat, RecordStart, TimedFrame,
};
use taomni_screenshot_recording::encode_file;

#[derive(Default)]
pub(super) struct Recorder(Arc<AtomicBool>);

impl Recorder {
    pub(super) fn start(
        &self,
        runtime: &tokio::runtime::Runtime,
        request: RecordStart,
    ) -> Result<(), RpcError> {
        let format = RecordFormat::parse(&request.format)
            .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
        let length = u64::from(request.width) * u64::from(request.height);
        if request.width == 0
            || request.height == 0
            || request.width > format.max_width()
            || request.height > u32::from(u16::MAX)
            || length > MAX_IMAGE_BYTES / 4
            || !request.width.is_multiple_of(2)
            || !request.height.is_multiple_of(2)
            || !(1..=30).contains(&request.fps)
        {
            return Err(RpcError::from_code(ErrorCode::InvalidParams));
        }
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| super::failed("A recording is already active".into()))?;
        let lease = Lease(self.0.clone());
        let (stream, _) = runtime
            .block_on(request.source.connect())
            .map_err(super::failed)?;
        let socket = stream.into_std().map_err(failed)?;
        socket.set_nonblocking(false).map_err(failed)?;
        socket
            .set_read_timeout(Some(format.max_duration() + Duration::from_secs(30)))
            .map_err(failed)?;
        socket
            .set_write_timeout(Some(Duration::from_secs(30)))
            .map_err(failed)?;
        let output = tempfile::tempfile().map_err(failed)?;
        thread::Builder::new()
            .name("screenshot-module-encoder".into())
            .spawn(move || {
                if let Err(error) = run(
                    socket,
                    output,
                    request,
                    format,
                    (length * 4) as usize,
                    lease,
                ) {
                    eprintln!("Screenshot module recording: {error:#}");
                }
            })
            .map_err(failed)?;
        Ok(())
    }
}

struct Lease(Arc<AtomicBool>);

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn run(
    mut socket: TcpStream,
    mut output: File,
    request: RecordStart,
    format: RecordFormat,
    length: usize,
    lease: Lease,
) -> anyhow::Result<()> {
    let elapsed_limit = format.max_duration() + Duration::from_secs(30);
    let deadline = Instant::now() + elapsed_limit;
    let mut previous = 0;
    let input = std::iter::from_fn(|| {
        Some((|| {
            ensure!(
                Instant::now() < deadline,
                "Recording exceeded its time limit"
            );
            let mut bytes = [0; FrameHeader::LENGTH];
            socket
                .read_exact(&mut bytes)
                .context("Receive recording frame header")?;
            let header = FrameHeader::parse(bytes)?;
            ensure!(
                header.at_ms >= previous && u128::from(header.at_ms) <= elapsed_limit.as_millis(),
                "Invalid recording timestamp"
            );
            previous = header.at_ms;
            let image = if header.end {
                RgbaImage::new(0, 0)
            } else {
                let mut pixels = vec![0; length];
                socket
                    .read_exact(&mut pixels)
                    .context("Receive recording pixels")?;
                RgbaImage::from_raw(request.width, request.height, pixels)
                    .context("Invalid recording pixels")?
            };
            Ok(TimedFrame {
                image,
                at_ms: header.at_ms,
            })
        })())
    });
    let clip = encode_file(input, format, request.fps, output.try_clone()?)?;
    let size = output.metadata()?.len();
    ensure!(
        (1..=MAX_CLIP_BYTES).contains(&size),
        "Invalid recording clip size"
    );
    drop(lease);
    output.rewind()?;
    let meta = serde_json::to_vec(&clip)?;
    socket.write_all(&u16::try_from(meta.len())?.to_be_bytes())?;
    socket.write_all(&meta)?;
    socket.write_all(&size.to_be_bytes())?;
    io::copy(&mut output, &mut socket)?;
    Ok(())
}

fn failed(error: io::Error) -> RpcError {
    super::failed(format!("Start recording: {error}"))
}
