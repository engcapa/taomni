use std::sync::{
    Once,
    atomic::{AtomicBool, Ordering},
};

use ffmpeg::{codec, frame};

use super::*;

const AVI: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/media-legacy.avi");
const FLV: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/media-legacy.flv");
const REALMEDIA: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/media-legacy.rm");
const WMV: &[u8] =
    include_bytes!("../../../../../qa-ui-auto-tests/fixtures/taoffice/media-legacy.wmv");

fn init() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        ffmpeg::init().unwrap();
        ffmpeg::log::set_level(ffmpeg::log::Level::Quiet);
    });
}

fn open(bytes: Vec<u8>) -> format::context::Input {
    let io = format::context::StreamIo::from_read_seek(Cursor::new(bytes)).unwrap();
    format::input_from_stream(io, None, None).unwrap()
}

fn convert_sample(source: &[u8], options: ConversionOptions) -> Converted {
    init();
    convert(source.to_vec(), options, Arc::new(|| false), |_| {}).unwrap()
}

fn video_dimensions(media: &format::context::Input, codec: codec::Id) -> (u32, u32) {
    let video = media.streams().best(media::Type::Video).unwrap();
    let params = video.parameters();
    assert_eq!(params.id(), codec);
    let decoder = codec::context::Context::from_parameters(params)
        .unwrap()
        .decoder()
        .video()
        .unwrap();
    (decoder.width(), decoder.height())
}

#[test]
fn converts_avi_flv_wmv_and_realmedia_to_playable_webm() {
    for (source, dimensions, duration) in [
        (AVI, (160, 90), 6_000_000),
        (FLV, (80, 48), 1_000_000),
        (WMV, (80, 48), 1_000_000),
        (REALMEDIA, (80, 48), 1_000_000),
    ] {
        let converted = convert_sample(
            source,
            ConversionOptions {
                container: Container::Webm,
                start_ms: 0,
                end_ms: None,
                width: None,
            },
        );
        assert_eq!(converted.mime, "video/webm");
        let media = open(converted.bytes);
        assert_eq!(video_dimensions(&media, codec::Id::VP8), dimensions);
        assert!(
            media.duration().abs_diff(duration) <= 120_000,
            "Unexpected output duration {} for {duration}",
            media.duration()
        );
    }
}

#[test]
fn trims_and_resizes_webm_and_mp4_with_audio() {
    for (container, mime, video_codec, audio_codec) in [
        (
            Container::Webm,
            "video/webm",
            codec::Id::VP8,
            codec::Id::OPUS,
        ),
        (Container::Mp4, "video/mp4", codec::Id::H264, codec::Id::AAC),
    ] {
        let converted = convert_sample(
            AVI,
            ConversionOptions {
                container,
                start_ms: 2_000,
                end_ms: Some(5_000),
                width: Some(80),
            },
        );
        assert_eq!(converted.mime, mime);
        let mut media = open(converted.bytes);
        assert_eq!(video_dimensions(&media, video_codec), (80, 44));
        assert!(
            media.duration().abs_diff(3_000_000) <= 80_000,
            "Unexpected output duration {} for {container:?}",
            media.duration()
        );
        let audio = media.streams().best(media::Type::Audio).unwrap();
        assert_eq!(audio.parameters().id(), audio_codec);
        let audio_index = audio.index();
        let mut audio_decoder = codec::context::Context::from_parameters(audio.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        assert_eq!(audio_decoder.rate(), 48_000);
        let audio_packets: Vec<_> = media
            .packets()
            .filter_map(|(track, packet)| (track.index() == audio_index).then_some(packet))
            .collect();
        let mut total_samples = 0;
        let mut decoded = frame::Audio::empty();
        for packet in audio_packets {
            audio_decoder.send_packet(&packet).unwrap();
            while audio_decoder.receive_frame(&mut decoded).is_ok() {
                total_samples += decoded.samples();
            }
        }
        assert!(
            (142_000..=146_000).contains(&total_samples),
            "Unexpected number of decoded audio samples {total_samples} for {container:?}"
        );
    }
}

#[test]
fn cancels_in_flight_conversion_without_publishing_a_file() {
    init();
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&cancelled);
    let result = convert(
        AVI.to_vec(),
        ConversionOptions {
            container: Container::Webm,
            start_ms: 0,
            end_ms: None,
            width: None,
        },
        Arc::new(move || flag.load(Ordering::Relaxed)),
        |progress| {
            if progress.is_some_and(|fraction| fraction >= 0.25) {
                cancelled.store(true, Ordering::Relaxed);
            }
        },
    );
    assert!(cancelled.load(Ordering::Relaxed));
    assert!(matches!(result, Err(error) if error.contains("cancelled")));
}
