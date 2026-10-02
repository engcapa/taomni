//! Offline encoder comparison for TASK-11 (design:
//! docs-feature/rdp-server-parity/encoder-adaptive-design.md, budget M4 4905 kbps).
//!
//! Reproduces the TC-RDPS-PERF-01 animation (rdp_target.py "animate": 640x360
//! window at desktop (40,80), white bars 26 px wide every 52 px moving 4 px per
//! frame, a 32x32 grey marker cycling 16 levels) on a 1024x768 desktop, runs
//! the server's pipeline steps (64x64 tile diff against the previous frame,
//! rectangle merge like `find_different_rects`, per-update encode) and prints
//! wire bytes per frame for each candidate at the measured 32 fps. A second
//! scene (noisy panning gradient) stands in for photo/video content. Bulk
//! results are verified with a decompress round trip.
//!
//! Run: `cargo run --release` in this directory (EXP-01..EXP-06 in the design).

use std::time::Instant;

use ironrdp_bulk::{BulkCompressor, CompressionType};
use ironrdp_graphics::color_conversion::to_64x64_ycbcr_tile;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_graphics::rdp6::{BgrAChannels, BitmapStreamEncoder};
use ironrdp_graphics::rfx_encode_component;
use ironrdp_pdu::codecs::rfx::{EntropyAlgorithm, Quant};

const DW: usize = 1024;
const DH: usize = 768;
const WX: usize = 40;
const WY: usize = 80;
const WW: usize = 640;
const WH: usize = 360;
const FPS: f64 = 32.0;
const BUDGET_KBPS: f64 = 4905.0;
/// The server's fast-path fragment payload limit (encoder/fast_path.rs).
const FRAGMENT: usize = 16_374;
const PACKET_COMPRESSED: u32 = 0x20;

/// Desktop BGRA for animation frame `k`; grey background outside the window.
fn desktop(k: usize) -> Vec<u8> {
    let mut d = vec![0u8; DW * DH * 4];
    for px in d.chunks_exact_mut(4) {
        px.copy_from_slice(&[0x30, 0x30, 0x30, 0xFF]);
    }
    let bar_w = (WW / 24).max(8); // 26, as rdp_target.py
    let period = bar_w * 2;
    let offset = (k * 4) % period;
    let marker = ((k % 16) * 16 + 8) as u8;
    for y in 0..WH {
        for x in 0..WW {
            let white = ((x + period - offset) % period) < bar_w;
            let v = if x < 32 && y < 32 {
                marker
            } else if white {
                255
            } else {
                0
            };
            let i = ((WY + y) * DW + WX + x) * 4;
            d[i..i + 4].copy_from_slice(&[v, v, v, 0xFF]);
        }
    }
    d
}

/// Deterministic noisy panning gradient in the window (photo/video stand-in:
/// worst case for planar/bulk, best case for RemoteFX).
fn photo_desktop(k: usize) -> Vec<u8> {
    let mut d = desktop(0);
    let mut seed = 0x9E37_79B9u32.wrapping_mul(k as u32 + 1);
    for y in 0..WH {
        for x in 0..WW {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let base =
                ((x + k * 3) as f32 / WW as f32 * 180.0 + (y as f32 / WH as f32) * 60.0) as i32;
            let noise = (seed & 0x1F) as i32 - 16;
            let v = (base + noise).clamp(0, 255) as u8;
            let i = ((WY + y) * DW + WX + x) * 4;
            d[i..i + 4].copy_from_slice(&[v, v.wrapping_add(20), v / 2, 0xFF]);
        }
    }
    d
}

#[derive(Clone, Copy)]
struct Rect {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
}

/// 64x64 tiles that differ between two desktops (the server's diff step).
fn changed_tiles(prev: &[u8], cur: &[u8]) -> Vec<Rect> {
    let mut out = Vec::new();
    for ty in 0..DH.div_ceil(64) {
        for tx in 0..DW.div_ceil(64) {
            let (x, y) = (tx * 64, ty * 64);
            let (w, h) = ((DW - x).min(64), (DH - y).min(64));
            let differs = (y..y + h).any(|row| {
                let a = (row * DW + x) * 4;
                prev[a..a + w * 4] != cur[a..a + w * 4]
            });
            if differs {
                out.push(Rect { x, y, w, h });
            }
        }
    }
    out
}

