use core::cmp::min;

use ironrdp_graphics::color_conversion::{self, YCbCrBuffer};
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::rectangle_processing::Region;
use ironrdp_graphics::{dwt, quantization, rlgr, subband_reconstruction};
use ironrdp_pdu::codecs::rfx::{self, EntropyAlgorithm, Quant, RfxRectangle, Tile};
use ironrdp_pdu::geometry::{InclusiveRectangle, Rectangle as _};
use ironrdp_pdu::{Decode as _, ReadCursor, decode_cursor};
use tracing::{instrument, trace};

use crate::image::DecodedImage;
use crate::{SessionResult, custom_err, general_err, reason_err};

const TILE_SIZE: u16 = 64;

pub type FrameId = u32;

pub struct DecodingContext {
    context: rfx::ContextPdu,
    channels: rfx::ChannelsPdu,
    decoding_tiles: DecodingTileContext,
}

impl Default for DecodingContext {
    fn default() -> Self {
        Self {
            context: rfx::ContextPdu {
                flags: rfx::OperatingMode::empty(),
                entropy_algorithm: EntropyAlgorithm::Rlgr1,
            },
            channels: rfx::ChannelsPdu(Vec::new()),
            decoding_tiles: DecodingTileContext::new(),
        }
    }
}

impl DecodingContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn decode(
        &mut self,
        image: &mut DecodedImage,
        destination: &InclusiveRectangle,
        input: &mut ReadCursor<'_>,
    ) -> SessionResult<(FrameId, InclusiveRectangle)> {
        loop {
            let block = rfx::Block::decode(input).map_err(|e| custom_err!("decode block", e))?;

            match block {
                rfx::Block::Sync(_) => {
                    self.process_sync(input)?;
                }
                rfx::Block::CodecChannel(rfx::CodecChannel::FrameBegin(f)) => {
                    return self.process_frame(f, input, image, destination);
                }
                _ => {
                    return Err(reason_err!(
                        "rfx::DecodingContext",
                        "unexpected RFX block type: {:?}",
                        block.block_type()
                    ));
                }
            }
        }
    }

    fn process_sync(&mut self, input: &mut ReadCursor<'_>) -> SessionResult<()> {
        self.process_headers(input)
    }

    fn process_headers(&mut self, input: &mut ReadCursor<'_>) -> SessionResult<()> {
        let mut context = None;
        let mut channels = None;

        // headers can appear in any order: CodecVersions, Channels, Context
        for _ in 0..3 {
            match decode_cursor(input).map_err(|e| custom_err!("decode headers", e))? {
                rfx::Block::CodecChannel(rfx::CodecChannel::Context(c)) => context = Some(c),
                rfx::Block::Channels(c) => channels = Some(c),
                rfx::Block::CodecVersions(_) => (),
                _ => {
                    return Err(general_err!("unexpected RFX block type"));
                }
            }
        }

        let context = context.ok_or_else(|| general_err!("context header is missing"))?;
        let channels = channels.ok_or_else(|| general_err!("channels header is missing"))?;

        if channels.0.is_empty() {
            return Err(general_err!("no RFX channel announced"));
        }

        self.context = context;
        self.channels = channels;

        Ok(())
    }

    #[instrument(skip_all)]
    fn process_frame(
        &mut self,
        frame_begin: rfx::FrameBeginPdu,
        input: &mut ReadCursor<'_>,
        image: &mut DecodedImage,
        destination: &InclusiveRectangle,
    ) -> SessionResult<(FrameId, InclusiveRectangle)> {
        let channel = self
            .channels
            .0
            .first()
            .ok_or_else(|| general_err!("no RFX channel found"))?;
        let width = channel
            .width
            .try_into()
            .map_err(|_| general_err!("invalid width"))?;
        let height = channel
            .height
            .try_into()
            .map_err(|_| general_err!("invalid height"))?;
        let entropy_algorithm = self.context.entropy_algorithm;

        let region: rfx::Block<'_> =
            decode_cursor(input).map_err(|e| custom_err!("decode region", e))?;
        let mut region = match region {
            rfx::Block::CodecChannel(rfx::CodecChannel::Region(region)) => region,
            _ => return Err(general_err!("unexpected block type")),
        };
        let tile_set: rfx::Block<'_> =
            decode_cursor(input).map_err(|e| custom_err!("decode tile_set", e))?;
        let tile_set = match tile_set {
            rfx::Block::CodecChannel(rfx::CodecChannel::TileSet(t)) => t,
            _ => return Err(general_err!("unexpected block type")),
        };
        let frame_end: rfx::Block<'_> =
            decode_cursor(input).map_err(|e| custom_err!("decode frame_end", e))?;
        if !matches!(
            frame_end,
            rfx::Block::CodecChannel(rfx::CodecChannel::FrameEnd(_))
        ) {
            return Err(general_err!("unexpected block type"));
        }

        if region.rectangles.is_empty() {
            region.rectangles = vec![RfxRectangle {
                x: 0,
                y: 0,
                width,
                height,
            }];
        }
        let region = region;

        trace!(frame_index = frame_begin.index);
        trace!(destination_rectangle = ?destination);
        trace!(context = ?self.context);
        trace!(channels = ?self.channels);
        trace!(?region);

        // A peer may describe its 64-pixel-aligned capture buffer, which can
        // extend past the surface and the newly negotiated desktop. Clip the
        // region before applying tiles; otherwise DecodedImage rejects every
        // tile because the region's overall extents exceed its bounds.
        let clipping_rectangles =
            clipping_rectangles(region.rectangles.as_slice(), destination, width, height)
                .intersect_rectangle(destination)
                .intersect_rectangle(&InclusiveRectangle {
                    left: 0,
                    top: 0,
                    right: image.width().saturating_sub(1),
                    bottom: image.height().saturating_sub(1),
                });
        trace!("Clipping rectangles: {:?}", clipping_rectangles);

        let mut final_update_rectangle = clipping_rectangles.extents.clone();

        for (update_rectangle, tile_data) in
            tiles_to_rectangles(tile_set.tiles.as_slice(), destination).zip(map_tiles_data(
                tile_set.tiles.as_slice(),
                tile_set.quants.as_slice(),
            ))
        {
            decode_tile(
                &tile_data,
                entropy_algorithm,
                self.decoding_tiles.tile_output.as_mut(),
                self.decoding_tiles.ycbcr_buffer.as_mut(),
                self.decoding_tiles.ycbcr_temp_buffer.as_mut(),
            )?;

            let current_update_rectangle = image.apply_tile(
                &self.decoding_tiles.tile_output,
                PixelFormat::RgbA32,
                &clipping_rectangles,
                &update_rectangle,
            )?;

            final_update_rectangle = final_update_rectangle.union(&current_update_rectangle);
        }

        Ok((frame_begin.index, final_update_rectangle))
    }
}

