use core::fmt;
use core::num::NonZeroU16;
use core::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context as _, Result, anyhow};
use ironrdp_acceptor::DesktopSize;
use ironrdp_bulk::BulkCompressor;
#[cfg(test)]
use ironrdp_bulk::CompressionType as BulkType;
use ironrdp_graphics::diff::{Rect, find_different_rects_sub};
use ironrdp_pdu::encode_vec;
use ironrdp_pdu::fast_path::UpdateCode;
use ironrdp_pdu::geometry::ExclusiveRectangle;
use ironrdp_pdu::pointer::{
    CachedPointerAttribute, ColorPointerAttribute, Point16, PointerAttribute,
    PointerPositionAttribute,
};
use ironrdp_pdu::rdp::capability_sets::{CmdFlags, EntropyBits};
use ironrdp_pdu::rdp::client_info::CompressionType;
use ironrdp_pdu::surface_commands::{ExtendedBitmapDataPdu, SurfaceBitsPdu, SurfaceCommand};
use tracing::{debug, warn};

use self::bitmap::BitmapEncoder;
use self::rfx::RfxEncoder;
use super::BitmapUpdate;
use crate::macros::time_warn;
use crate::{ColorPointer, DisplayUpdate, Framebuffer, RGBAPointer};

mod bitmap;
mod bulk;
mod fast_path;
pub(crate) mod rfx;

pub(crate) use fast_path::*;
use ironrdp_graphics::rdp6::BitmapEncodeError;

/// Optional aggregate counters. The compressor itself always remains per connection.
#[derive(Debug, Default)]
pub struct EncoderStats {
    pub planar_rects: AtomicU64,
    pub rfx_rects: AtomicU64,
    pub bytes_before_bulk: AtomicU64,
    pub bytes_after_bulk: AtomicU64,
}

const PLANAR_BULK_GIVE_UP_RATIO: f64 = 0.25;
const PLANAR_ESTIMATE_SAMPLE_SIZE: usize = 1024;

/// Estimate with a throwaway MPPC-64K history. Never touch the connection's
/// compressor until the selected payload is actually fragmented and sent.
fn estimate_bulk_size(data: &[u8]) -> Result<usize> {
    if data.is_empty() {
        return Ok(0);
    }
    // Bound the photo cost while covering the whole encoded rectangle. A
    // prefix alone can be entirely desktop padding around a noisy photo.
    // Four separated 256-byte strips retain runs and sample all colour planes.
    let mut strips = [0u8; PLANAR_ESTIMATE_SAMPLE_SIZE];
    let sample = if data.len() <= strips.len() {
        data
    } else {
        let strip_size = strips.len() / 4;
        for index in 0..4 {
            let start = index * (data.len() - strip_size) / 3;
            strips[index * strip_size..(index + 1) * strip_size]
                .copy_from_slice(&data[start..start + strip_size]);
        }
        &strips
    };
    estimate_bulk_sample(data.len(), sample)
}

fn estimate_bulk_sample(length: usize, sample: &[u8]) -> Result<usize> {
    let encoded = BulkCompressor::estimate_mppc64k_size(sample)?;
    Ok((encoded * length).div_ceil(sample.len()))
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
#[repr(u8)]
enum CodecId {
    None = 0x0,
}

impl CodecId {
    #[expect(
        clippy::as_conversions,
        reason = "guarantees discriminant layout, and as is the only way to cast enum -> primitive"
    )]
    fn as_u8(self) -> u8 {
        self as u8
    }
}

#[cfg_attr(feature = "__bench", visibility::make(pub))]
#[derive(Debug)]
pub(crate) struct UpdateEncoderCodecs {
    remotefx: Option<(EntropyBits, u8)>,
    #[cfg(feature = "qoi")]
    qoi: Option<u8>,
    #[cfg(feature = "qoiz")]
    qoiz: Option<u8>,
    /// `(codec_id, color_loss_level)` from the negotiated NsCodec capability.
    #[cfg(feature = "nscodec")]
    nscodec: Option<(u8, u8)>,
}

impl UpdateEncoderCodecs {
    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) fn new() -> Self {
        Self {
            remotefx: None,
            #[cfg(feature = "qoi")]
            qoi: None,
            #[cfg(feature = "qoiz")]
            qoiz: None,
            #[cfg(feature = "nscodec")]
            nscodec: None,
        }
    }

    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) fn set_remotefx(&mut self, remotefx: Option<(EntropyBits, u8)>) {
        self.remotefx = remotefx
    }

    #[cfg(feature = "qoi")]
    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) fn set_qoi(&mut self, qoi: Option<u8>) {
        self.qoi = qoi
    }

    #[cfg(feature = "qoiz")]
    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) fn set_qoiz(&mut self, qoiz: Option<u8>) {
        self.qoiz = qoiz
    }

    /// Record the negotiated NsCodec codec id and color-loss level so the
    /// encoder selection path can build an `NsCodecHandler` for this session.
    #[cfg(feature = "nscodec")]
    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) fn set_nscodec(&mut self, nscodec: Option<(u8, u8)>) {
        self.nscodec = nscodec
    }
}

impl Default for UpdateEncoderCodecs {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(feature = "__bench", visibility::make(pub))]
pub(crate) struct UpdateEncoder {
    bulk: Option<bulk::BulkEncoder>,
    stats: Option<Arc<EncoderStats>>,
    desktop_size: DesktopSize,
    framebuffer: Option<Framebuffer>,
    bitmap_updater: Option<BitmapUpdater>,
    /// Negotiated MultifragmentUpdate reassembly buffer size. Used to split
    /// oversized bitmaps into strips that fit within the limit when sent as
    /// uncompressed surface commands.
    max_request_size: usize,
}

impl fmt::Debug for UpdateEncoder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UpdateEncoder")
            .field("bitmap_update", &self.bitmap_updater)
            .finish()
    }
}