/// Merge changed tiles into rectangles like ironrdp-graphics
/// `find_different_rects`: expand right, then down while the span differs.
fn merged(tiles: &[Rect]) -> Vec<Rect> {
    let cols = DW.div_ceil(64);
    let rows = DH.div_ceil(64);
    let mut grid = vec![false; cols * rows];
    for t in tiles {
        grid[(t.y / 64) * cols + t.x / 64] = true;
    }
    let mut out = Vec::new();
    for ty in 0..rows {
        for tx in 0..cols {
            if !grid[ty * cols + tx] {
                continue;
            }
            let mut w = 1;
            while tx + w < cols && grid[ty * cols + tx + w] {
                w += 1;
            }
            let mut h = 1;
            while ty + h < rows && (0..w).all(|i| grid[(ty + h) * cols + tx + i]) {
                h += 1;
            }
            for yy in 0..h {
                for xx in 0..w {
                    grid[(ty + yy) * cols + tx + xx] = false;
                }
            }
            let (x, y) = (tx * 64, ty * 64);
            out.push(Rect {
                x,
                y,
                w: (w * 64).min(DW - x),
                h: (h * 64).min(DH - y),
            });
        }
    }
    out
}

fn crop(d: &[u8], r: Rect) -> Vec<u8> {
    let mut out = Vec::with_capacity(r.w * r.h * 4);
    for row in r.y..r.y + r.h {
        let a = (row * DW + r.x) * 4;
        out.extend_from_slice(&d[a..a + r.w * 4]);
    }
    out
}

fn quant(v: [u8; 10]) -> Quant {
    Quant {
        ll3: v[0],
        lh3: v[1],
        hl3: v[2],
        hh3: v[3],
        lh2: v[4],
        hl2: v[5],
        hh2: v[6],
        lh1: v[7],
        hl1: v[8],
        hh1: v[9],
    }
}

/// The quant table the vendored server always uses (`Quant::default()`).
fn default_quant() -> Quant {
    quant([6, 6, 6, 6, 7, 7, 8, 8, 8, 9])
}

/// RemoteFX bytes for one rectangle (64x64 tiles, RLGR3, given quant).
fn rfx(pixels: &[u8], w: usize, h: usize, q: &Quant) -> usize {
    let mut out = vec![0u8; 4096 * 2];
    let mut total = 0;
    for ty in 0..h.div_ceil(64) {
        for tx in 0..w.div_ceil(64) {
            let (x, y) = (tx * 64, ty * 64);
            let (tw, th) = ((w - x).min(64) as u32, (h - y).min(64) as u32);
            let (mut yy, mut cb, mut cr) = ([0i16; 4096], [0i16; 4096], [0i16; 4096]);
            to_64x64_ycbcr_tile(
                &pixels[(y * w + x) * 4..],
                tw,
                th,
                (w * 4) as u32,
                PixelFormat::BgrA32,
                &mut yy,
                &mut cb,
                &mut cr,
            )
            .unwrap();
            for plane in [&mut yy, &mut cb, &mut cr] {
                total += rfx_encode_component(
                    plane.as_mut_slice(),
                    &mut out,
                    q,
                    EntropyAlgorithm::Rlgr3,
                )
                .unwrap();
            }
            total += 19; // TS_RFX_TILE header
        }
    }
    total + 60 // frame begin/region/tileset/end blocks + surface bits header
}

/// RDP 6.0 planar bitmap stream bytes for one rectangle, split into
/// TS_BITMAP_DATA chunks of at most 64 KiB raw like `BitmapEncoder`
/// (26 bytes of TS_BITMAP_DATA header per chunk).
fn planar_bytes(pixels: &[u8], w: usize, h: usize) -> Vec<u8> {
    planar_bytes_layout(pixels, w, h, true)
}

fn planar_bytes_layout(pixels: &[u8], w: usize, h: usize, header_first: bool) -> Vec<u8> {
    let row = w * 4;
    let chunk_rows = (65535 / row).max(1);
    let mut all = Vec::new();
    let mut out = vec![0u8; 1 << 20];
    let mut y = 0;
    while y < h {
        let rows = chunk_rows.min(h - y);
        let mut enc = BitmapStreamEncoder::new(w, rows);
        let src = pixels[y * row..(y + rows) * row]
            .chunks(row)
            .rev()
            .flat_map(|r| r.chunks(4));
        let n = enc
            .encode_pixels_stream::<_, BgrAChannels>(src, &mut out, true)
            .unwrap();
        if header_first {
            all.extend_from_slice(&[0u8; 26]);
        }
        all.extend_from_slice(&out[..n]);
        if !header_first {
            all.extend_from_slice(&[0u8; 26]);
        }
        y += rows;
    }
    all
}

