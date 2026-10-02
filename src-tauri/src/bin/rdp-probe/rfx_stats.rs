//! What a server's RemoteFX surface commands look like on the wire: operating
//! mode, quantization tables, tiles and bytes per frame (MS-RDPBCGR 2.2.9.2,
//! MS-RDPRFX 2.2.2). Comparing them between Windows TermService and Taomni
//! explains bandwidth differences (design §4.7, TASK-11) without decoding
//! pixels a second time.
//!
//! Bulk history is independent of the active stage's receiver. Every fragment
//! is decompressed in stream order and reassembled before inspecting its codec.

use ironrdp::pdu::rdp::client_info::CompressionType;
use ironrdp_bulk::{BulkCompressor, CompressionType as BulkType, flags};
use std::collections::BTreeMap;

use serde_json::{Value, json};

/// Codec id the probe assigns to RemoteFX in its Bitmap Codecs capability.
pub(crate) const REMOTEFX_CODEC_ID: u8 = 3;

const FASTPATH_UPDATETYPE_SURFCMDS: u8 = 0x4;
const FASTPATH_FRAGMENT_SINGLE: u8 = 0;
const FASTPATH_FRAGMENT_FIRST: u8 = 2;
const FASTPATH_OUTPUT_COMPRESSION_USED: u8 = 0x2;
const FASTPATH_OUTPUT_ENCRYPTED: u8 = 0x2;
const CMDTYPE_SET_SURFACE_BITS: u16 = 0x0001;
const CMDTYPE_FRAME_MARKER: u16 = 0x0004;
const CMDTYPE_STREAM_SURFACE_BITS: u16 = 0x0006;
const EX_COMPRESSED_BITMAP_HEADER_PRESENT: u8 = 0x01;
const WBT_CONTEXT: u16 = 0xCCC3;
const WBT_EXTENSION: u16 = 0xCCC7;
const CBT_TILESET: u16 = 0xCAC2;

#[derive(Default)]
pub(crate) struct RfxStats {
    surface_bits: u64,
    codecs: BTreeMap<u8, u64>,
    rfx_bytes: u64,
    tile_sets: u64,
    tiles: u64,
    max_tiles: u64,
    /// "ll3,lh3,hl3,hh3,lh2,hl2,hh2,lh1,hl1,hh1" → tile sets using it.
    quants: BTreeMap<String, u64>,
    /// Context `flags` (0x02 = image mode, 0x00 = video mode) → contexts.
    modes: BTreeMap<u16, u64>,
    compressed_updates: u64,
    /// Fast-path update code → (updates, payload bytes of all fragments), so
    /// a server that answers with bitmap updates instead of RemoteFX shows.
    updates: BTreeMap<u8, (u64, u64)>,
    /// Bitmap update rectangles by "<bpp>bpp-<compression>".
    bitmaps: BTreeMap<String, BitmapRects>,
    decompressor: Option<BulkCompressor>,
    fragment: Option<(u8, Vec<u8>)>,
    bytes_on_wire: u64,
    bytes_decompressed: u64,
    decompression_errors: u64,
}

#[derive(Default)]
struct BitmapRects {
    rects: u64,
    pixels: u64,
    bytes: u64,
}

const FASTPATH_UPDATETYPE_BITMAP: u8 = 0x1;
const BITMAP_COMPRESSION: u16 = 0x0001;
const NO_BITMAP_COMPRESSION_HDR: u16 = 0x0400;

