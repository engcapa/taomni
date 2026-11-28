use ffmpeg_next::{
    Dictionary, Packet, Rational, Rescale, codec, decoder, encoder, format, frame,
    software::scaling,
};

use super::{
    Container, ConversionOptions, MAX_DIMENSION, MICROS, Timeline, is_drained, mux_packets,
    native_error,
};

const ENCODER_TIME: Rational = Rational(1, 1000);
const OUTPUT_PIXELS: format::Pixel = format::Pixel::YUV420P;

pub(super) struct Video {
    pub(super) input_index: usize,
    pub(super) past_end: bool,
    output_index: usize,
    decoder: decoder::Video,
    encoder: encoder::Video,
    scaler: Option<scaling::Context>,
    input_time: Rational,
    fallback_step: i64,
    next_timestamp: Option<i64>,
    last_pts: Option<i64>,
}

pub(super) fn dimensions(
    width: u32,
    height: u32,
    limit: Option<u32>,
) -> Result<(u32, u32), String> {
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err("The video dimensions exceed the supported size.".into());
    }
    if limit.is_some_and(|limit| !(16..=MAX_DIMENSION).contains(&limit)) {
        return Err("The export width falls outside the supported size.".into());
    }
    let output_width = limit.map_or(width, |limit| limit.min(width));
    let output_height =
        (u64::from(height) * u64::from(output_width) + u64::from(width) / 2) / u64::from(width);
    Ok((
        (output_width & !1).max(2),
        (output_height as u32 & !1).max(2),
    ))
}

impl Video {
    pub(super) fn open(
        input: &format::stream::Stream<'_>,
        output: &mut format::context::Output,
        options: ConversionOptions,
    ) -> Result<Self, String> {
        let mut context =
            codec::context::Context::from_parameters(input.parameters()).map_err(native_error)?;
        // Limit decode allocation even when the coded size changes within a stream.
        unsafe {
            (*context.as_mut_ptr()).max_pixels = i64::from(MAX_DIMENSION) * i64::from(MAX_DIMENSION)
        };
        context.set_threading(codec::threading::Config::count(2));
        let decoder = context.decoder().video().map_err(native_error)?;
        let (width, height) = dimensions(decoder.width(), decoder.height(), options.width)?;
        let codec_name = match options.container {
            Container::Webm => "libvpx",
            Container::Mp4 => "libopenh264",
        };
        let codec = encoder::find_by_name(codec_name)
            .ok_or_else(|| format!("{codec_name} is unavailable for this media export."))?;
        let mut encoder = codec::context::Context::new_with_codec(codec)
            .encoder()
            .video()
            .map_err(native_error)?;
        encoder.set_width(width);
        encoder.set_height(height);
        encoder.set_aspect_ratio(decoder.aspect_ratio());
        encoder.set_format(OUTPUT_PIXELS);
        let frame_rate = input.avg_frame_rate();
        let fps = f64::from(frame_rate);
        let frame_rate = if (1.0..=240.0).contains(&fps) {
            frame_rate
        } else {
            Rational(30, 1)
        };
        encoder.set_frame_rate(Some(frame_rate));
        encoder.set_time_base(ENCODER_TIME);
        encoder.set_bit_rate((width as usize * height as usize * 2).clamp(120_000, 8_000_000));
        encoder.set_gop((f64::from(frame_rate) * 2.0).round() as u32);
        encoder.set_max_b_frames(0);
        encoder.set_threading(codec::threading::Config::count(2));
        if output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER)
        {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        let mut parameters = Dictionary::new();
        if matches!(options.container, Container::Webm) {
            parameters.set("deadline", "realtime");
            parameters.set("cpu-used", "5");
            parameters.set("lag-in-frames", "0");
        }
        let encoder = encoder.open_with(parameters).map_err(native_error)?;
        let mut stream = output.add_stream(codec).map_err(native_error)?;
        stream.set_parameters(&encoder);
        stream.set_time_base(ENCODER_TIME);
        stream.set_rate(frame_rate);
        stream.set_avg_frame_rate(frame_rate);
        Ok(Self {
            input_index: input.index(),
            past_end: false,
            output_index: stream.index(),
            decoder,
            encoder,
            scaler: None,
            input_time: input.time_base(),
            fallback_step: (1_000_000.0 / f64::from(frame_rate)).round() as i64,
            next_timestamp: None,
            last_pts: None,
        })
    }