impl UpdateEncoder {
    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) fn new(
        desktop_size: DesktopSize,
        surface_flags: CmdFlags,
        codecs: UpdateEncoderCodecs,
        max_request_size: u32,
    ) -> Result<Self> {
        let bitmap_updater = if surface_flags.contains(CmdFlags::SET_SURFACE_BITS) {
            match codecs {
                #[cfg(feature = "qoiz")]
                UpdateEncoderCodecs { qoiz: Some(id), .. } => BitmapUpdater::Qoiz(
                    QoizHandler::new(id).context("failed to initialize qoiz handler")?,
                ),
                #[cfg(feature = "qoi")]
                UpdateEncoderCodecs { qoi: Some(id), .. } => {
                    BitmapUpdater::Qoi(QoiHandler::new(id))
                }
                UpdateEncoderCodecs {
                    remotefx: Some((algo, id)),
                    ..
                } => BitmapUpdater::RemoteFx(RemoteFxHandler::new(algo, id, desktop_size)),
                // NSCodec is the lowest-priority codec because it predates
                // RemoteFX and produces larger output. It's relevant mainly
                // for clients (notably macOS Microsoft Remote Desktop /
                // Windows App) whose legacy bitmap-codec list advertises
                // only NSCodec — those clients would otherwise fall through
                // to raw/RLE BitmapUpdate at much higher bandwidth.
                #[cfg(feature = "nscodec")]
                UpdateEncoderCodecs {
                    nscodec: Some((id, cll)),
                    ..
                } => BitmapUpdater::NsCodec(NsCodecHandler::new(id, cll)),
                _ => BitmapUpdater::None(NoneHandler),
            }
        } else {
            BitmapUpdater::Bitmap(BitmapHandler::new())
        };

        Ok(Self {
            bulk: None,
            stats: None,
            desktop_size,
            framebuffer: None,
            bitmap_updater: Some(bitmap_updater),
            max_request_size: usize::try_from(max_request_size).context("max_request_size")?,
        })
    }

    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) fn update(&mut self, update: DisplayUpdate) -> EncoderIter<'_> {
        EncoderIter {
            encoder: self,
            state: State::Start(update),
        }
    }

    pub(crate) fn with_bulk_compression(
        mut self,
        compression: Option<CompressionType>,
        stats: Option<Arc<EncoderStats>>,
        omit_bitmap_compression_header: bool,
    ) -> Result<Self> {
        self.stats = stats;
        if let Some(compression) = compression {
            // Preserve the proprietary codec paths byte for byte.
            let updater = self
                .bitmap_updater
                .as_mut()
                .expect("bitmap updater always Some");
            if let BitmapUpdater::RemoteFx(rfx) = updater {
                let rfx = rfx.clone();
                self.bulk = Some(bulk::BulkEncoder::new(compression)?);
                *updater = BitmapUpdater::Adaptive(AdaptiveHandler {
                    bitmap: BitmapHandler::for_bulk_compression(omit_bitmap_compression_header),
                    rfx,
                });
            } else if matches!(updater, BitmapUpdater::Bitmap(_)) {
                self.bulk = Some(bulk::BulkEncoder::new(compression)?);
                *updater = BitmapUpdater::Bitmap(BitmapHandler::for_bulk_compression(
                    omit_bitmap_compression_header,
                ));
            }
        }
        Ok(self)
    }

    pub(crate) fn set_desktop_size(&mut self, size: DesktopSize) -> Result<()> {
        self.desktop_size = size;
        self.framebuffer = None;
        if let Some(bulk) = self.bulk.as_mut() {
            bulk.reset()?;
        }
        self.bitmap_updater
            .as_mut()
            .expect("bitmap updater always Some")
            .set_desktop_size(size);
        Ok(())
    }

    fn rgba_pointer(ptr: RGBAPointer) -> Result<UpdateFragmenter> {
        let xor_mask = ptr.data;

        let hot_spot = Point16 {
            x: ptr.hot_x,
            y: ptr.hot_y,
        };
        let color_pointer = ColorPointerAttribute {
            cache_index: ptr.cache_index,
            hot_spot,
            width: ptr.width,
            height: ptr.height,
            xor_mask: &xor_mask,
            and_mask: &[],
        };
        let ptr = PointerAttribute {
            xor_bpp: 32,
            color_pointer,
        };
        Ok(UpdateFragmenter::new(
            UpdateCode::NewPointer,
            encode_vec(&ptr)?,
        ))
    }

    fn color_pointer(ptr: ColorPointer) -> Result<UpdateFragmenter> {
        let hot_spot = Point16 {
            x: ptr.hot_x,
            y: ptr.hot_y,
        };
        let ptr = ColorPointerAttribute {
            cache_index: ptr.cache_index,
            hot_spot,
            width: ptr.width,
            height: ptr.height,
            xor_mask: &ptr.xor_mask,
            and_mask: &ptr.and_mask,
        };
        Ok(UpdateFragmenter::new(
            UpdateCode::ColorPointer,
            encode_vec(&ptr)?,
        ))
    }

    fn cached_pointer(cache_index: u16) -> Result<UpdateFragmenter> {
        let ptr = CachedPointerAttribute { cache_index };
        Ok(UpdateFragmenter::new(
            UpdateCode::CachedPointer,
            encode_vec(&ptr)?,
        ))
    }

    fn default_pointer() -> Result<UpdateFragmenter> {
        Ok(UpdateFragmenter::new(UpdateCode::DefaultPointer, vec![]))
    }

    fn hide_pointer() -> Result<UpdateFragmenter> {
        Ok(UpdateFragmenter::new(UpdateCode::HiddenPointer, vec![]))
    }

    fn pointer_position(pos: PointerPositionAttribute) -> Result<UpdateFragmenter> {
        Ok(UpdateFragmenter::new(
            UpdateCode::PositionPointer,
            encode_vec(&pos)?,
        ))
    }

    fn bitmap_diffs(&mut self, bitmap: &BitmapUpdate) -> Vec<Rect> {
        // TODO: we may want to make it optional for servers that already provide damaged regions
        const USE_DIFFS: bool = true;

        let diffs = if let Some(Framebuffer {
            data,
            stride,
            width,
            height,
            ..
        }) = USE_DIFFS.then_some(self.framebuffer.as_ref()).flatten()
        {
            find_different_rects_sub::<4>(
                data,
                *stride,
                width.get().into(),
                height.get().into(),
                &bitmap.data,
                bitmap.stride.get(),
                bitmap.width.get().into(),
                bitmap.height.get().into(),
                bitmap.x.into(),
                bitmap.y.into(),
            )
        } else {
            vec![Rect {
                x: 0,
                y: 0,
                width: bitmap.width.get().into(),
                height: bitmap.height.get().into(),
            }]
        };

        // Subdivide diff rects whose uncompressed size would exceed the
        // MultifragmentUpdate reassembly buffer.
        let mut tiled = Vec::with_capacity(diffs.len());
        for rect in diffs {
            if rect.width * rect.height * 4 <= self.max_request_size {
                tiled.push(rect);
            } else {
                let rects = self.split_diff(rect);
                tiled.extend(rects);
            }
        }
        tiled
    }

    /// Split a rect into tiles that fit within `max_request_size`.
    /// Splits by height first, then by width within each horizontal strip.
    fn split_diff(&self, rect: Rect) -> Vec<Rect> {
        let mut rects = Vec::new();

        let max_height = (self.max_request_size / (rect.width * 4)).max(1);
        let mut y = rect.y;
        let y_end = rect.y + rect.height;
        while y < y_end {
            let h = (y_end - y).min(max_height);
            // Width splitting is unlikely in practice (would require
            // max_request_size < ~256 KB), but ensures correctness.
            let max_width = (self.max_request_size / (h * 4)).max(1);
            let mut x = rect.x;
            let x_end = rect.x + rect.width;
            while x < x_end {
                let w = (x_end - x).min(max_width);
                rects.push(Rect {
                    x,
                    y,
                    width: w,
                    height: h,
                });
                x += max_width;
            }
            y += max_height;
        }

        rects
    }

    fn bitmap_update_framebuffer(&mut self, bitmap: BitmapUpdate, diffs: &[Rect]) {
        if bitmap.x == 0
            && bitmap.y == 0
            && bitmap.width.get() == self.desktop_size.width
            && bitmap.height.get() == self.desktop_size.height
        {
            match bitmap.try_into() {
                Ok(framebuffer) => self.framebuffer = Some(framebuffer),
                Err(err) => warn!("Failed to convert bitmap to framebuffer: {}", err),
            }
        } else if let Some(fb) = self.framebuffer.as_mut() {
            fb.update_diffs(&bitmap, diffs);
        }
    }

    async fn bitmap(&mut self, bitmap: BitmapUpdate) -> Result<UpdateFragmenter> {
        // Move the bitmap updater to satisfy spawn_blocking 'static requirement.
        // It is restored after the blocking operation completes.
        let mut updater = self
            .bitmap_updater
            .take()
            .expect("bitmap updater always Some");

        let (result, updater) = tokio::task::spawn_blocking(move || {
            let result = time_warn!("Encoding bitmap", 10, updater.handle(&bitmap));
            (result, updater)
        })
        .await?;

        self.bitmap_updater = Some(updater);

        if let (Ok(fragment), Some(stats)) = (&result, &self.stats) {
            if fragment.code == UpdateCode::Bitmap {
                stats.planar_rects.fetch_add(1, Ordering::Relaxed);
            } else if matches!(
                self.bitmap_updater,
                Some(BitmapUpdater::RemoteFx(_) | BitmapUpdater::Adaptive(_))
            ) {
                stats.rfx_rects.fetch_add(1, Ordering::Relaxed);
            }
        }

        result
    }
}

