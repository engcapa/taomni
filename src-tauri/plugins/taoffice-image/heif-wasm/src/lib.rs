use std::borrow::Cow;

use heic_rs::{DecodeOptions, Error, PixelLayout, context::Context};

#[cfg(target_arch = "wasm32")]
mod wasm;

const MAX_PIXELS: u64 = 16 * 1024 * 1024;
const MAX_TILE_PIXELS: u64 = 20 * 1024 * 1024;
const MAX_AXIS: u32 = 8192;
const MAX_THUMBNAIL_AXIS: u32 = 1600;
const MAX_ICC_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
#[repr(u32)]
enum PreviewError {
    Format = 1,
    Limits = 2,
    Engine = 3,
}

impl From<Error> for PreviewError {
    fn from(error: Error) -> Self {
        match error {
            Error::PixelLimit { .. } | Error::BoxTooLarge { .. } => Self::Limits,
            _ => Self::Format,
        }
    }
}

#[derive(Debug)]
struct Thumbnail {
    width: u32,
    height: u32,
    png: Vec<u8>,
}

fn check_size(width: u32, height: u32) -> Result<u64, PreviewError> {
    if width > MAX_AXIS || height > MAX_AXIS {
        return Err(PreviewError::Limits);
    }
    Ok(heic_rs::image::check_pixels(width, height, MAX_PIXELS)?)
}

fn check_item(context: &Context<'_>, item: u32) -> Result<(), PreviewError> {
    let properties = context.props(item)?;
    let (width, height) = context.coded_size(item, &properties)?;
    check_size(width, height)?;
    if let Some((grid, tiles)) = context.grid(item)? {
        check_size(grid.output_width, grid.output_height)?;
        let mut pixels = 0;
        for tile in tiles {
            pixels += check_picture(context, tile)?;
            if pixels > MAX_TILE_PIXELS {
                return Err(PreviewError::Limits);
            }
        }
    } else {
        check_picture(context, item)?;
    }
    Ok(())
}

fn check_picture(context: &Context<'_>, item: u32) -> Result<u64, PreviewError> {
    let properties = context.props(item)?;
    let codec = properties.hvcc.ok_or(PreviewError::Format)?;
    let coded = heic_rs::hevc::probe(&codec.parameter_sets())?;
    check_size(coded.width, coded.height)
}

fn decode_thumbnail(bytes: &[u8]) -> Result<Thumbnail, PreviewError> {
    let context = Context::open(bytes)?;
    let primary = context.meta.primary;
    check_item(&context, primary)?;
    if let Some(alpha) = context.alpha_item(primary)? {
        check_item(&context, alpha)?;
    }
    let profile = context.declared_icc(primary)?.filter(|profile| {
        (128..=MAX_ICC_BYTES).contains(&profile.len())
            && &profile[16..20] == b"RGB "
            && &profile[36..40] == b"acsp"
    });
    let options = DecodeOptions::default()
        .with_layout(PixelLayout::Rgba8)
        .with_max_pixels(Some(MAX_PIXELS))
        .with_strict(true);
    let decoded = heic_rs::decode(bytes, &options)?;
    check_size(decoded.width, decoded.height)?;
    let (width, height, pixels) = thumbnail_pixels(decoded);
    let mut png = Vec::new();
    let mut info = png::Info::with_size(width, height);
    info.color_type = png::ColorType::Rgba;
    info.icc_profile = profile.map(Cow::Borrowed);
    let mut encoder = png::Encoder::with_info(&mut png, info).map_err(|_| PreviewError::Engine)?;
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|_| PreviewError::Engine)?;
    writer
        .write_image_data(&pixels)
        .map_err(|_| PreviewError::Engine)?;
    writer.finish().map_err(|_| PreviewError::Engine)?;
    Ok(Thumbnail { width, height, png })
}

fn thumbnail_pixels(image: heic_rs::Image) -> (u32, u32, Vec<u8>) {
    let longest = image.width.max(image.height);
    if longest <= MAX_THUMBNAIL_AXIS {
        return (image.width, image.height, image.data);
    }
    let width = (image.width * MAX_THUMBNAIL_AXIS / longest).max(1);
    let height = (image.height * MAX_THUMBNAIL_AXIS / longest).max(1);
    let mut thumbnail = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        let top = y * image.height / height;
        let bottom = (y + 1) * image.height / height;
        for x in 0..width {
            let left = x * image.width / width;
            let right = (x + 1) * image.width / width;
            let mut total = [0u64; 4];
            for row in top..bottom {
                let start = ((row * image.width + left) * 4) as usize;
                let end = ((row * image.width + right) * 4) as usize;
                for pixel in image.data[start..end].chunks_exact(4) {
                    let alpha = u64::from(pixel[3]);
                    for channel in 0..3 {
                        total[channel] += u64::from(pixel[channel]) * alpha;
                    }
                    total[3] += alpha;
                }
            }
            let samples = u64::from((bottom - top) * (right - left));
            thumbnail.extend(
                total[..3]
                    .iter()
                    .map(|channel| channel.checked_div(total[3]).unwrap_or_default() as u8),
            );
            thumbnail.push((total[3] / samples) as u8);
        }
    }
    (width, height, thumbnail)
}

#[cfg(test)]
mod tests;
