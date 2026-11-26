use super::BytesData;
use super::filesystem::{bounded_read, open_regular};
use image::{ImageFormat, ImageReader, Limits};
use std::io::Cursor;

const INPUT_LIMIT: u64 = 32 * 1024 * 1024;
const PIXEL_LIMIT: u64 = 32 * 1024 * 1024;

pub(crate) fn read(path: &str) -> Result<BytesData, String> {
    let (_, mut file, metadata) = open_regular(path)?;
    if metadata.len() > INPUT_LIMIT {
        return Err("too_large: TIFF exceeds the 32 MiB image limit".into());
    }
    let bytes = bounded_read(&mut file, INPUT_LIMIT)?;
    if bytes.len() as u64 > INPUT_LIMIT {
        return Err("too_large: TIFF grew beyond the image budget".into());
    }
    encode_preview(&bytes)
}

fn encode_preview(input: &[u8]) -> Result<BytesData, String> {
    let fail = |error: image::ImageError| format!("image: Cannot decode TIFF: {error}");
    let reader = || ImageReader::with_format(Cursor::new(input), ImageFormat::Tiff);
    let (width, height) = reader().into_dimensions().map_err(fail)?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > PIXEL_LIMIT {
        return Err("too_large: TIFF preview exceeds 32 megapixels".into());
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    let mut source = reader();
    source.limits(limits);
    let image = source.decode().map_err(fail)?;
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|error| format!("image: Cannot render TIFF: {error}"))?;
    let bytes = png.into_inner();
    if bytes.len() as u64 > INPUT_LIMIT {
        return Err("too_large: Rendered TIFF exceeds the 32 MiB image limit".into());
    }
    Ok(BytesData {
        size: bytes.len() as u64,
        mime: "image/png".into(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_original_pixels_and_rejects_a_truncated_image() {
        let original =
            image::RgbImage::from_fn(4, 3, |x, y| image::Rgb([x as u8 * 61, y as u8 * 90, 115]));
        let mut encoded = Cursor::new(Vec::new());
        original.write_to(&mut encoded, ImageFormat::Tiff).unwrap();
        let preview = encode_preview(encoded.get_ref()).unwrap();
        let decoded = image::load_from_memory_with_format(&preview.bytes, ImageFormat::Png)
            .unwrap()
            .into_rgb8();
        assert_eq!(original, decoded);
        assert!(encode_preview(&encoded.get_ref()[..12]).is_err());
    }
}