#[derive(Debug, Default)]
enum State {
    Start(DisplayUpdate),
    BitmapDiffs {
        diffs: Vec<Rect>,
        bitmap: BitmapUpdate,
        pos: usize,
    },
    #[default]
    Ended,
}

#[cfg_attr(feature = "__bench", visibility::make(pub))]
pub(crate) struct EncoderIter<'a> {
    encoder: &'a mut UpdateEncoder,
    state: State,
}

impl EncoderIter<'_> {
    pub(crate) fn encode_fragment(
        &mut self,
        fragment: &mut UpdateFragmenter,
        buffer: &mut [u8],
    ) -> Result<Option<usize>> {
        let encoder = &mut self.encoder;
        let result = fragment.next(buffer, encoder.bulk.as_mut(), encoder.stats.as_deref());
        if encoder
            .bulk
            .as_ref()
            .is_some_and(|bulk| bulk.compressor.is_none())
            && matches!(encoder.bitmap_updater, Some(BitmapUpdater::Adaptive(_)))
        {
            if let Some(BitmapUpdater::Adaptive(handler)) = encoder.bitmap_updater.take() {
                encoder.bitmap_updater = Some(BitmapUpdater::RemoteFx(handler.rfx));
            }
        }
        result
    }

    #[cfg_attr(feature = "__bench", visibility::make(pub))]
    pub(crate) async fn next(&mut self) -> Option<Result<UpdateFragmenter>> {
        loop {
            let state = core::mem::take(&mut self.state);
            let encoder = &mut self.encoder;

            let res = match state {
                State::Start(update) => match update {
                    DisplayUpdate::Bitmap(bitmap) => {
                        let ds = encoder.desktop_size;
                        if bitmap.x + bitmap.width.get() > ds.width
                            || bitmap.y + bitmap.height.get() > ds.height
                        {
                            debug!(
                                "Dropping bitmap update that exceeds desktop size: \
                                 bitmap ({}, {}) {}x{} vs desktop {}x{}",
                                bitmap.x,
                                bitmap.y,
                                bitmap.width,
                                bitmap.height,
                                ds.width,
                                ds.height,
                            );
                            continue;
                        }
                        let diffs = encoder.bitmap_diffs(&bitmap);
                        self.state = State::BitmapDiffs {
                            diffs,
                            bitmap,
                            pos: 0,
                        };
                        continue;
                    }
                    DisplayUpdate::PointerPosition(pos) => UpdateEncoder::pointer_position(pos),
                    DisplayUpdate::RGBAPointer(ptr) => UpdateEncoder::rgba_pointer(ptr),
                    DisplayUpdate::ColorPointer(ptr) => UpdateEncoder::color_pointer(ptr),
                    DisplayUpdate::HidePointer => UpdateEncoder::hide_pointer(),
                    DisplayUpdate::DefaultPointer => UpdateEncoder::default_pointer(),
                    DisplayUpdate::CachedPointer(idx) => UpdateEncoder::cached_pointer(idx),
                    DisplayUpdate::Resize(_) => return None,
                },
                State::BitmapDiffs { diffs, bitmap, pos } => {
                    let Some(rect) = diffs.get(pos) else {
                        encoder.bitmap_update_framebuffer(bitmap, &diffs);
                        self.state = State::Ended;
                        return None;
                    };
                    let Rect {
                        x,
                        y,
                        width,
                        height,
                    } = *rect;

                    let x = match u16::try_from(x) {
                        Ok(x) => x,
                        Err(_) => {
                            return Some(Err(anyhow!(
                                "invalid `x`: out of range integral conversion"
                            )));
                        }
                    };
                    let y = match u16::try_from(y) {
                        Ok(y) => y,
                        Err(_) => {
                            return Some(Err(anyhow!(
                                "invalid `y`: out of range integral conversion"
                            )));
                        }
                    };
                    let width = match u16::try_from(width) {
                        Ok(width) => match NonZeroU16::new(width) {
                            Some(width) => width,
                            None => return Some(Err(anyhow!("rectangle width cannot be zero"))),
                        },
                        Err(_) => {
                            return Some(Err(anyhow!(
                                "invalid `width`: out of range integral conversion"
                            )));
                        }
                    };
                    let height = match u16::try_from(height) {
                        Ok(height) => match NonZeroU16::new(height) {
                            Some(height) => height,
                            None => return Some(Err(anyhow!("rectangle height cannot be zero"))),
                        },
                        Err(_) => {
                            return Some(Err(anyhow!(
                                "invalid `height`: out of range integral conversion"
                            )));
                        }
                    };

                    let Some(sub) = bitmap.sub(x, y, width, height) else {
                        warn!("Failed to extract bitmap subregion");
                        return None;
                    };
                    self.state = State::BitmapDiffs {
                        diffs,
                        bitmap,
                        pos: pos + 1,
                    };
                    encoder.bitmap(sub).await
                }
                State::Ended => return None,
            };

            return Some(res);
        }
    }
}

