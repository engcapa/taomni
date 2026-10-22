#[cfg(target_os = "macos")]
use super::display::CaptureResizeRequest;
use super::mailbox::LatestFrameMailbox;
use super::mailbox::PublishResult;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::capture::Capturer;
#[cfg(target_os = "linux")]
use crate::servers::rdp::capture::PortalInput;
use crate::servers::rdp::metrics::RdpMetrics;
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::sync::mpsc::Receiver;
#[cfg(target_os = "macos")]
use std::time::Duration;

pub(super) fn drive_capture(
    log: LogEmitter,
    mailbox: Arc<LatestFrameMailbox>,
    mut capturer: Box<dyn Capturer>,
    metrics: RdpMetrics,
    #[cfg(target_os = "macos")] resize_rx: Option<std::sync::mpsc::Receiver<CaptureResizeRequest>>,
    #[cfg(target_os = "linux")] input_rx: Option<Receiver<PortalInput>>,
) {
    if capturer.is_event_driven() {
        capture_loop_event_driven(capturer.as_mut(), &mailbox, &metrics);
    } else {
        capture_loop_polling(
            capturer.as_mut(),
            &mailbox,
            &metrics,
            #[cfg(target_os = "macos")]
            resize_rx.as_ref(),
            #[cfg(target_os = "linux")]
            input_rx.as_ref(),
        );
    }
    // Every producer exit must wake consumers. This covers native stream
    // errors, malformed frames, and backend failures; otherwise a connected
    // RDP client could wait forever on a mailbox whose producer has died.
    mailbox.close();
    log.line("capture thread stopped");
}

/// Damage-driven loop: forward whatever regions the backend reports. The
/// backend internally blocks on change notifications and caps the frame rate,
/// so this loop adds no interval of its own. An empty result is an idle tick;
/// we use it to notice a disconnected client (closed channel) promptly.
pub(super) fn capture_loop_event_driven(
    capturer: &mut dyn Capturer,
    mailbox: &LatestFrameMailbox,
    metrics: &RdpMetrics,
) {
    let mut first = true;
    let mut sequence = 0;
    loop {
        match capturer.next_updates(first) {
            Ok(mut frames) => {
                first = false;
                if frames.is_empty() {
                    // Idle tick: nothing changed within the wait budget. Bail
                    // out if the client went away, otherwise keep waiting.
                    if matches!(mailbox.publish_damage(Vec::new()), PublishResult::Closed) {
                        break;
                    }
                    continue;
                }
                for frame in &mut frames {
                    // This backend sleeps until the screen changes and caps its
                    // own rate, so the time since the call started is mostly
                    // deliberate waiting. Report each region's age at handoff.
                    metrics.record_capture(frame.captured_at.elapsed(), frame.byte_len());
                    sequence += 1;
                    frame.sequence = sequence;
                }

                match mailbox.publish_damage(frames) {
                    PublishResult::Published { replaced } => {
                        if replaced {
                            metrics.record_frame_replaced();
                        }
                    }
                    PublishResult::NeedsFullRefresh => {
                        let full_started = std::time::Instant::now();
                        let mut full = match capturer.capture() {
                            Ok(frame) => frame,
                            Err(e) => {
                                tracing::warn!("RDP capture (damage full refresh): {}", e);
                                break;
                            }
                        };
                        metrics.record_capture(full_started.elapsed(), full.byte_len());
                        sequence += 1;
                        full.sequence = sequence;
                        match mailbox.publish_full(full) {
                            PublishResult::Published { replaced } => {
                                if replaced {
                                    metrics.record_frame_replaced();
                                }
                            }
                            PublishResult::Closed => return,
                            PublishResult::NeedsFullRefresh => {
                                unreachable!("full frames always publish")
                            }
                        }
                    }
                    PublishResult::Closed => return,
                }
                metrics.report_if_due();
            }
            Err(e) => {
                tracing::warn!("RDP capture (damage): {}", e);
                break;
            }
        }
    }
}