#[derive(Debug, Clone)]
struct DecodingTileContext {
    tile_output: Vec<u8>,
    ycbcr_buffer: Vec<Vec<i16>>,
    ycbcr_temp_buffer: Vec<i16>,
}

impl DecodingTileContext {
    fn new() -> Self {
        let tile_size = usize::from(TILE_SIZE);
        Self {
            tile_output: vec![0; tile_size * tile_size * 4],
            ycbcr_buffer: vec![vec![0; tile_size * tile_size]; 3],
            ycbcr_temp_buffer: vec![0; tile_size * tile_size],
        }
    }
}

fn decode_tile(
    tile: &TileData<'_>,
    entropy_algorithm: EntropyAlgorithm,
    output: &mut [u8],
    ycbcr_temp: &mut [Vec<i16>],
    temp: &mut [i16],
) -> SessionResult<()> {
    for ((quant, data), ycbcr_buffer) in tile
        .quants
        .iter()
        .zip(tile.data.iter())
        .zip(ycbcr_temp.iter_mut())
    {
        decode_component(
            quant,
            entropy_algorithm,
            data,
            ycbcr_buffer.as_mut_slice(),
            temp,
        )?;
    }

    let ycbcr_buffer = YCbCrBuffer {
        y: ycbcr_temp[0].as_slice(),
        cb: ycbcr_temp[1].as_slice(),
        cr: ycbcr_temp[2].as_slice(),
    };

    color_conversion::ycbcr_to_rgba(ycbcr_buffer, output)
        .map_err(|e| custom_err!("decode_tile", e))?;

    Ok(())
}

fn decode_component(
    quant: &Quant,
    entropy_algorithm: EntropyAlgorithm,
    data: &[u8],
    output: &mut [i16],
    temp: &mut [i16],
) -> SessionResult<()> {
    rlgr::decode(entropy_algorithm, data, output)
        .map_err(|e| custom_err!("decode_component", e))?;
    subband_reconstruction::decode(&mut output[4032..]);
    quantization::decode(output, quant);
    dwt::decode(output, temp);

    Ok(())
}

