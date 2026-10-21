use std::time::Duration;

/// How often to send a keepalive ping on an idle connection.
pub(super) const PING_INTERVAL: Duration = Duration::from_secs(15);
/// How long the handshake may take before the connection is abandoned.
pub(super) const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Hard cap on a single control frame (hardening: bounds a malicious peer's
/// length prefix so it can't force a huge allocation). Well above any legitimate
/// frame — file pieces are 256 KiB raw (no base64) + a tiny header.
pub(super) const MAX_FRAME_LEN: usize = 4 * 1024 * 1024;
/// Bounded capacity of a connection's binary-data (file-piece) queue. This is
/// the backpressure point: a seeder's `send_data` awaits a free slot, so a fast
/// disk can never pile the whole file into memory. Control frames use a
/// separate, prioritized queue so pings/text never wait behind piece data.
pub(super) const DATA_QUEUE_CAP: usize = 8;
/// Bounded depth of a connection's real-time media queue (TAG_MEDIA frames).
/// Unlike the file-data queue, this is **drop-oldest, never-block**: a media
/// producer (encoder) must never stall waiting for the network, and stale media
/// is worthless, so on overflow the oldest queued frame is discarded to keep
/// latency bounded. ~64 frames is a fraction of a second of audio (or a handful
/// of video frames) — enough to ride out a transient TCP stall without growing
/// latency unboundedly.
pub(super) const MEDIA_QUEUE_CAP: usize = 64;
