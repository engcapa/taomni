use super::*;
use core::num::NonZeroUsize;

fn encoder(stats: Option<Arc<EncoderStats>>) -> UpdateEncoder {
    let mut codecs = UpdateEncoderCodecs::new();
    codecs.set_remotefx(Some((EntropyBits::Rlgr3, 3)));
    UpdateEncoder::new(
        DesktopSize {
            width: 64,
            height: 64,
        },
        CmdFlags::SET_SURFACE_BITS,
        codecs,
        8 * 1024 * 1024,
    )
    .unwrap()
    .with_bulk_compression(Some(CompressionType::Rdp61), stats, true)
    .unwrap()
}

fn bitmap(noisy: bool, seed: u32) -> BitmapUpdate {
    let mut seed = seed;
    let mut data = vec![42; 64 * 64 * 4];
    if noisy {
        for pixel in data.chunks_exact_mut(4) {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            pixel.copy_from_slice(&[seed as u8, (seed >> 8) as u8, (seed >> 16) as u8, 255]);
        }
    }
    BitmapUpdate {
        x: 0,
        y: 0,
        width: NonZeroU16::new(64).unwrap(),
        height: NonZeroU16::new(64).unwrap(),
        format: ironrdp_graphics::image_processing::PixelFormat::BgrA32,
        data: data.into(),
        stride: NonZeroUsize::new(64 * 4).unwrap(),
    }
}

async fn transmit(encoder: &mut UpdateEncoder, bitmap: BitmapUpdate) -> Vec<Vec<u8>> {
    let mut iter = encoder.update(DisplayUpdate::Bitmap(bitmap));
    let mut packets = Vec::new();
    while let Some(fragment) = iter.next().await {
        let mut fragment = fragment.unwrap();
        let mut output = vec![0; fragment.size_hint()];
        while let Some(length) = iter.encode_fragment(&mut fragment, &mut output).unwrap() {
            packets.push(output[..length].to_vec());
        }
    }
    packets
}

#[tokio::test]
async fn stage_counters_preserve_codec_bytes_headers_and_bulk_history() {
    let stats = Arc::new(EncoderStats::default());
    let mut measured = encoder(Some(Arc::clone(&stats)));
    let mut unmeasured = encoder(None);
    for (index, noisy) in [false, true, false, true].into_iter().enumerate() {
        let bitmap = bitmap(noisy, index as u32 + 1);
        let expected = transmit(&mut unmeasured, bitmap.clone()).await;
        let actual = transmit(&mut measured, bitmap).await;
        assert!(!actual.is_empty());
        assert_eq!(actual, expected, "round {index}: noisy={noisy}");
    }
    assert_eq!(stats.diff_time.snapshot().0, 4);
    assert_eq!(stats.queue_time.snapshot().0, 4);
    assert_eq!(stats.codec_time.snapshot().0, 4);
    assert_eq!(stats.blocking_roundtrip_time.snapshot().0, 4);
    assert_eq!(stats.selection_time.snapshot().0, 4);
    assert_eq!(stats.rfx_time.snapshot().0, 2);
    assert_eq!(stats.raw_planar_samples.load(Ordering::Relaxed), 2);
    assert_eq!(
        stats.materialized_planar_candidates.load(Ordering::Relaxed),
        2
    );
    assert!(stats.fragment_time.snapshot().0 >= 4);
}
