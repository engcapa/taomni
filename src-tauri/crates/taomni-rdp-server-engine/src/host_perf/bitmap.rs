//! The fixed-size X11 performance fixture moves the same BGRA bitmap updates
//! that the in-process encoder receives, including nonzero damage offsets.
use std::num::{NonZeroU16, NonZeroUsize};

use anyhow::{Context, ensure};
use bytes::{Bytes, BytesMut};
use ironrdp::server::{BitmapUpdate, DesktopSize, PixelFormat};
use taomni_plugin_api::RpcError;
use taomni_plugin_stream::{CHUNK_BYTES, MAX_PAYLOAD_BYTES, native_channel::Channel};

const HEADER_LEN: usize = 12;

pub(super) fn channel_error(error: RpcError) -> anyhow::Error {
    anyhow::anyhow!("{} ({})", error.message, error.code)
}

pub(super) async fn send(channel: &mut Channel, bitmap: BitmapUpdate) -> anyhow::Result<usize> {
    ensure!(bitmap.format == PixelFormat::BgrA32, "Expected BGRA bitmap");
    let mut header = Vec::with_capacity(HEADER_LEN);
    for field in [bitmap.x, bitmap.y, bitmap.width.get(), bitmap.height.get()] {
        header.extend_from_slice(&field.to_le_bytes());
    }
    header.extend_from_slice(&u32::try_from(bitmap.stride.get())?.to_le_bytes());
    channel.send(header.into()).await.map_err(channel_error)?;
    let length = bitmap.data.len();
    for offset in (0..length).step_by(CHUNK_BYTES) {
        let end = (offset + CHUNK_BYTES).min(length);
        channel
            .send(bitmap.data.slice(offset..end))
            .await
            .map_err(channel_error)?;
    }
    Ok(length)
}

pub(super) async fn receive(
    channel: &mut Channel,
    size: DesktopSize,
) -> anyhow::Result<BitmapUpdate> {
    let header = receive_message(channel).await?;
    let mut bitmap = parse_header(&header, size)?;
    let length = bitmap.height.get() as usize * bitmap.stride.get();
    let mut data = BytesMut::with_capacity(length);
    while data.len() < length {
        let chunk = receive_message(channel).await?;
        let expected = (length - data.len()).min(CHUNK_BYTES);
        ensure!(chunk.len() == expected, "Invalid BGRA chunk size");
        data.extend_from_slice(&chunk);
    }
    bitmap.data = data.freeze();
    Ok(bitmap)
}

async fn receive_message(channel: &mut Channel) -> anyhow::Result<Bytes> {
    channel
        .receive()
        .await
        .map_err(channel_error)?
        .context("Incomplete bitmap")
}

fn parse_header(header: &[u8], size: DesktopSize) -> anyhow::Result<BitmapUpdate> {
    ensure!(header.len() == HEADER_LEN, "Invalid bitmap header size");
    let field = |offset| u16::from_le_bytes([header[offset], header[offset + 1]]);
    let (x, y) = (field(0), field(2));
    let width = NonZeroU16::new(field(4)).context("Zero bitmap width")?;
    let height = NonZeroU16::new(field(6)).context("Zero bitmap height")?;
    let stride = u32::from_le_bytes(header[8..12].try_into()?) as usize;
    let length = stride
        .checked_mul(usize::from(height.get()))
        .context("Bitmap size overflow")?;
    ensure!(
        stride >= usize::from(width.get()) * 4 && length <= MAX_PAYLOAD_BYTES,
        "Invalid bitmap stride or size"
    );
    ensure!(
        x.checked_add(width.get())
            .is_some_and(|right| right <= size.width)
            && y.checked_add(height.get())
                .is_some_and(|bottom| bottom <= size.height),
        "Bitmap region outside the capture surface"
    );
    Ok(BitmapUpdate {
        x,
        y,
        width,
        height,
        stride: NonZeroUsize::new(stride).context("Zero bitmap stride")?,
        format: PixelFormat::BgrA32,
        data: Bytes::new(),
    })
}

#[test]
fn validates_dimensions_stride_and_damage_offsets_before_allocating_pixels() {
    let size = DesktopSize {
        width: 1920,
        height: 1080,
    };
    let mut header = [40, 80, 640, 360]
        .into_iter()
        .flat_map(u16::to_le_bytes)
        .chain(2560u32.to_le_bytes())
        .collect::<Vec<_>>();
    let bitmap = parse_header(&header, size).unwrap();
    assert_eq!(
        (bitmap.x, bitmap.y, bitmap.width.get(), bitmap.height.get()),
        (40, 80, 640, 360)
    );
    header[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(parse_header(&header, size).is_err());
    header[8..12].copy_from_slice(&2559u32.to_le_bytes());
    assert!(parse_header(&header, size).is_err());
    header[8..12].copy_from_slice(&2560u32.to_le_bytes());
    header[..2].copy_from_slice(&u16::MAX.to_le_bytes());
    assert!(parse_header(&header, size).is_err());
    assert!(parse_header(&header[..11], size).is_err());
}