#[derive(Debug)]
enum BitmapUpdater {
    Adaptive(AdaptiveHandler),
    None(NoneHandler),
    Bitmap(BitmapHandler),
    RemoteFx(RemoteFxHandler),
    #[cfg(feature = "qoi")]
    Qoi(QoiHandler),
    #[cfg(feature = "qoiz")]
    Qoiz(QoizHandler),
    #[cfg(feature = "nscodec")]
    NsCodec(NsCodecHandler),
}

impl BitmapUpdater {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        match self {
            Self::Adaptive(up) => up.handle(bitmap),
            Self::None(up) => up.handle(bitmap),
            Self::Bitmap(up) => up.handle(bitmap),
            Self::RemoteFx(up) => up.handle(bitmap),
            #[cfg(feature = "qoi")]
            Self::Qoi(up) => up.handle(bitmap),
            #[cfg(feature = "qoiz")]
            Self::Qoiz(up) => up.handle(bitmap),
            #[cfg(feature = "nscodec")]
            Self::NsCodec(up) => up.handle(bitmap),
        }
    }

    fn set_desktop_size(&mut self, size: DesktopSize) {
        match self {
            Self::RemoteFx(up) => up.set_desktop_size(size),
            Self::Adaptive(up) => up.rfx.set_desktop_size(size),
            _ => {}
        }
    }
}

trait BitmapUpdateHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter>;
}

#[derive(Debug)]
struct AdaptiveHandler {
    bitmap: BitmapHandler,
    rfx: RemoteFxHandler,
}

impl BitmapUpdateHandler for AdaptiveHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        if bitmap.width.get() > u16::MAX / 4
            || !self.bitmap.bitmap.supports_width(bitmap.width.get())
        {
            return self
                .rfx
                .handle_compact(bitmap)
                .map(UpdateFragmenter::without_bulk_compression);
        }
        let (length, estimate, planar) =
            if let Some((length, sample)) = self.bitmap.bitmap.raw_planar_sample(bitmap)? {
                (length, estimate_bulk_sample(length, &sample)?, None)
            } else {
                let planar = self.bitmap.handle(bitmap)?;
                (
                    planar.data.len(),
                    estimate_bulk_size(&planar.data)?,
                    Some(planar),
                )
            };
        if estimate as f64 <= length as f64 * PLANAR_BULK_GIVE_UP_RATIO {
            return match planar {
                Some(planar) => Ok(planar),
                None => self.bitmap.handle(bitmap),
            };
        }
        // Encoding a rejected RemoteFX candidate must not consume its first
        // frame headers or advance its frame index.
        let mut candidate = self.rfx.clone();
        let rfx = candidate.handle_compact(bitmap)?;
        if estimate <= rfx.data.len() {
            match planar {
                Some(planar) => Ok(planar),
                None => self.bitmap.handle(bitmap),
            }
        } else {
            self.rfx = candidate;
            Ok(rfx.without_bulk_compression())
        }
    }
}