fn zstd(bytes: &[u8], level: i32) -> usize {
    let mut out = vec![0u8; zstd_safe::compress_bound(bytes.len())];
    zstd_safe::compress(&mut out[..], bytes, level).unwrap() + 30
}

/// Bulk-compress an update payload fragment by fragment with session history,
/// decompressing each fragment on a receiver and requiring the original bytes
/// back. Returns the bytes on the wire (+1 compression-flags byte).
fn bulk_send(
    tx: &mut BulkCompressor,
    rx: &mut BulkCompressor,
    payload: &[u8],
    fragment: usize,
) -> usize {
    let mut total = 0;
    for chunk in payload.chunks(fragment) {
        let (size, flags) = tx.compress(chunk).expect("compress");
        if flags & PACKET_COMPRESSED != 0 && size < chunk.len() {
            let data = tx.compressed_data(size).to_vec();
            let back = rx.decompress(&data, flags).expect("decompress");
            assert_eq!(back, chunk, "bulk round trip");
            total += size + 1;
        } else {
            // Sent uncompressed; a FLUSHED flag must still reach the receiver.
            let back = rx.decompress(chunk, flags).expect("decompress raw");
            assert_eq!(back, chunk, "bulk raw round trip");
            total += chunk.len() + 1;
        }
    }
    total
}

struct Row {
    name: &'static str,
    lossless: bool,
    bytes_per_frame: f64,
    ms_per_frame: f64,
}

fn print_rows(title: &str, rows: &[Row]) {
    println!("\n{title}");
    println!(
        "{:<52} {:>9} {:>8} {:>7} {:>7}  lossless",
        "strategy", "B/frame", "kbps", "budget", "ms/fr"
    );
    for r in rows {
        let kbps = r.bytes_per_frame * 8.0 * FPS / 1000.0;
        println!(
            "{:<52} {:>9.0} {:>8.0} {:>6.0}% {:>7.2}  {}",
            r.name,
            r.bytes_per_frame,
            kbps,
            kbps / BUDGET_KBPS * 100.0,
            r.ms_per_frame,
            if r.lossless { "yes" } else { "no" }
        );
    }
}

type Encoder = Box<dyn FnMut(&[u8], &[u8]) -> usize>;

