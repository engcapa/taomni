use super::capture_loop::drive_capture;
#[cfg(target_os = "macos")]
use super::display::CaptureResizeRequest;
use super::mailbox::LatestFrameMailbox;
use super::mailbox::PublishResult;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::capture::create_capturer_for_display;
use crate::servers::rdp::metrics::RdpMetrics;
use core::num::NonZeroU16;
use ironrdp::server::DesktopSize;
use std::sync::Arc;

/// Drive a warmed capture backend until the client disconnects or capture
/// fails, publishing updates to the display task.
///
/// Two regimes, chosen by the backend:
///
/// - **Event-driven** (X11 XDamage): the backend blocks until the screen
///   actually changes and returns only the changed regions (the first frame is
///   full, to seed the encoder framebuffer). No interval, no hashing — idle
///   costs nothing and a small change sends a small region.
/// - **Polling backend** (X11 without DAMAGE, macOS, or other platforms):
///   capture a full frame on a ~30 fps interval and suppress
///   byte-identical frames with a cheap FNV-1a hash so a static desktop still
///   costs near-zero downstream. The IronRDP encoder diffs the frames we DO
///   send and only encodes changed rectangles.
#[cfg(target_os = "macos")]
pub(super) fn start_warmed_macos_capture(
    log: LogEmitter,
    display_id: Option<String>,
    metrics: RdpMetrics,
) -> anyhow::Result<(
    DesktopSize,
    Arc<LatestFrameMailbox>,
    std::sync::mpsc::Sender<CaptureResizeRequest>,
    bool,
)> {
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (resize_tx, resize_rx) = std::sync::mpsc::channel();

    std::thread::Builder::new()
        .name("rdp-capture".to_string())
        .spawn({
            let worker_mailbox = mailbox.clone();
            move || {
                let result = (|| {
                    let mut capturer =
                        create_capturer_for_display(&log, display_id.as_deref(), false)?;
                    let supports_client_size = capturer.supports_output_resize();

                    // Both ScreenCaptureKit and its legacy fallback retain the
                    // initial frame acquired during construction. Publish it
                    // before declaring the server ready, so authentication can
                    // never race native stream startup or a static desktop.
                    let started = std::time::Instant::now();
                    let mut initial = capturer.capture()?;
                    let width = NonZeroU16::new(initial.width)
                        .ok_or_else(|| anyhow::anyhow!("screen capture reported zero width"))?;
                    let height = NonZeroU16::new(initial.height)
                        .ok_or_else(|| anyhow::anyhow!("screen capture reported zero height"))?;
                    metrics.record_capture(started.elapsed(), initial.byte_len());
                    initial.sequence = 1;
                    if matches!(worker_mailbox.publish_full(initial), PublishResult::Closed) {
                        anyhow::bail!("screen capture mailbox closed during warm-up");
                    }

                    Ok((
                        DesktopSize {
                            width: width.get(),
                            height: height.get(),
                        },
                        capturer,
                        supports_client_size,
                    ))
                })();

                let (size, capturer, supports_client_size) = match result {
                    Ok(ready) => ready,
                    Err(error) => {
                        worker_mailbox.close();
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok((size, supports_client_size))).is_err() {
                    worker_mailbox.close();
                    return;
                }

                log.line(format!(
                    "macOS capture pre-warmed for RDP login ({}x{}); first frame is ready",
                    size.width, size.height
                ));
                drive_capture(log, worker_mailbox, capturer, metrics, Some(resize_rx));
            }
        })
        .map_err(|error| anyhow::anyhow!("spawn macOS capture thread: {error}"))?;

    let (size, supports_client_size) = ready_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("macOS capture thread stopped during warm-up"))??;
    Ok((size, mailbox, resize_tx, supports_client_size))
}
