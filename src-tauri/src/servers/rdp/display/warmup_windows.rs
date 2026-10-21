use super::capture_loop::drive_capture;
use super::mailbox::LatestFrameMailbox;
use super::mailbox::PublishResult;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::capture::create_capturer_for_display;
use crate::servers::rdp::metrics::RdpMetrics;
use core::num::NonZeroU16;
use ironrdp::server::DesktopSize;
use std::sync::Arc;

/// Start one Windows WGC capture owner before the RDP listener accepts clients.
/// Graphics Capture is tied to the interactive console and can be
/// expensive to initialize, so readiness includes a validated first frame.
#[cfg(target_os = "windows")]
pub(super) fn start_warmed_windows_capture(
    log: LogEmitter,
    display_id: Option<String>,
    metrics: RdpMetrics,
) -> anyhow::Result<(DesktopSize, Arc<LatestFrameMailbox>)> {
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);

    std::thread::Builder::new()
        .name("rdp-capture".to_string())
        .spawn({
            let worker_mailbox = mailbox.clone();
            move || {
                let result = (|| {
                    let mut capturer =
                        create_capturer_for_display(&log, display_id.as_deref(), false)?;
                    let started = std::time::Instant::now();
                    let mut initial = capturer.capture()?;
                    let width = NonZeroU16::new(initial.width)
                        .ok_or_else(|| anyhow::anyhow!("Windows capture reported zero width"))?;
                    let height = NonZeroU16::new(initial.height)
                        .ok_or_else(|| anyhow::anyhow!("Windows capture reported zero height"))?;
                    metrics.record_capture(started.elapsed(), initial.byte_len());
                    initial.sequence = 1;
                    if matches!(worker_mailbox.publish_full(initial), PublishResult::Closed) {
                        anyhow::bail!("Windows capture mailbox closed during warm-up");
                    }
                    Ok((
                        DesktopSize {
                            width: width.get(),
                            height: height.get(),
                        },
                        capturer,
                    ))
                })();

                let (size, capturer) = match result {
                    Ok(ready) => ready,
                    Err(error) => {
                        worker_mailbox.close();
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok(size)).is_err() {
                    worker_mailbox.close();
                    return;
                }
                log.line(format!(
                    "Windows capture pre-warmed for RDP login ({}x{}; WGC/GDI)",
                    size.width, size.height
                ));
                drive_capture(log, worker_mailbox, capturer, metrics);
            }
        })
        .map_err(|error| anyhow::anyhow!("spawn Windows capture thread: {error}"))?;

    let size = ready_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("Windows capture thread stopped during warm-up"))??;
    Ok((size, mailbox))
}
