use super::capture_loop::drive_capture;
use super::mailbox::LatestFrameMailbox;
use super::mailbox::PublishResult;
use crate::servers::engine::LogEmitter;
#[cfg(target_os = "linux")]
use crate::servers::rdp::capture::PortalInput;
use crate::servers::rdp::capture::create_capturer_for_display;
use crate::servers::rdp::metrics::RdpMetrics;
use core::num::NonZeroU16;
use ironrdp::server::DesktopSize;
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::sync::mpsc::SyncSender;

/// Start one Linux capture owner before the RDP listener accepts clients.
/// Wayland portal permissions and the PipeWire stream are tied to the portal
/// session, so creating this backend per client would trigger repeated consent
/// dialogs and lose the first frame during authentication.
#[cfg(target_os = "linux")]
pub(super) fn start_warmed_linux_capture(
    log: LogEmitter,
    display_id: Option<String>,
    metrics: RdpMetrics,
    request_input: bool,
) -> anyhow::Result<(
    DesktopSize,
    Arc<LatestFrameMailbox>,
    Option<SyncSender<PortalInput>>,
)> {
    let mailbox = Arc::new(LatestFrameMailbox::new());
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let (portal_tx, portal_rx) = std::sync::mpsc::sync_channel(256);

    std::thread::Builder::new()
        .name("rdp-capture".to_string())
        .spawn({
            let worker_mailbox = mailbox.clone();
            move || {
                let result = (|| {
                    let mut capturer =
                        create_capturer_for_display(&log, display_id.as_deref(), request_input)?;
                    let supports_input = request_input && capturer.supports_portal_input();
                    let input_rx = supports_input.then_some(portal_rx);
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
                        input_rx,
                        supports_input,
                    ))
                })();

                let (size, capturer, input_rx, supports_input) = match result {
                    Ok(ready) => ready,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                if ready_tx.send(Ok((size, supports_input))).is_err() {
                    worker_mailbox.close();
                    return;
                }
                log.line(format!(
                    "Linux capture pre-warmed for RDP login ({}x{}; portal_input={})",
                    size.width,
                    size.height,
                    if supports_input {
                        "granted"
                    } else {
                        "native/disabled"
                    }
                ));
                drive_capture(log, worker_mailbox, capturer, metrics, input_rx);
            }
        })
        .map_err(|error| anyhow::anyhow!("spawn Linux capture thread: {error}"))?;

    let (size, supports_input) = ready_rx
        .recv()
        .map_err(|_| anyhow::anyhow!("Linux capture thread stopped during warm-up"))??;
    Ok((size, mailbox, supports_input.then_some(portal_tx)))
}