#[derive(Clone, Debug)]
struct NoneHandler;

impl BitmapUpdateHandler for NoneHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        let stride = usize::from(bitmap.format.bytes_per_pixel()) * usize::from(bitmap.width.get());
        let mut data = Vec::with_capacity(stride * usize::from(bitmap.height.get()));
        for row in bitmap.data.chunks(bitmap.stride.get()).rev() {
            data.extend_from_slice(&row[..stride]);
        }
        set_surface(bitmap, CodecId::None.as_u8(), &data)
    }
}

#[derive(Clone)]
struct BitmapHandler {
    bitmap: BitmapEncoder,
}

impl fmt::Debug for BitmapHandler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BitmapHandler").finish()
    }
}

impl BitmapHandler {
    fn new() -> Self {
        Self {
            bitmap: BitmapEncoder::new(),
        }
    }

    fn for_bulk_compression(omit_compression_header: bool) -> Self {
        Self {
            bitmap: BitmapEncoder::for_bulk_compression(omit_compression_header),
        }
    }
}

impl BitmapUpdateHandler for BitmapHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        // Crops may retain a much wider parent stride. Reserve for pixels
        // actually encoded rather than clearing the entire parent-sized tail.
        let mut buffer = vec![0; self.bitmap.output_size_hint(bitmap)];
        let len = loop {
            match self.bitmap.encode(bitmap, buffer.as_mut_slice()) {
                Err(err) => match err {
                    BitmapEncodeError::Encode(e) => match e.kind() {
                        ironrdp_core::EncodeErrorKind::NotEnoughBytes { .. } => {
                            buffer.resize(buffer.len() * 2, 0);
                            debug!("encoder buffer resized to: {}", buffer.len() * 2);
                        }
                        _ => Err(e).context("bitmap encode error")?,
                    },
                    BitmapEncodeError::Rle(e) => Err(e).context("bitmap RLE encode error")?,
                },
                Ok(len) => break len,
            }
        };

        buffer.truncate(len);
        Ok(UpdateFragmenter::new(UpdateCode::Bitmap, buffer))
    }
}

#[derive(Debug, Clone)]
struct RemoteFxHandler {
    remotefx: RfxEncoder,
    codec_id: u8,
    desktop_size: Option<DesktopSize>,
}

impl RemoteFxHandler {
    fn new(algo: EntropyBits, codec_id: u8, desktop_size: DesktopSize) -> Self {
        Self {
            remotefx: RfxEncoder::new(algo),
            desktop_size: Some(desktop_size),
            codec_id,
        }
    }

    fn set_desktop_size(&mut self, size: DesktopSize) {
        self.desktop_size = Some(size);
    }

    fn handle_compact(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        self.encode(bitmap, true)
    }

    fn encode(&mut self, bitmap: &BitmapUpdate, compact: bool) -> Result<UpdateFragmenter> {
        // A crop retains the parent framebuffer's stride and tail. RemoteFX
        // reads only this rectangle, so clearing that whole tail per dirty
        // rectangle needlessly touches megabytes on each photo frame. Restrict
        // the new reserve/retry behavior to the adaptive path: the legacy path
        // must retain its existing bytes, including tiny first-frame retries.
        let pixels = usize::from(bitmap.width.get()) * usize::from(bitmap.height.get());
        let mut buffer = vec![
            0;
            if compact {
                pixels * 4 + 4096
            } else {
                bitmap.data.len()
            }
        ];
        let len = loop {
            let desktop_size = if compact {
                self.desktop_size
            } else {
                self.desktop_size.take()
            };
            match self
                .remotefx
                .encode(bitmap, buffer.as_mut_slice(), desktop_size)
            {
                Err(e) => match e.kind() {
                    ironrdp_core::EncodeErrorKind::NotEnoughBytes { .. } => {
                        buffer.resize(buffer.len() * 2, 0);
                        debug!("encoder buffer resized to: {}", buffer.len() * 2);
                    }
                    _ => Err(e).context("RemoteFX encode error")?,
                },
                Ok(len) => {
                    if compact {
                        self.desktop_size = None;
                    }
                    break len;
                }
            }
        };

        set_surface(bitmap, self.codec_id, &buffer[..len])
    }
}

impl BitmapUpdateHandler for RemoteFxHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        self.encode(bitmap, false)
    }
}

#[cfg(feature = "qoi")]
#[derive(Clone, Debug)]
struct QoiHandler {
    codec_id: u8,
}

#[cfg(feature = "qoi")]
impl QoiHandler {
    fn new(codec_id: u8) -> Self {
        Self { codec_id }
    }
}

#[cfg(feature = "qoi")]
impl BitmapUpdateHandler for QoiHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        let data = qoi_encode(bitmap)?;
        set_surface(bitmap, self.codec_id, &data)
    }
}

#[cfg(feature = "qoiz")]
struct QoizHandler {
    codec_id: u8,
    zctxt: zstd_safe::CCtx<'static>,
}

#[cfg(feature = "qoiz")]
impl fmt::Debug for QoizHandler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("QoizHandler")
            .field("codec_id", &self.codec_id)
            .finish()
    }
}

#[cfg(feature = "qoiz")]
impl QoizHandler {
    fn new(codec_id: u8) -> Result<Self> {
        let mut zctxt = zstd_safe::CCtx::default();

        zctxt
            .set_parameter(zstd_safe::CParameter::CompressionLevel(3))
            .map_err(|code| {
                anyhow!(
                    "failed to set zstd compression level: {}",
                    zstd_safe::get_error_name(code)
                )
            })?;
        zctxt
            .set_parameter(zstd_safe::CParameter::EnableLongDistanceMatching(true))
            .map_err(|code| {
                anyhow!(
                    "failed to set zstd enable long distance matching: {}",
                    zstd_safe::get_error_name(code)
                )
            })?;

        Ok(Self { codec_id, zctxt })
    }
}