fn clipping_rectangles(
    rectangles: &[RfxRectangle],
    destination: &InclusiveRectangle,
    width: u16,
    height: u16,
) -> Region {
    let mut clipping_rectangles = Region::new();

    rectangles
        .iter()
        .map(|r| InclusiveRectangle {
            left: min(destination.left + r.x, width - 1),
            top: min(destination.top + r.y, height - 1),
            right: min(destination.left + r.x + r.width - 1, width - 1),
            bottom: min(destination.top + r.y + r.height - 1, height - 1),
        })
        .for_each(|r| clipping_rectangles.union_rectangle(r));

    clipping_rectangles
}

fn tiles_to_rectangles<'a>(
    tiles: &'a [Tile<'_>],
    destination: &'a InclusiveRectangle,
) -> impl Iterator<Item = InclusiveRectangle> + 'a {
    tiles.iter().map(|t| InclusiveRectangle {
        left: destination.left + t.x * TILE_SIZE,
        top: destination.top + t.y * TILE_SIZE,
        right: destination.left + t.x * TILE_SIZE + TILE_SIZE - 1,
        bottom: destination.top + t.y * TILE_SIZE + TILE_SIZE - 1,
    })
}

fn map_tiles_data<'a>(tiles: &[Tile<'a>], quants: &[Quant]) -> Vec<TileData<'a>> {
    tiles
        .iter()
        .map(|t| TileData {
            quants: [
                quants[usize::from(t.y_quant_index)].clone(),
                quants[usize::from(t.cb_quant_index)].clone(),
                quants[usize::from(t.cr_quant_index)].clone(),
            ],
            data: [t.y_data, t.cb_data, t.cr_data],
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_core::encode_vec;

    #[test]
    fn padded_remote_fx_frame_paints_pixels_after_desktop_resize() {
        let mut encoded_component = vec![0; 4096];
        let length =
            rlgr::encode(EntropyAlgorithm::Rlgr1, &[0; 4096], &mut encoded_component).unwrap();
        encoded_component.truncate(length);
        let blocks = [
            rfx::Block::Sync(rfx::SyncPdu),
            rfx::Block::CodecVersions(rfx::CodecVersionsPdu),
            rfx::Block::Channels(rfx::ChannelsPdu(vec![rfx::RfxChannel {
                width: 1536,
                height: 1088,
            }])),
            rfx::Block::CodecChannel(rfx::CodecChannel::Context(rfx::ContextPdu {
                flags: rfx::OperatingMode::IMAGE_MODE,
                entropy_algorithm: EntropyAlgorithm::Rlgr1,
            })),
            rfx::Block::CodecChannel(rfx::CodecChannel::FrameBegin(rfx::FrameBeginPdu {
                index: 1,
                number_of_regions: 1,
            })),
            rfx::Block::CodecChannel(rfx::CodecChannel::Region(rfx::RegionPdu {
                rectangles: vec![RfxRectangle {
                    x: 0,
                    y: 0,
                    width: 1536,
                    height: 1088,
                }],
            })),
            rfx::Block::CodecChannel(rfx::CodecChannel::TileSet(rfx::TileSetPdu {
                entropy_algorithm: EntropyAlgorithm::Rlgr1,
                quants: vec![Quant::default()],
                tiles: vec![Tile {
                    y_quant_index: 0,
                    cb_quant_index: 0,
                    cr_quant_index: 0,
                    x: 4,
                    y: 3,
                    y_data: &encoded_component,
                    cb_data: &encoded_component,
                    cr_data: &encoded_component,
                }],
            })),
            rfx::Block::CodecChannel(rfx::CodecChannel::FrameEnd(rfx::FrameEndPdu)),
        ];
        let encoded: Vec<u8> = blocks
            .iter()
            .flat_map(|block| encode_vec(block).unwrap())
            .collect();
        let mut image = DecodedImage::new(PixelFormat::RgbA32, 1492, 1030);
        let (_, updated) = DecodingContext::new()
            .decode(
                &mut image,
                &InclusiveRectangle {
                    left: 0,
                    top: 0,
                    right: 1491,
                    bottom: 1029,
                },
                &mut ReadCursor::new(&encoded),
            )
            .unwrap();
        let offset = (240 * 1492 + 280) * 4;
        assert_eq!(&image.data()[offset..offset + 4], &[128, 128, 128, 255]);
        assert!(updated.right < image.width() && updated.bottom < image.height());
    }
}

struct TileData<'a> {
    quants: [Quant; 3],
    data: [&'a [u8]; 3],
}
