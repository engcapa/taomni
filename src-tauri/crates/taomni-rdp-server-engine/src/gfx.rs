//! Low-latency macOS EGFX/AVC420 path for the in-process RDP server.
//!
//! The regular RDP bitmap path remains the compatibility baseline. When a
//! client advertises the Graphics Pipeline Extension with AVC420, this module
//! sends current ScreenCaptureKit frames through VideoToolbox's real-time H.264
//! encoder instead. The graphics server's frame acknowledgements are used as a
//! hard two-frame backpressure boundary: newest state wins over building a
//! network or decoder backlog.
//!
//! ACK receipt and decoded-frame progress are tracked separately. A client that
//! keeps acknowledging transport frames without advancing `totalFramesDecoded`
//! is downgraded to bitmap updates, preventing an undecodable mapped surface
//! from permanently hiding the reliable compatibility path.

mod flow_control;

mod transport;

mod handler;

mod encoder;

mod avc;

#[cfg(test)]
mod tests;

pub(crate) use flow_control::ENCODE_TIMEOUT;

pub(crate) use transport::{GfxReadiness, GfxSubmit, GfxTransport};

pub(crate) use handler::EgfxFactory;

pub(crate) use encoder::{EncodedFrame, H264Encoder};