#[cfg(feature = "qoiz")]
impl BitmapUpdateHandler for QoizHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        let qoi = qoi_encode(bitmap)?;
        let mut inb = zstd_safe::InBuffer::around(&qoi);
        let mut data = vec![0; qoi.len()];
        let mut outb;
        let mut pos = 0;

        loop {
            outb = zstd_safe::OutBuffer::around_pos(data.as_mut_slice(), pos);
            let res = self
                .zctxt
                .compress_stream2(
                    &mut outb,
                    &mut inb,
                    zstd_safe::zstd_sys::ZSTD_EndDirective::ZSTD_e_flush,
                )
                .map_err(|code| {
                    anyhow!(
                        "failed to Zstd compress: {}",
                        zstd_safe::get_error_name(code)
                    )
                })?;
            if res == 0 {
                break;
            }
            pos = outb.pos();
            data.resize(data.len() + res, 0);
        }

        set_surface(bitmap, self.codec_id, outb.as_slice())
    }
}

#[cfg(feature = "nscodec")]
#[derive(Clone, Debug)]
struct NsCodecHandler {
    codec_id: u8,
    color_loss_level: u8,
}

#[cfg(feature = "nscodec")]
impl NsCodecHandler {
    fn new(codec_id: u8, color_loss_level: u8) -> Self {
        Self {
            codec_id,
            color_loss_level,
        }
    }
}

#[cfg(feature = "nscodec")]
impl BitmapUpdateHandler for NsCodecHandler {
    fn handle(&mut self, bitmap: &BitmapUpdate) -> Result<UpdateFragmenter> {
        let data = ironrdp_nscodec::encoder::encode(
            &bitmap.data,
            bitmap.width.get(),
            bitmap.height.get(),
            bitmap.stride.get(),
            bitmap.format,
            self.color_loss_level,
        );
        set_surface(bitmap, self.codec_id, &data)
    }
}

#[cfg(feature = "qoi")]
fn qoi_encode(bitmap: &BitmapUpdate) -> Result<Vec<u8>> {
    use ironrdp_graphics::image_processing::PixelFormat::*;
    // Map every 4-byte input — whether it nominally has an alpha byte or
    // an "X" filler — to the 3-channel-output `*x` variant of
    // `RawChannels`. The qoi crate selects `Channels::Rgb` vs
    // `Channels::Rgba` for the QOI header from this enum: `*x` and `*r/g/b`
    // produce `Rgb`; `*a` produces `Rgba`. The `ironrdp-session` NSCodec-
    // free decode path in `fast_path.rs::qoi_apply` only supports
    // `Channels::Rgb` and explicitly drops `Channels::Rgba` frames with
    // `WARN: Unsupported RGBA QOI data`, so the previous "honest" mapping
    // (`BgrA32 -> Bgra`, etc.) produced output that no IronRDP client
    // could decode — every QOI session rendered a blank screen.
    //
    // Server-side bitmap captures are functionally opaque (the alpha byte
    // is either always 0xFF or treated as filler), so discarding it is
    // safe and matches what every successful legacy bitmap path
    // already does.
    let raw_channels = match bitmap.format {
        ARgb32 | XRgb32 => qoi::RawChannels::Xrgb,
        ABgr32 | XBgr32 => qoi::RawChannels::Xbgr,
        BgrA32 | BgrX32 => qoi::RawChannels::Bgrx,
        RgbA32 | RgbX32 => qoi::RawChannels::Rgbx,
    };
    let enc = qoi::EncoderBuilder::new(
        &bitmap.data,
        bitmap.width.get().into(),
        bitmap.height.get().into(),
    )
    .stride(bitmap.stride.get())
    .raw_channels(raw_channels)
    .build()?;
    Ok(enc.encode_to_vec()?)
}

fn set_surface(bitmap: &BitmapUpdate, codec_id: u8, data: &[u8]) -> Result<UpdateFragmenter> {
    let destination = ExclusiveRectangle {
        left: bitmap.x,
        top: bitmap.y,
        right: bitmap.x + bitmap.width.get(),
        bottom: bitmap.y + bitmap.height.get(),
    };
    let extended_bitmap_data = ExtendedBitmapDataPdu {
        bpp: bitmap.format.bytes_per_pixel() * 8,
        width: bitmap.width.get(),
        height: bitmap.height.get(),
        codec_id,
        header: None,
        data,
    };
    let pdu = SurfaceBitsPdu {
        destination,
        extended_bitmap_data,
    };
    let cmd = SurfaceCommand::SetSurfaceBits(pdu);
    Ok(UpdateFragmenter::new(
        UpdateCode::SurfaceCommands,
        encode_vec(&cmd)?,
    ))
}

#[cfg(test)]
mod bulk_tests {
    use super::*;
    use core::num::NonZeroUsize;
    use ironrdp_core::{ReadCursor, decode_cursor};
    use ironrdp_pdu::fast_path::{FastPathHeader, FastPathUpdatePdu};
    use ironrdp_pdu::rdp::headers::CompressionFlags;

    fn encoder() -> UpdateEncoder {
        let mut codecs = UpdateEncoderCodecs::new();
        codecs.set_remotefx(Some((EntropyBits::Rlgr3, 3)));
        UpdateEncoder::new(
            DesktopSize {
                width: 256,
                height: 128,
            },
            CmdFlags::SET_SURFACE_BITS,
            codecs,
            8 * 1024 * 1024,
        )
        .unwrap()
        .with_bulk_compression(Some(CompressionType::Rdp61), None, true)
        .unwrap()
    }

