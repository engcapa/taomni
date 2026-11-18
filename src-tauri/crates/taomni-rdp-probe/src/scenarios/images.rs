use super::clipboard_receive::sha256_hex;
use super::dispatch::plain;
use super::dispatch::usage;
use super::readiness::open;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use serde_json::json;
use sha2::Digest;
use std::path::Path;

/// Pixel digest of a PNG (RGB only, so an alpha-dropping clipboard path still
/// compares equal for opaque reference images).
pub(super) fn image_digest(args: &Args) -> ScenarioResult {
    let path = args
        .opt("png")
        .ok_or_else(|| usage("--png is required".into()))?;
    let image = image::open(&path)
        .map_err(|e| plain(ProbeError::unmet(format!("{path}: {e}"))))?
        .to_rgba8();
    let rgb: Vec<u8> = image
        .as_raw()
        .chunks_exact(4)
        .flat_map(|p| [p[0], p[1], p[2]])
        .collect();
    Ok(json!({
        "width": image.width(),
        "height": image.height(),
        "rgb_sha256": sha256_hex(&rgb),
        "rgba_sha256": sha256_hex(image.as_raw()),
    }))
}

/// Write a deterministic, opaque test picture (RGB gradient with a bright
/// diagonal) for clipboard image cases, then report its digest. Opaque on
/// purpose: CF_DIB carries no alpha, so only RGB is compared across formats.
pub(super) fn image_make(args: &Args) -> ScenarioResult {
    let path = args
        .opt("out-png")
        .ok_or_else(|| usage("--out-png is required".into()))?;
    let width = args.u64("width", 96).map_err(usage)?.clamp(1, 4096) as u32;
    let height = args.u64("height", 64).map_err(usage)?.clamp(1, 4096) as u32;
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        if x * height / width.max(1) == y {
            image::Rgba([255, 255, 255, 255])
        } else {
            image::Rgba([
                (x * 255 / width.max(1)) as u8,
                (y * 255 / height.max(1)) as u8,
                ((x + y) % 256) as u8,
                255,
            ])
        }
    });
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    image
        .save(&path)
        .map_err(|e| plain(ProbeError::unmet(format!("{path}: {e}"))))?;
    let mut digest = image_digest(&Args::with_value("png", &path))?;
    digest["path"] = json!(path);
    Ok(digest)
}