fn run(frames: &[Vec<u8>], strategies: Vec<(&'static str, bool, Encoder)>) -> Vec<Row> {
    strategies
        .into_iter()
        .map(|(name, lossless, mut encode)| {
            let started = Instant::now();
            let total: usize = frames.windows(2).map(|w| encode(&w[0], &w[1])).sum();
            let n = (frames.len() - 1) as f64;
            Row {
                name,
                lossless,
                bytes_per_frame: total as f64 / n,
                ms_per_frame: started.elapsed().as_secs_f64() * 1000.0 / n,
            }
        })
        .collect()
}

fn strategies(fragment: usize, historical: bool) -> Vec<(&'static str, bool, Encoder)> {
    let bulk = |kind: CompressionType| {
        let mut tx = BulkCompressor::new(kind).unwrap();
        let mut rx = BulkCompressor::new(kind).unwrap();
        Box::new(move |p: &[u8], c: &[u8]| {
            merged(&changed_tiles(p, c))
                .into_iter()
                .map(|r| {
                    bulk_send(
                        &mut tx,
                        &mut rx,
                        &planar_bytes_layout(&crop(c, r), r.w, r.h, !historical),
                        fragment,
                    )
                })
                .sum()
        }) as Encoder
    };
    let adaptive = || {
        // DEC-02 candidate: per merged rectangle, planar+bulk unless the
        // RemoteFX estimate is smaller (photo-like content).
        let mut tx = BulkCompressor::new(CompressionType::Rdp61).unwrap();
        let mut rx = BulkCompressor::new(CompressionType::Rdp61).unwrap();
        let q = default_quant();
        Box::new(move |p: &[u8], c: &[u8]| {
            merged(&changed_tiles(p, c))
                .into_iter()
                .map(|r| {
                    let px = crop(c, r);
                    let planar = planar_bytes(&px, r.w, r.h);
                    let mut scratch = BulkCompressor::new(CompressionType::Rdp5).unwrap();
                    let sample = &planar[..planar.len().min(FRAGMENT)];
                    let (size, flags) = scratch.compress(sample).unwrap();
                    let encoded = if flags & PACKET_COMPRESSED != 0 {
                        size + 1
                    } else {
                        sample.len() + 1
                    };
                    let estimate = (encoded * planar.len()).div_ceil(sample.len());
                    if estimate as f64 <= planar.len() as f64 * 0.25 {
                        bulk_send(&mut tx, &mut rx, &planar, fragment)
                    } else {
                        let rfx_size = rfx(&px, r.w, r.h, &q);
                        if estimate <= rfx_size {
                            bulk_send(&mut tx, &mut rx, &planar, fragment)
                        } else {
                            // Conservative RemoteFX size: the server also bulk
                            // compresses it, so the actual wire size can be lower.
                            rfx_size
                        }
                    }
                })
                .sum()
        }) as Encoder
    };
    let q = default_quant;
    vec![
        (
            "EXP-01 A RemoteFX default quant per tile (today)",
            false,
            Box::new(move |p, c| {
                let q = q();
                changed_tiles(p, c)
                    .into_iter()
                    .map(|r| rfx(&crop(c, r), r.w, r.h, &q))
                    .sum()
            }),
        ),
        (
            "EXP-01 B RemoteFX per merged rectangle",
            false,
            Box::new(move |p, c| {
                let q = q();
                merged(&changed_tiles(p, c))
                    .into_iter()
                    .map(|r| rfx(&crop(c, r), r.w, r.h, &q))
                    .sum()
            }),
        ),
        (
            "EXP-02 C planar per 64x64 tile",
            true,
            Box::new(|p, c| {
                changed_tiles(p, c)
                    .into_iter()
                    .map(|r| planar_bytes(&crop(c, r), r.w, r.h).len())
                    .sum()
            }),
        ),
        (
            "EXP-02 D planar per merged rectangle",
            true,
            Box::new(|p, c| {
                merged(&changed_tiles(p, c))
                    .into_iter()
                    .map(|r| planar_bytes(&crop(c, r), r.w, r.h).len())
                    .sum()
            }),
        ),
        (
            "EXP-03 E planar merged + bulk MPPC-64K (RDP5)",
            true,
            bulk(CompressionType::Rdp5),
        ),
        (
            "EXP-03 F planar merged + bulk XCRUSH (RDP6.1)",
            true,
            bulk(CompressionType::Rdp61),
        ),
        (
            "EXP-04 G zstd(1) per changed tile (QOIZ-like)",
            true,
            Box::new(|p, c| {
                changed_tiles(p, c)
                    .into_iter()
                    .map(|r| zstd(&crop(c, r), 1))
                    .sum()
            }),
        ),
        (
            "EXP-06 H adaptive: planar+XCRUSH vs RemoteFX",
            false,
            adaptive(),
        ),
    ]
}

/// Luma PSNR of one bar tile through RemoteFX at increasing quantization.
fn quality_table() {
    use ironrdp_graphics::{dwt, quantization, rlgr, subband_reconstruction};
    let d = desktop(5);
    let r = Rect {
        x: 64,
        y: 128,
        w: 64,
        h: 64,
    };
    let px = crop(&d, r);
    let truth: Vec<f64> = px.chunks_exact(4).map(|p| f64::from(p[0])).collect();
    println!("\nEXP-05 RemoteFX quality on one bar tile (luma PSNR):");
    for (name, v) in [
        ("default", [6, 6, 6, 6, 7, 7, 8, 8, 8, 9]),
        ("+1", [7, 7, 7, 7, 8, 8, 9, 9, 9, 10]),
        ("+2", [8, 8, 8, 8, 9, 9, 10, 10, 10, 11]),
        ("+3", [9, 9, 9, 9, 10, 10, 11, 11, 11, 12]),
        ("+4", [10, 10, 10, 10, 11, 11, 12, 12, 12, 13]),
    ] {
        let q = quant(v);
        let (mut y, mut cb, mut cr) = ([0i16; 4096], [0i16; 4096], [0i16; 4096]);
        to_64x64_ycbcr_tile(
            &px,
            64,
            64,
            256,
            PixelFormat::BgrA32,
            &mut y,
            &mut cb,
            &mut cr,
        )
        .unwrap();
        let mut bytes = 0;
        let mut out = vec![0u8; 8192];
        for plane in [&mut cb, &mut cr] {
            bytes +=
                rfx_encode_component(plane.as_mut_slice(), &mut out, &q, EntropyAlgorithm::Rlgr3)
                    .unwrap();
        }
        let n = rfx_encode_component(&mut y, &mut out, &q, EntropyAlgorithm::Rlgr3).unwrap();
        bytes += n;
        let mut dec = [0i16; 4096];
        rlgr::decode(EntropyAlgorithm::Rlgr3, &out[..n], &mut dec).unwrap();
        subband_reconstruction::decode(&mut dec[4032..]);
        quantization::decode(&mut dec, &q);
        let mut temp = [0i16; 4096];
        dwt::decode(&mut dec, &mut temp);
        // RemoteFX luma is fixed point (<<5) around 0; grey content means
        // luma alone measures the visible error.
        let mse: f64 = truth
            .iter()
            .zip(dec.iter())
            .map(|(a, &v)| (a - f64::from(((i32::from(v) + 4096) >> 5).clamp(0, 255))).powi(2))
            .sum::<f64>()
            / truth.len() as f64;
        let psnr = if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255.0f64 * 255.0 / mse).log10()
        };
        println!("  {name:<8} {bytes:>5} B/tile  PSNR {psnr:>5.1} dB");
    }
}