    #[test]
    fn desktop_resize_flushes_history_even_when_reusing_the_encoder() {
        let mut encoder = encoder();
        let original = vec![42; 4000];
        let mut receiver = BulkCompressor::new(BulkType::Rdp61).unwrap();
        for index in 0..3 {
            if index == 2 {
                encoder
                    .set_desktop_size(DesktopSize {
                        width: 320,
                        height: 128,
                    })
                    .unwrap();
            }
            let mut fragment = UpdateFragmenter::new(UpdateCode::Bitmap, original.clone());
            let mut output = vec![0; fragment.size_hint()];
            let mut iter = encoder.update(DisplayUpdate::DefaultPointer);
            let size = iter
                .encode_fragment(&mut fragment, &mut output)
                .unwrap()
                .unwrap();
            let mut cursor = ReadCursor::new(&output[..size]);
            let _: FastPathHeader = decode_cursor(&mut cursor).unwrap();
            let update: FastPathUpdatePdu<'_> = decode_cursor(&mut cursor).unwrap();
            let packet_flags = update.compression_flags.unwrap();
            assert_eq!(
                packet_flags.contains(CompressionFlags::FLUSHED),
                index == 0 || index == 2
            );
            assert_eq!(
                receiver
                    .decompress(update.data, u32::from(packet_flags.bits()) | 3)
                    .unwrap(),
                original
            );
        }
    }

