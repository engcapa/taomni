use std::time::Duration;
use std::time::Instant;

/// Two outstanding ACKs leave room for one currently-rendering frame without
/// permitting an interactive client to accumulate visibly stale desktop state.
pub(super) const MAX_FRAMES_IN_FLIGHT: u32 = 2;
/// Bound VideoToolbox independently of the later EGFX acknowledgement window.
/// One frame may be encoding while one newer frame waits behind it.
pub(super) const MAX_ENCODER_FRAMES_IN_FLIGHT: usize = 2;
pub(crate) const ENCODE_TIMEOUT: Duration = Duration::from_millis(250);
/// VideoToolbox may retain the tail of a compression window until another
/// frame arrives. Flush only after two normal capture intervals have elapsed,
/// preserving pipelining during motion while bounding a static first frame.
pub(super) const ENCODE_FLUSH_DELAY: Duration = Duration::from_millis(75);
/// How long the ACK window may stay full without a single acknowledgement
/// arriving before the client is treated as no longer consuming EGFX.
///
/// Backpressure drops frames by design, so a client that stops acknowledging
/// would otherwise freeze the desktop indefinitely while capture stays healthy.
/// This bound converts that permanent stall into a one-time downgrade to the
/// bitmap path, which every client supports.
pub(super) const ACK_STALL_TIMEOUT: Duration = Duration::from_millis(1500);
/// Maximum time acknowledged AVC420 frames may fail to increase the client's
/// decoded-frame counter before the mapped surface is considered unusable.
pub(super) const DECODE_STALL_TIMEOUT: Duration = Duration::from_millis(1500);

/// Start of the current uninterrupted backpressure window.
#[derive(Clone, Copy)]
pub(super) struct AckStall {
    pub(super) since: Instant,
    pub(super) acks: u64,
}

/// Decoded-frame counter observed at the beginning of the current validation
/// window. This window starts only after an AVC420 frame is submitted.
#[derive(Clone, Copy)]
pub(super) struct DecodeWatch {
    pub(super) since: Instant,
    pub(super) decoded: u32,
}

/// What to do about a full ACK window.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum StallVerdict {
    /// Begin (or restart) the stall window against the current ACK count.
    Restart,
    /// Client is behind but still acknowledging. Drop this frame.
    Wait,
    /// Client has not acknowledged anything for [`ACK_STALL_TIMEOUT`]. Stop
    /// using EGFX so the desktop keeps updating over the bitmap path.
    Disable,
}

/// Decide the fate of a full ACK window from the stall record and the current
/// acknowledgement count. Pure so the timing policy is directly testable.
pub(super) fn stall_verdict(stall: Option<AckStall>, acks: u64, now: Instant) -> StallVerdict {
    match stall {
        // Acknowledgements advanced during the window: the client is consuming.
        Some(stall) if stall.acks != acks => StallVerdict::Restart,
        Some(stall) if now.duration_since(stall.since) >= ACK_STALL_TIMEOUT => {
            StallVerdict::Disable
        }
        Some(_) => StallVerdict::Wait,
        None => StallVerdict::Restart,
    }
}

pub(super) fn decode_verdict(watch: DecodeWatch, decoded: u32, now: Instant) -> StallVerdict {
    if watch.decoded != decoded {
        StallVerdict::Restart
    } else if now.duration_since(watch.since) >= DECODE_STALL_TIMEOUT {
        StallVerdict::Disable
    } else {
        StallVerdict::Wait
    }
}