    pub(super) fn send(
        &mut self,
        packet: &Packet,
        output: &mut format::context::Output,
        timeline: Timeline,
        check: &impl Fn() -> Result<(), String>,
        progress: &impl Fn(Option<f64>),
    ) -> Result<(), String> {
        if self.past_end {
            return Ok(());
        }
        self.decoder.send_packet(packet).map_err(native_error)?;
        self.receive(output, timeline, check, progress)
    }

    pub(super) fn finish(
        &mut self,
        output: &mut format::context::Output,
        timeline: Timeline,
        check: &impl Fn() -> Result<(), String>,
        progress: &impl Fn(Option<f64>),
    ) -> Result<(), String> {
        if !self.past_end {
            self.decoder.send_eof().map_err(native_error)?;
            self.receive(output, timeline, check, progress)?;
        }
        if self.last_pts.is_none() {
            return Err("The trim range includes no video frames.".into());
        }
        self.encoder.send_eof().map_err(native_error)?;
        mux_packets(output, self.output_index, ENCODER_TIME, |packet| {
            self.encoder.receive_packet(packet)
        })
    }

    fn receive(
        &mut self,
        output: &mut format::context::Output,
        timeline: Timeline,
        check: &impl Fn() -> Result<(), String>,
        progress: &impl Fn(Option<f64>),
    ) -> Result<(), String> {
        let mut image = frame::Video::empty();
        loop {
            match self.decoder.receive_frame(&mut image) {
                Ok(()) => {}
                Err(error) if is_drained(error) => return Ok(()),
                Err(error) => return Err(native_error(error)),
            }
            check()?;
            let timestamp = image
                .timestamp()
                .or(image.pts())
                .map(|timestamp| timestamp.rescale(self.input_time, MICROS))
                .or(self.next_timestamp)
                .unwrap_or(timeline.start);
            self.next_timestamp = Some(timestamp.saturating_add(self.fallback_step));
            if timestamp < timeline.start {
                continue;
            }
            if timeline.end.is_some_and(|end| timestamp >= end) {
                self.past_end = true;
                return Ok(());
            }
            self.send_image(&image, timestamp.saturating_sub(timeline.start), output)?;
            progress(timeline.fraction(timestamp));
        }
    }

    fn send_image(
        &mut self,
        source: &frame::Video,
        offset: i64,
        output: &mut format::context::Output,
    ) -> Result<(), String> {
        dimensions(source.width(), source.height(), None)?;
        if self.scaler.as_ref().is_none_or(|scaler| {
            scaler.input().format != source.format()
                || scaler.input().width != source.width()
                || scaler.input().height != source.height()
        }) {
            self.scaler = Some(
                scaling::Context::get(
                    source.format(),
                    source.width(),
                    source.height(),
                    OUTPUT_PIXELS,
                    self.encoder.width(),
                    self.encoder.height(),
                    scaling::Flags::BILINEAR,
                )
                .map_err(native_error)?,
            );
        }
        let mut scaled = frame::Video::empty();
        self.scaler
            .as_mut()
            .expect("scaler configured")
            .run(source, &mut scaled)
            .map_err(native_error)?;
        let pts = offset.rescale(MICROS, ENCODER_TIME);
        let pts = self
            .last_pts
            .map_or(pts, |value| pts.max(value.saturating_add(1)));
        scaled.set_pts(Some(pts));
        self.last_pts = Some(pts);
        self.encoder.send_frame(&scaled).map_err(native_error)?;
        mux_packets(output, self.output_index, ENCODER_TIME, |packet| {
            self.encoder.receive_packet(packet)
        })
    }
}