    #[tokio::test]
    async fn a_disabled_compressor_returns_the_adaptive_encoder_to_remotefx() {
        let mut encoder = encoder();
        encoder.bulk.as_mut().unwrap().compressor = None;
        let mut fragment = UpdateFragmenter::new(UpdateCode::Bitmap, vec![1; 80]);
        let mut output = vec![0; fragment.size_hint()];
        let mut iter = encoder.update(DisplayUpdate::DefaultPointer);
        iter.encode_fragment(&mut fragment, &mut output).unwrap();
        drop(iter);
        assert!(matches!(
            encoder.bitmap_updater,
            Some(BitmapUpdater::RemoteFx(_))
        ));
        let bitmap = BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(256).unwrap(),
            height: NonZeroU16::new(128).unwrap(),
            format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
            data: vec![42; 256 * 128 * 4].into(),
            stride: NonZeroUsize::new(256 * 4).unwrap(),
        };
        assert_eq!(
            encoder.bitmap(bitmap).await.unwrap().code,
            UpdateCode::SurfaceCommands
        );
    }

    #[test]
    fn unaligned_ui_rectangles_use_planar_instead_of_remotefx() {
        let mut encoder = encoder();
        for width in [1, 2, 3, 253, 254, 255] {
            let bitmap = BitmapUpdate {
                x: 0,
                y: 0,
                width: NonZeroU16::new(width).unwrap(),
                height: NonZeroU16::new(128).unwrap(),
                format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
                data: vec![42; usize::from(width) * 128 * 4].into(),
                stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
            };
            let encoded = encoder
                .bitmap_updater
                .as_mut()
                .unwrap()
                .handle(&bitmap)
                .unwrap();
            assert_eq!(encoded.code, UpdateCode::Bitmap, "width={width}");
        }
    }

    #[test]
    fn peers_without_header_omission_get_pixel_scan_width_and_odd_width_remotefx() {
        let mut handler = AdaptiveHandler {
            bitmap: BitmapHandler::for_bulk_compression(false),
            rfx: RemoteFxHandler::new(
                EntropyBits::Rlgr3,
                3,
                DesktopSize {
                    width: 128,
                    height: 128,
                },
            ),
        };
        for width in [64u16, 65] {
            let bitmap = BitmapUpdate {
                x: 0,
                y: 0,
                width: NonZeroU16::new(width).unwrap(),
                height: NonZeroU16::new(128).unwrap(),
                format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
                data: vec![42; usize::from(width) * 128 * 4].into(),
                stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
            };
            let encoded = handler.handle(&bitmap).unwrap();
            if width == 64 {
                assert_eq!(encoded.code, UpdateCode::Bitmap);
                let bitmap: ironrdp_pdu::bitmap::BitmapUpdateData<'_> =
                    ironrdp_core::decode(&encoded.data).unwrap();
                for rectangle in bitmap.rectangles {
                    assert_eq!(rectangle.compressed_data_header.unwrap().scan_width, width);
                }
            } else {
                assert_eq!(encoded.code, UpdateCode::SurfaceCommands);
            }
        }
    }

    #[test]
    fn scanlines_larger_than_mstsc_bitmap_buffers_use_remotefx() {
        for omit_header in [false, true] {
            let (width, height) = (8192u16, 2u16);
            let bitmap = BitmapUpdate {
                x: 0,
                y: 0,
                width: NonZeroU16::new(width).unwrap(),
                height: NonZeroU16::new(height).unwrap(),
                format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
                data: vec![42; usize::from(width) * usize::from(height) * 4].into(),
                stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
            };
            let mut handler = AdaptiveHandler {
                bitmap: BitmapHandler::for_bulk_compression(omit_header),
                rfx: RemoteFxHandler::new(EntropyBits::Rlgr3, 3, DesktopSize { width, height }),
            };
            assert_eq!(
                handler.handle(&bitmap).unwrap().code,
                UpdateCode::SurfaceCommands
            );
        }
    }

    #[test]
    fn photo_after_a_plain_planar_prefix_uses_remotefx() {
        let (width, height) = (704u16, 384u16);
        let mut pixels = vec![48; usize::from(width) * usize::from(height) * 4];
        let mut seed = 0x9e3779b9u32;
        for y in 0..256usize {
            for x in 32..672usize {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let offset = (y * usize::from(width) + x) * 4;
                pixels[offset..offset + 4].copy_from_slice(&[
                    seed as u8,
                    (seed >> 8) as u8,
                    (seed >> 16) as u8,
                    255,
                ]);
            }
        }
        let bitmap = BitmapUpdate {
            x: 0,
            y: 0,
            width: NonZeroU16::new(width).unwrap(),
            height: NonZeroU16::new(height).unwrap(),
            format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
            data: pixels.into(),
            stride: NonZeroUsize::new(usize::from(width) * 4).unwrap(),
        };
        let mut handler = AdaptiveHandler {
            bitmap: BitmapHandler::for_bulk_compression(true),
            rfx: RemoteFxHandler::new(EntropyBits::Rlgr3, 3, DesktopSize { width, height }),
        };
        assert_eq!(
            handler.handle(&bitmap).unwrap().code,
            UpdateCode::SurfaceCommands
        );
    }

    #[test]
    #[ignore = "offline CPU timings; run with --release --ignored --nocapture"]
    fn profile_photo_encoder_costs() {
        use std::time::{Duration, Instant};
        for (width, height, cropped) in [
            (64u16, 64u16, false),
            (128, 64, false),
            (640, 360, false),
            (704, 384, true),
        ] {
            let stride = if cropped {
                1920 * 4
            } else {
                usize::from(width) * 4
            };
            let frames: Vec<_> = (0..16u32)
                .map(|frame| {
                    let mut seed = 0x9e3779b9u32.wrapping_mul(frame + 1);
                    let mut pixels =
                        vec![48; stride * (usize::from(height) - 1) + usize::from(width) * 4];
                    let (left, top) = if cropped { (32, 16) } else { (0, 0) };
                    for y in 0..usize::from(height.min(360)) {
                        for x in 0..usize::from(width.min(640)) {
                            seed ^= seed << 13;
                            seed ^= seed >> 17;
                            seed ^= seed << 5;
                            // The native photo target: panning gradient plus
                            // xorshift noise, correlated B/G/R colour planes.
                            let base = (x + (frame as usize * 3) % 640) * 180 / 640 + y * 60 / 360;
                            let value = (base as i32 + (seed & 31) as i32 - 16).clamp(0, 255) as u8;
                            let offset = (y + top) * stride + (x + left) * 4;
                            pixels[offset..offset + 4].copy_from_slice(&[
                                value,
                                value.wrapping_add(20),
                                value / 2,
                                255,
                            ]);
                        }
                    }
                    BitmapUpdate {
                        x: 0,
                        y: 0,
                        width: NonZeroU16::new(width).unwrap(),
                        height: NonZeroU16::new(height).unwrap(),
                        format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
                        data: pixels.into(),
                        stride: NonZeroUsize::new(stride).unwrap(),
                    }
                })
                .collect();
            let mut planar = BitmapHandler::for_bulk_compression(true);
            let mut planar_time = Duration::ZERO;
            let mut estimate_time = Duration::ZERO;
            let mut sample_time = Duration::ZERO;
            for bitmap in frames.iter().cycle().take(512) {
                let started = Instant::now();
                let (length, sample) = planar.bitmap.raw_planar_sample(bitmap).unwrap().unwrap();
                estimate_bulk_sample(length, &sample).unwrap();
                sample_time += started.elapsed();
                let started = Instant::now();
                let fragment = planar.handle(bitmap).unwrap();
                planar_time += started.elapsed();
                let started = Instant::now();
                estimate_bulk_size(&fragment.data).unwrap();
                estimate_time += started.elapsed();
            }
            eprintln!(
                "photo {width}x{height} cropped={cropped}: planar={:.3}ms/frame estimate={:.3}ms/frame lazy-sample={:.3}ms/frame",
                planar_time.as_secs_f64() * 1000.0 / 512.0,
                estimate_time.as_secs_f64() * 1000.0 / 512.0,
                sample_time.as_secs_f64() * 1000.0 / 512.0,
            );
            let mut rfx =
                RemoteFxHandler::new(EntropyBits::Rlgr3, 3, DesktopSize { width, height });
            let mut handler = AdaptiveHandler {
                bitmap: BitmapHandler::for_bulk_compression(true),
                rfx: rfx.clone(),
            };
            let mut bulk = bulk::BulkEncoder::new(CompressionType::Rdp61).unwrap();
            let mut encoded_time = [Duration::ZERO; 2];
            let mut send_time = [Duration::ZERO; 2];
            let mut bytes = [0; 2];
            let samples = 512;
            // Warm the Rayon pool and alternate order on each matched frame.
            // Separate baseline/candidate loops can mistake scheduler noise
            // or first-frame startup for the adaptive selection cost.
            for (index, bitmap) in frames.iter().cycle().take(samples + 32).enumerate() {
                let mut payloads = [Vec::new(), Vec::new()];
                for mode in [index % 2, (index + 1) % 2] {
                    let adaptive = mode == 1;
                    let started = Instant::now();
                    let mut fragment = if adaptive {
                        handler.handle(bitmap).unwrap()
                    } else {
                        rfx.handle(bitmap).unwrap()
                    };
                    assert_eq!(fragment.code, UpdateCode::SurfaceCommands);
                    if index >= 32 {
                        encoded_time[mode] += started.elapsed();
                    }
                    payloads[mode] = fragment.data.clone();
                    let started = Instant::now();
                    let mut output = vec![0; fragment.size_hint()];
                    while let Some(size) = fragment
                        .next(&mut output, adaptive.then_some(&mut bulk), None)
                        .unwrap()
                    {
                        if index >= 32 {
                            bytes[mode] += size;
                        }
                    }
                    if index >= 32 {
                        send_time[mode] += started.elapsed();
                    }
                }
                assert_eq!(payloads[0], payloads[1], "matched photo payload {index}");
            }
            for mode in 0..2 {
                eprintln!(
                    "photo {width}x{height} cropped={cropped} adaptive={}: encode={:.3}ms/frame bulk={:.3}ms/frame wire={}B/frame",
                    mode == 1,
                    encoded_time[mode].as_secs_f64() * 1000.0 / samples as f64,
                    send_time[mode].as_secs_f64() * 1000.0 / samples as f64,
                    bytes[mode] / samples
                );
            }
        }
    }
}
