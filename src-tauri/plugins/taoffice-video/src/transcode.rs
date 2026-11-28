use std::{io::Cursor, sync::Arc};

use ffmpeg_next::{self as ffmpeg, Dictionary, Packet, Rational, Rescale, format, media};
use serde::Deserialize;

mod audio;
mod buffer;
#[cfg(test)]
mod tests;
mod video;

pub(crate) const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MICROS: Rational = Rational(1, 1_000_000);
const FORMATS: &str = "avi,flv,asf,rm,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg,wav,mp3,aac,flac";
const MAX_DIMENSION: u32 = 8192;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Container {
    Webm,
    Mp4,
}

impl Container {
    fn name(self) -> &'static str {
        match self {
            Self::Webm => "webm",
            Self::Mp4 => "mp4",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversionOptions {
    pub(crate) container: Container,
    pub(crate) start_ms: u32,
    pub(crate) end_ms: Option<u32>,
    pub(crate) width: Option<u32>,
}

#[derive(Clone, Copy)]
struct Timeline {
    start: i64,
    end: Option<i64>,
}

impl Timeline {
    fn fraction(self, timestamp: i64) -> Option<f64> {
        let length = self.end?.saturating_sub(self.start);
        (length > 0)
            .then(|| (timestamp.saturating_sub(self.start) as f64 / length as f64).clamp(0.0, 0.99))
    }
}

pub(crate) struct Converted {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime: &'static str,
}

fn native_error(error: ffmpeg::Error) -> String {
    if matches!(
        error,
        ffmpeg::Error::Other {
            errno: ffmpeg::error::ENOSPC
        }
    ) {
        return "The converted media exceeds 32 MiB. Choose a shorter clip or a smaller size."
            .into();
    }
    error.to_string()
}

fn origin_and_duration(input: &format::context::Input) -> (i64, Option<i64>) {
    let start = input
        .streams()
        .filter(|stream| {
            matches!(
                stream.parameters().medium(),
                media::Type::Video | media::Type::Audio
            )
        })
        .filter_map(|stream| {
            let start = stream.start_time();
            (start != ffmpeg::ffi::AV_NOPTS_VALUE)
                .then(|| start.rescale(stream.time_base(), MICROS))
        })
        .min()
        .unwrap_or(0);
    let duration = input.duration();
    (start, (duration > 0).then_some(duration))
}

pub(crate) fn convert(
    bytes: Vec<u8>,
    options: ConversionOptions,
    is_cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
    progress: impl Fn(Option<f64>),
) -> Result<Converted, String> {
    let mut input_options = Dictionary::new();
    input_options.set("format_whitelist", FORMATS);
    // Custom AVIO reads the supplied buffer. In-file references cannot open
    // additional protocols or demuxers.
    input_options.set("protocol_whitelist", "taomni-buffer");
    input_options.set("enable_drefs", "0");
    input_options.set("max_streams", "64");
    input_options.set("max_pixels", "67108864");
    let source =
        format::context::StreamIo::from_read_seek(Cursor::new(bytes)).map_err(native_error)?;
    let check_interrupt = Arc::clone(&is_cancelled);
    let mut input =
        format::input_from_stream_with_interrupt(source, None, Some(input_options), move || {
            check_interrupt()
        })
        .map_err(native_error)?;
    let (origin, duration) = origin_and_duration(&input);
    let start = i64::from(options.start_ms) * 1000;
    let end = options.end_ms.map(|end| i64::from(end) * 1000);
    if end.is_some_and(|end| end <= start)
        || duration.is_some_and(|duration| start >= duration)
        || matches!((end, duration), (Some(end), Some(duration)) if end > duration.saturating_add(200_000))
    {
        return Err("The trim range falls outside the source duration.".into());
    }
    let timeline = Timeline {
        start: origin.saturating_add(start),
        end: end.or(duration).map(|end| origin.saturating_add(end)),
    };
    let buffer = buffer::OutputBuffer::default();
    let stream =
        format::context::StreamIo::from_write_seek(buffer.clone()).map_err(native_error)?;
    let mut output = format::output_to_stream(stream, None, Some(options.container.name()))
        .map_err(native_error)?;
    let mut video = input
        .streams()
        .best(media::Type::Video)
        .filter(|stream| {
            !stream
                .disposition()
                .contains(format::stream::Disposition::ATTACHED_PIC)
        })
        .map(|stream| video::Video::open(&stream, &mut output, options))
        .transpose()?;
    let mut audio = input
        .streams()
        .best(media::Type::Audio)
        .map(|stream| audio::Audio::open(&stream, &mut output, options.container))
        .transpose()?;
    if video.is_none() && audio.is_none() {
        return Err("The file contains no convertible video or audio tracks.".into());
    }
    output.write_header().map_err(native_error)?;
    progress(timeline.fraction(timeline.start));

    let check = || {
        if is_cancelled() {
            Err("The conversion was cancelled".to_owned())
        } else {
            Ok(())
        }
    };
    loop {
        check()?;
        let mut packet = Packet::empty();
        match packet.read(&mut input) {
            Ok(()) => {}
            Err(ffmpeg::Error::Eof) => break,
            Err(error) => return Err(native_error(error)),
        }
        if let Some(video) = video
            .as_mut()
            .filter(|video| video.input_index == packet.stream())
        {
            video.send(&packet, &mut output, timeline, &check, &progress)?;
        }
        if let Some(audio) = audio
            .as_mut()
            .filter(|audio| audio.input_index == packet.stream())
        {
            audio.send(&packet, &mut output, timeline, &check, &progress)?;
        }
        if end.is_some()
            && video.as_ref().is_none_or(|track| track.past_end)
            && audio.as_ref().is_none_or(|track| track.past_end)
        {
            break;
        }
    }
    check()?;
    if let Some(video) = video.as_mut() {
        video.finish(&mut output, timeline, &check, &progress)?;
    }
    if let Some(audio) = audio.as_mut() {
        audio.finish(&mut output, timeline, &check, &progress)?;
    }
    output.write_trailer().map_err(native_error)?;
    drop(output);
    check()?;
    let mime = match (options.container, video.is_some()) {
        (Container::Webm, true) => "video/webm",
        (Container::Webm, false) => "audio/webm",
        (Container::Mp4, true) => "video/mp4",
        (Container::Mp4, false) => "audio/mp4",
    };
    Ok(Converted {
        bytes: buffer.finish()?,
        mime,
    })
}

fn is_drained(error: ffmpeg::Error) -> bool {
    matches!(
        error,
        ffmpeg::Error::Eof
            | ffmpeg::Error::Other {
                errno: ffmpeg::error::EAGAIN
            }
    )
}

fn mux_packets(
    output: &mut format::context::Output,
    index: usize,
    encoder_time: Rational,
    mut receive: impl FnMut(&mut Packet) -> Result<(), ffmpeg::Error>,
) -> Result<(), String> {
    let stream_time = output
        .stream(index)
        .ok_or("The output track is unavailable.")?
        .time_base();
    let mut packet = Packet::empty();
    loop {
        match receive(&mut packet) {
            Ok(()) => {
                packet.set_stream(index);
                packet.rescale_ts(encoder_time, stream_time);
                packet.write_interleaved(output).map_err(native_error)?;
            }
            Err(error) if is_drained(error) => return Ok(()),
            Err(error) => return Err(native_error(error)),
        }
    }
}