fn main() {
    println!(
        "desktop {DW}x{DH}, window {WW}x{WH} at ({WX},{WY}), {FPS} fps, budget {BUDGET_KBPS} kbps (M4)"
    );
    let ui: Vec<Vec<u8>> = (0..=33).map(desktop).collect();
    let tiles: f64 = ui
        .windows(2)
        .map(|w| changed_tiles(&w[0], &w[1]).len() as f64)
        .sum::<f64>()
        / 33.0;
    println!("changed 64x64 tiles per frame (UI scene): {tiles:.1}");
    print_rows(
        "Scene 1: PERF-01 bar animation (UI-like, 4 colours)",
        &run(&ui, strategies(FRAGMENT, false)),
    );

    let photo: Vec<Vec<u8>> = (0..=16).map(photo_desktop).collect();
    print_rows(
        "Scene 2: noisy panning gradient (photo/video-like)",
        &run(&photo, strategies(FRAGMENT, false)),
    );

    quality_table();
}

#[test]
fn experiment_baseline_and_bulk_round_trips() {
    let ui: Vec<_> = (0..=33).map(desktop).collect();
    // The historical prototype used 16352-byte fragments. Preserve its
    // exact setup to validate the original numbers, then measure the actual
    // production fragment size separately.
    let baseline = run(&ui, strategies(16 * 1024 - 32, true));
    print_rows("Historical fragment baseline (16352)", &baseline);
    for (index, expected) in [(4, 314.0), (5, 292.0)] {
        assert!((baseline[index].bytes_per_frame / expected - 1.0).abs() <= 0.02);
    }
    let rows = run(&ui, strategies(FRAGMENT, false));
    print_rows("Production fragment (16374)", &rows);
    for (index, expected) in [
        (0, 31_120.0),
        (1, 27_220.0),
        (2, 66_547.0),
        (3, 24_906.0),
        (6, 12_427.0),
    ] {
        let row = &rows[index];
        assert!(
            (row.bytes_per_frame / expected - 1.0).abs() <= 0.02,
            "{}: {} B/frame vs {expected}",
            row.name,
            row.bytes_per_frame
        );
    }
    assert!(rows[5].bytes_per_frame * 8.0 * FPS / 1000.0 <= BUDGET_KBPS);
    assert!(rows[7].bytes_per_frame * 8.0 * FPS / 1000.0 <= BUDGET_KBPS);
    let photo: Vec<_> = (0..=16).map(photo_desktop).collect();
    let photo_rows = run(&photo, strategies(FRAGMENT, false));
    print_rows("Photo baseline", &photo_rows);
    assert!(photo_rows[7].bytes_per_frame <= photo_rows[0].bytes_per_frame);
    quality_table();
}