/// Fixed-interval full-frame loop with FNV-1a dedup (used when the backend is
/// not event-driven). ~30 fps ceiling; identical frames are suppressed so a
/// static desktop costs nothing downstream.
///
/// A backend that reports an idle tick ([`Capturer::poll_frame`] returning
/// `Ok(None)`) has simply seen no change. That is the steady state of an
/// untouched desktop and must never end this loop: the mailbox has no producer
/// once this thread exits, so `next_update` would block forever and freeze the
/// client on its last frame while the connection still looks healthy.
pub(super) fn capture_loop_polling(
    capturer: &mut dyn Capturer,
    mailbox: &LatestFrameMailbox,
    metrics: &RdpMetrics,
    #[cfg(target_os = "macos")] resize_rx: Option<&std::sync::mpsc::Receiver<CaptureResizeRequest>>,
    #[cfg(target_os = "linux")] input_rx: Option<&Receiver<PortalInput>>,
) {
    // A backend that caps its own frame rate must not be paced again: the extra
    // sleep would hold back a frame that is already sitting in its mailbox.
    let self_paced = capturer.is_self_paced();
    let needs_deduplication = capturer.needs_frame_deduplication();
    let frame_interval = (!self_paced).then(|| std::time::Duration::from_millis(33));
    let mut last_hash: Option<u64> = None;
    let mut first = true;
    let mut sequence = 0;
    #[cfg(target_os = "linux")]
    let mut input_failed = false;
    loop {
        #[cfg(target_os = "linux")]
        if let Some(input_rx) = input_rx {
            while let Ok(input) = input_rx.try_recv() {
                if !input_failed {
                    if let Err(error) = capturer.inject_portal_input(input) {
                        tracing::warn!(%error, "Wayland portal input injection stopped");
                        input_failed = true;
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        if let Some(resize_rx) = resize_rx {
            while let Ok(request) = resize_rx.try_recv() {
                let result = capturer
                    .resize_output(request.size.width, request.size.height)
                    .and_then(|mut frame| {
                        if frame.width != request.size.width || frame.height != request.size.height
                        {
                            anyhow::bail!(
                                "capture backend returned {}x{} after requesting {}x{}",
                                frame.width,
                                frame.height,
                                request.size.width,
                                request.size.height
                            );
                        }
                        metrics.record_capture(frame.captured_at.elapsed(), frame.byte_len());
                        sequence += 1;
                        frame.sequence = sequence;
                        match mailbox.publish_full(frame) {
                            PublishResult::Published { replaced } => {
                                if replaced {
                                    metrics.record_frame_replaced();
                                }
                                Ok(request.size)
                            }
                            PublishResult::Closed => {
                                anyhow::bail!("RDP display closed during capture resize")
                            }
                            PublishResult::NeedsFullRefresh => {
                                unreachable!("full frames always publish")
                            }
                        }
                    })
                    .map_err(|error| error.to_string());
                if result.is_ok() {
                    first = false;
                    last_hash = None;
                }
                let closed = result
                    .as_ref()
                    .is_err_and(|error| error == "RDP display closed during capture resize");
                let _ = request.result.send(result);
                if closed {
                    return;
                }
            }
        }
        let start = std::time::Instant::now();
        match capturer.poll_frame() {
            Ok(Some(mut frame)) => {
                // Charge only pixel production to "capture". A self-paced poll
                // blocks until the next frame exists, so its elapsed time is the
                // frame interval, not our cost — the frame's age at pickup is.
                // A grab-on-demand poll does the work inline, so there the call
                // duration is the cost and the frame's age is ~zero.
                let capture_cost = if self_paced {
                    frame.captured_at.elapsed()
                } else {
                    start.elapsed()
                };
                metrics.record_capture(capture_cost, frame.byte_len());
                // ScreenCaptureKit already reports an explicit idle tick when
                // nothing changed. Avoid scanning its entire Retina-sized BGRA
                // surface again; polling backends still need the hash to stop
                // unchanged frames before they reach IronRDP.
                let changed = if needs_deduplication {
                    let hash_started = std::time::Instant::now();
                    let hash = super::super::diff::frame_hash(&frame.data);
                    metrics.record_hash(hash_started.elapsed());
                    let changed = first || last_hash != Some(hash);
                    last_hash = Some(hash);
                    changed
                } else {
                    true
                };
                // Always send the first frame so the client gets an initial
                // image; thereafter suppress byte-identical frames only for
                // sources that cannot report idle explicitly.
                if changed {
                    first = false;
                    sequence += 1;
                    frame.sequence = sequence;
                    match mailbox.publish_full(frame) {
                        PublishResult::Published { replaced } => {
                            if replaced {
                                metrics.record_frame_replaced();
                            }
                        }
                        PublishResult::Closed => break,
                        PublishResult::NeedsFullRefresh => {
                            unreachable!("full frames always publish")
                        }
                    }
                } else {
                    metrics.record_duplicate_frame();
                }
                if let Some(rem) = frame_interval.and_then(|i| i.checked_sub(start.elapsed())) {
                    std::thread::sleep(rem);
                }
            }
            Ok(None) => {
                // Idle tick. The poll already blocked for the backend's idle
                // budget, so pace nothing here; just notice a client that left.
                if mailbox.is_closed() {
                    break;
                }
            }
            Err(e) => {
                tracing::warn!("RDP capture (polling): {}", e);
                break;
            }
        }
        metrics.report_if_due();
    }
}