fn update_name(code: u8) -> String {
    match code {
        0x0 => "orders".into(),
        0x1 => "bitmap".into(),
        0x2 => "palette".into(),
        0x3 => "synchronize".into(),
        0x4 => "surface_commands".into(),
        0x5 => "pointer_hidden".into(),
        0x6 => "pointer_default".into(),
        0x8 => "pointer_position".into(),
        0x9 => "pointer_color".into(),
        0xA => "pointer_cached".into(),
        0xB => "pointer_new".into(),
        0xC => "pointer_large".into(),
        other => format!("code_{other:#x}"),
    }
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// The update list of a fast-path output PDU, or `None` for other PDUs.
fn fast_path_updates(pdu: &[u8]) -> Option<&[u8]> {
    let (&header, rest) = pdu.split_first()?;
    if header & 0x03 != 0 || (header >> 6) & FASTPATH_OUTPUT_ENCRYPTED != 0 {
        return None;
    }
    let (&length, rest) = rest.split_first()?;
    if length & 0x80 != 0 {
        rest.get(1..)
    } else {
        Some(rest)
    }
}

impl RfxStats {
    pub(crate) fn new(compression: Option<CompressionType>) -> Result<Self, String> {
        let mut stats = Self::default();
        stats.decompressor = compression
            .map(|kind| {
                BulkCompressor::new(match kind {
                    CompressionType::K8 => BulkType::Rdp4,
                    CompressionType::K64 => BulkType::Rdp5,
                    CompressionType::Rdp6 => BulkType::Rdp6,
                    CompressionType::Rdp61 => BulkType::Rdp61,
                })
            })
            .transpose()
            .map_err(|e| e.to_string())?;
        Ok(stats)
    }

    pub(crate) fn reset_counters(&mut self) {
        let decompressor = self.decompressor.take();
        let fragment = self.fragment.take();
        *self = Self::default();
        self.decompressor = decompressor;
        self.fragment = fragment;
    }

    pub(crate) fn reactivate(&mut self) {
        if let Some(decompressor) = self.decompressor.as_mut() {
            decompressor.reset();
        }
        self.fragment = None;
    }

    /// Inspect one fast-path output PDU as `read_pdu` returned it.
    pub(crate) fn inspect_fast_path(&mut self, pdu: &[u8]) {
        let Some(mut rest) = fast_path_updates(pdu) else {
            return;
        };
        while let Some((&header, tail)) = rest.split_first() {
            let code = header & 0x0F;
            let fragmentation = (header >> 4) & 0x03;
            let has_compression = (header >> 6) & FASTPATH_OUTPUT_COMPRESSION_USED != 0;
            let packet_flags = if has_compression {
                u32::from(*tail.first().unwrap_or(&0))
            } else {
                0
            };
            let tail = if has_compression {
                tail.get(1..).unwrap_or_default()
            } else {
                tail
            };
            let Some(size) = u16_at(tail, 0) else {
                return;
            };
            let body = &tail[2..];
            let size = usize::from(size);
            if size > body.len() {
                self.decompression_errors += 1;
                return;
            }
            let (data, next) = body.split_at(size);
            let entry = self.updates.entry(code).or_default();
            if matches!(
                fragmentation,
                FASTPATH_FRAGMENT_SINGLE | FASTPATH_FRAGMENT_FIRST
            ) {
                entry.0 += 1;
            }
            entry.1 += size as u64;
            self.bytes_on_wire += size as u64 + u64::from(has_compression);
            if packet_flags & flags::PACKET_COMPRESSED != 0 {
                self.compressed_updates += 1;
            }
            let decoded = if packet_flags
                & (flags::PACKET_COMPRESSED | flags::PACKET_AT_FRONT | flags::PACKET_FLUSHED)
                != 0
            {
                match self
                    .decompressor
                    .as_mut()
                    .map(|bulk| bulk.decompress(data, packet_flags))
                {
                    Some(Ok(decoded)) => decoded.to_vec(),
                    _ => {
                        self.decompression_errors += 1;
                        self.fragment = None;
                        rest = next;
                        continue;
                    }
                }
            } else {
                data.to_vec()
            };
            self.bytes_decompressed += decoded.len() as u64;
            self.inspect_fragment(code, fragmentation, decoded);
            rest = next;
        }
    }

    fn inspect_fragment(&mut self, code: u8, fragmentation: u8, data: Vec<u8>) {
        let complete = match fragmentation {
            FASTPATH_FRAGMENT_SINGLE => {
                self.fragment = None;
                Some(data)
            }
            FASTPATH_FRAGMENT_FIRST => {
                self.fragment = Some((code, data));
                None
            }
            1 | 3 => {
                let Some((previous, mut pending)) = self.fragment.take() else {
                    return;
                };
                if previous != code || pending.len() + data.len() > 8 * 1024 * 1024 {
                    self.decompression_errors += 1;
                    return;
                }
                pending.extend(data);
                if fragmentation == 1 {
                    Some(pending)
                } else {
                    self.fragment = Some((code, pending));
                    None
                }
            }
            _ => None,
        };
        if let Some(data) = complete {
            match code {
                FASTPATH_UPDATETYPE_BITMAP => self.bitmap_update(&data),
                FASTPATH_UPDATETYPE_SURFCMDS => self.surface_commands(&data),
                _ => {}
            }
        }
    }

    /// TS_UPDATE_BITMAP_DATA (MS-RDPBCGR 2.2.9.1.1.3.1.2): updateType,
    /// numberRectangles, then TS_BITMAP_DATA entries. Only rectangles fully
    /// inside this fragment are counted.
    fn bitmap_update(&mut self, data: &[u8]) {
        let Some(count) = u16_at(data, 2) else {
            return;
        };
        let mut at = 4;
        for _ in 0..count {
            // destLeft, destTop, destRight, destBottom, width, height, bpp,
            // flags, bitmapLength
            let (Some(width), Some(height), Some(bpp), Some(flags), Some(length)) = (
                u16_at(data, at + 8),
                u16_at(data, at + 10),
                u16_at(data, at + 12),
                u16_at(data, at + 14),
                u16_at(data, at + 16),
            ) else {
                return;
            };
            let compressed = flags & BITMAP_COMPRESSION != 0;
            let key = format!(
                "{bpp}bpp-{}",
                if compressed {
                    if flags & NO_BITMAP_COMPRESSION_HDR != 0 {
                        "compressed"
                    } else {
                        "compressed-hdr"
                    }
                } else {
                    "raw"
                }
            );
            let entry = self.bitmaps.entry(key).or_default();
            entry.rects += 1;
            entry.pixels += u64::from(width) * u64::from(height);
            entry.bytes += u64::from(length);
            at += 18 + usize::from(length);
            if at > data.len() {
                return;
            }
        }
    }

    fn surface_commands(&mut self, mut data: &[u8]) {
        while let Some(command) = u16_at(data, 0) {
            match command {
                // cmdType, frameAction, frameId
                CMDTYPE_FRAME_MARKER => data = data.get(8..).unwrap_or_default(),
                CMDTYPE_SET_SURFACE_BITS | CMDTYPE_STREAM_SURFACE_BITS => {
                    // cmdType, destination rectangle, then TS_BITMAP_DATA_EX:
                    // bpp, flags, reserved, codecID, width, height, length.
                    let (Some(&flags), Some(&codec), Some(length)) =
                        (data.get(11), data.get(13), u32_at(data, 18))
                    else {
                        return;
                    };
                    let skip = if flags & EX_COMPRESSED_BITMAP_HEADER_PRESENT != 0 {
                        46
                    } else {
                        22
                    };
                    let body = data.get(skip..).unwrap_or_default();
                    let length = usize::try_from(length).unwrap_or(usize::MAX);
                    self.surface_bits += 1;
                    *self.codecs.entry(codec).or_default() += 1;
                    if codec == REMOTEFX_CODEC_ID {
                        self.rfx_bytes += length as u64;
                        self.rfx_blocks(&body[..length.min(body.len())]);
                    }
                    if body.len() < length {
                        return; // the rest arrives in later fragments
                    }
                    data = &body[length..];
                }
                _ => return,
            }
        }
    }

    fn rfx_blocks(&mut self, mut data: &[u8]) {
        while let (Some(kind), Some(length)) = (u16_at(data, 0), u32_at(data, 2)) {
            let length = usize::try_from(length).unwrap_or(usize::MAX);
            if length < 6 {
                return;
            }
            let block = &data[..length.min(data.len())];
            match kind {
                // header, codecId, channelId, ctxId, tileSize, properties
                WBT_CONTEXT => {
                    if let Some(properties) = u16_at(block, 11) {
                        *self.modes.entry(properties & 0x7).or_default() += 1;
                    }
                }
                // header, codecId, channelId, subtype, idx, properties,
                // numQuant, tileSize, numTiles, tileDataSize, quantVals
                WBT_EXTENSION if u16_at(block, 8) == Some(CBT_TILESET) => {
                    self.tile_sets += 1;
                    let tiles = u64::from(u16_at(block, 16).unwrap_or(0));
                    self.tiles += tiles;
                    self.max_tiles = self.max_tiles.max(tiles);
                    let count = usize::from(block.get(14).copied().unwrap_or(0));
                    for quant in block
                        .get(22..22 + count * 5)
                        .unwrap_or_default()
                        .chunks_exact(5)
                    {
                        let values: Vec<String> = quant
                            .iter()
                            .flat_map(|byte| [byte & 0x0F, byte >> 4])
                            .map(|value| value.to_string())
                            .collect();
                        *self.quants.entry(values.join(",")).or_default() += 1;
                    }
                }
                _ => {}
            }
            if data.len() < length {
                return;
            }
            data = &data[length..];
        }
    }

    pub(crate) fn report(&self) -> Value {
        let per_set = |total: u64| {
            if self.tile_sets == 0 {
                Value::Null
            } else {
                json!((total as f64 / self.tile_sets as f64 * 10.0).round() / 10.0)
            }
        };
        json!({
            "surface_bits": self.surface_bits,
            "codecs": self.codecs.iter().map(|(id, n)| (id.to_string(), *n)).collect::<BTreeMap<_, _>>(),
            "tile_sets": self.tile_sets,
            "tiles": self.tiles,
            "tiles_per_set": per_set(self.tiles),
            "max_tiles_per_set": self.max_tiles,
            "bytes_per_set": per_set(self.rfx_bytes),
            "bytes_per_tile": if self.tiles == 0 { Value::Null } else { json!(self.rfx_bytes / self.tiles) },
            "quants": self.quants,
            "context_modes": self.modes.iter().map(|(mode, n)| (format!("{mode:#x}"), *n)).collect::<BTreeMap<_, _>>(),
            "updates": self
                .updates
                .iter()
                .map(|(code, (count, bytes))| (update_name(*code), json!({ "count": count, "bytes": bytes })))
                .collect::<BTreeMap<_, _>>(),
            "bitmaps": self
                .bitmaps
                .iter()
                .map(|(kind, r)| (kind.clone(), json!({
                    "rects": r.rects,
                    "pixels_per_rect": r.pixels / r.rects.max(1),
                    "bytes_per_rect": r.bytes / r.rects.max(1),
                    "bits_per_pixel_on_wire": if r.pixels == 0 { Value::Null } else { json!((r.bytes as f64 * 8.0 / r.pixels as f64 * 100.0).round() / 100.0) },
                })))
                .collect::<BTreeMap<_, _>>(),
            "compressed_updates": self.compressed_updates,
            "bulk": {
                "compressed_updates": self.compressed_updates,
                "bytes_on_wire": self.bytes_on_wire,
                "bytes_decompressed": self.bytes_decompressed,
                "bytes_before": self.bytes_decompressed,
                "bytes_after": self.bytes_on_wire,
                "decompression_errors": self.decompression_errors,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compressed_pdu(tx: &mut BulkCompressor, data: &[u8], fragment: u8) -> Vec<u8> {
        let (size, packet_flags) = tx.compress(data).unwrap();
        let wire = if packet_flags & flags::PACKET_COMPRESSED != 0 {
            tx.compressed_data(size)
        } else {
            data
        };
        wire_pdu(wire, packet_flags, fragment)
    }

    fn wire_pdu(wire: &[u8], packet_flags: u32, fragment: u8) -> Vec<u8> {
        let mut body = vec![
            FASTPATH_UPDATETYPE_BITMAP | (fragment << 4) | 0x80,
            packet_flags as u8,
        ];
        body.extend_from_slice(&(wire.len() as u16).to_le_bytes());
        body.extend_from_slice(wire);
        let total = 3 + body.len();
        let mut pdu = vec![0, 0x80 | (total >> 8) as u8, total as u8];
        pdu.extend(body);
        pdu
    }

    #[test]
    fn uncompressed_at_front_moves_history_before_the_next_back_reference() {
        let mut stats = RfxStats::new(Some(CompressionType::K64)).unwrap();
        // MPPC literals put ABC at the beginning of the 64K history.
        stats.inspect_fast_path(&wire_pdu(
            b"ABC",
            1 | flags::PACKET_COMPRESSED | flags::PACKET_AT_FRONT,
            0,
        ));
        stats.inspect_fast_path(&wire_pdu(b"raw", 1 | flags::PACKET_AT_FRONT, 0));
        // MPPC offset 1, length 3: 11111 000001 0, then byte padding.
        // After AT_FRONT this wraps to the zeroed end of history. Ignoring the
        // control packet instead yields CCC from the previous write position.
        let decoded = stats
            .decompressor
            .as_mut()
            .unwrap()
            .decompress(&[0xF8, 0x20], 1 | flags::PACKET_COMPRESSED)
            .unwrap();
        assert_eq!(decoded, &[0, 0, 0]);
        assert_eq!(stats.report()["bulk"]["decompression_errors"], 0);
    }

    #[test]
    fn compressed_bitmap_fragments_are_reassembled_and_measurement_keeps_history() {
        let mut data = vec![1, 0, 1, 0];
        for value in [
            0u16,
            0,
            63,
            31,
            64,
            32,
            32,
            BITMAP_COMPRESSION | NO_BITMAP_COMPRESSION_HDR,
            1000,
        ] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.extend_from_slice(&vec![42; 1000]);
        for (kind, compression) in [
            (BulkType::Rdp5, CompressionType::K64),
            (BulkType::Rdp61, CompressionType::Rdp61),
        ] {
            let mut sender = BulkCompressor::new(kind).unwrap();
            let mut stats = RfxStats::new(Some(compression)).unwrap();
            for round in 0..3 {
                stats.inspect_fast_path(&compressed_pdu(&mut sender, &data[..400], 2));
                stats.inspect_fast_path(&compressed_pdu(&mut sender, &data[400..], 1));
                let report = stats.report();
                assert_eq!(
                    report["bitmaps"]["32bpp-compressed"]["rects"], 1,
                    "round {round}"
                );
                assert_eq!(report["bulk"]["bytes_decompressed"], data.len());
                assert_eq!(report["bulk"]["decompression_errors"], 0);
                assert!(report["bulk"]["bytes_on_wire"].as_u64().unwrap() < data.len() as u64);
                stats.reset_counters();
            }
        }
    }

    /// A fast-path PDU with one surface-bits command carrying a RemoteFX
    /// context and a tile set of `tiles` tiles quantised with `quant`.
    fn pdu(quant: [u8; 10], tiles: u16) -> Vec<u8> {
        let mut rfx = Vec::new();
        // WBT_CONTEXT: header, codecId, channelId, ctxId, tileSize, properties
        rfx.extend_from_slice(&WBT_CONTEXT.to_le_bytes());
        rfx.extend_from_slice(&13u32.to_le_bytes());
        rfx.extend_from_slice(&[1, 0xFF, 0]);
        rfx.extend_from_slice(&64u16.to_le_bytes());
        rfx.extend_from_slice(&0x0002u16.to_le_bytes());
        // WBT_EXTENSION / CBT_TILESET with one quant table and no tile data
        let mut set = Vec::new();
        set.extend_from_slice(&[1, 0]);
        set.extend_from_slice(&CBT_TILESET.to_le_bytes());
        set.extend_from_slice(&0u16.to_le_bytes());
        set.extend_from_slice(&0u16.to_le_bytes());
        set.extend_from_slice(&[1, 0x40]);
        set.extend_from_slice(&tiles.to_le_bytes());
        set.extend_from_slice(&0u32.to_le_bytes());
        for pair in quant.chunks_exact(2) {
            set.push(pair[0] | (pair[1] << 4));
        }
        rfx.extend_from_slice(&WBT_EXTENSION.to_le_bytes());
        rfx.extend_from_slice(&(6 + set.len() as u32).to_le_bytes());
        rfx.extend_from_slice(&set);

        let mut command = Vec::new();
        command.extend_from_slice(&CMDTYPE_SET_SURFACE_BITS.to_le_bytes());
        command.extend_from_slice(&[0; 8]);
        command.extend_from_slice(&[32, 0, 0, REMOTEFX_CODEC_ID]);
        command.extend_from_slice(&64u16.to_le_bytes());
        command.extend_from_slice(&64u16.to_le_bytes());
        command.extend_from_slice(&(rfx.len() as u32).to_le_bytes());
        command.extend_from_slice(&rfx);

        let mut update = vec![FASTPATH_UPDATETYPE_SURFCMDS];
        update.extend_from_slice(&(command.len() as u16).to_le_bytes());
        update.extend_from_slice(&command);
        let total = 3 + update.len();
        let mut pdu = vec![0x00, 0x80 | (total >> 8) as u8, total as u8];
        pdu.extend_from_slice(&update);
        pdu
    }

    #[test]
    fn records_mode_quant_and_tiles_of_remotefx_surface_bits() {
        let mut stats = RfxStats::default();
        stats.inspect_fast_path(&pdu([6, 6, 6, 6, 7, 7, 8, 8, 8, 9], 60));
        stats.inspect_fast_path(&pdu([8, 8, 8, 8, 9, 9, 10, 10, 10, 11], 20));
        let report = stats.report();
        assert_eq!(report["surface_bits"], 2);
        assert_eq!(report["tile_sets"], 2);
        assert_eq!(report["tiles"], 80);
        assert_eq!(report["max_tiles_per_set"], 60);
        assert_eq!(report["quants"]["6,6,6,6,7,7,8,8,8,9"], 1);
        assert_eq!(report["quants"]["8,8,8,8,9,9,10,10,10,11"], 1);
        assert_eq!(report["context_modes"]["0x2"], 2);
        assert_eq!(report["updates"]["surface_commands"]["count"], 2);
    }

    #[test]
    fn records_bitmap_update_depth_and_compression() {
        // One 64x32 32 bpp compressed rectangle with 100 bytes of data.
        let mut update = Vec::new();
        update.extend_from_slice(&1u16.to_le_bytes()); // updateType
        update.extend_from_slice(&1u16.to_le_bytes()); // numberRectangles
        for value in [
            0u16,
            0,
            63,
            31,
            64,
            32,
            32,
            BITMAP_COMPRESSION | NO_BITMAP_COMPRESSION_HDR,
            100,
        ] {
            update.extend_from_slice(&value.to_le_bytes());
        }
        update.extend_from_slice(&[0u8; 100]);
        let mut body = vec![FASTPATH_UPDATETYPE_BITMAP];
        body.extend_from_slice(&(update.len() as u16).to_le_bytes());
        body.extend_from_slice(&update);
        let total = 3 + body.len();
        let mut pdu = vec![0x00, 0x80 | (total >> 8) as u8, total as u8];
        pdu.extend_from_slice(&body);

        let mut stats = RfxStats::default();
        stats.inspect_fast_path(&pdu);
        let report = stats.report();
        let bitmaps = &report["bitmaps"]["32bpp-compressed"];
        assert_eq!(bitmaps["rects"], 1);
        assert_eq!(bitmaps["pixels_per_rect"], 64 * 32);
        assert_eq!(bitmaps["bytes_per_rect"], 100);
    }

    #[test]
    fn ignores_slow_path_and_compressed_updates() {
        let mut stats = RfxStats::default();
        stats.inspect_fast_path(&[0x03, 0x00, 0x00, 0x10]);
        let mut compressed = pdu([6; 10], 1);
        compressed[3] |= FASTPATH_OUTPUT_COMPRESSION_USED << 6;
        compressed.insert(4, 0x23);
        stats.inspect_fast_path(&compressed);
        let report = stats.report();
        assert_eq!(report["surface_bits"], 0);
        assert_eq!(report["compressed_updates"], 1);
    }
}
