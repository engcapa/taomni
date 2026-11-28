use std::collections::VecDeque;

use ffmpeg_next::{
    self as ffmpeg, ChannelLayout, Packet, Rational, Rescale, codec, decoder, encoder, format,
    frame, software::resampling,
};

use super::{Container, MICROS, Timeline, is_drained, mux_packets, native_error};

const RATE: u32 = 48_000;
const TIME: Rational = Rational(1, RATE as i32);
const LAYOUT: ChannelLayout = ChannelLayout::STEREO;
const PACKED: format::Sample = format::Sample::F32(format::sample::Type::Packed);
const PLANAR: format::Sample = format::Sample::F32(format::sample::Type::Planar);

pub(super) struct Audio {
    pub(super) input_index: usize,
    pub(super) past_end: bool,
    output_index: usize,
    input_time: Rational,
    decoder: decoder::Audio,
    encoder: encoder::Audio,
    resampler: Option<resampling::Context>,
    fifo: VecDeque<(f32, f32)>,
    fifo_pts: i64,
    next_sample: Option<i64>,
}

impl Audio {
    pub(super) fn open(
        input: &format::stream::Stream<'_>,
        output: &mut format::context::Output,
        container: Container,
    ) -> Result<Self, String> {
        let decoder = codec::context::Context::from_parameters(input.parameters())
            .and_then(|context| context.decoder().audio())
            .map_err(native_error)?;
        let (name, format) = match container {
            Container::Webm => ("libopus", PACKED),
            Container::Mp4 => ("aac", PLANAR),
        };
        let codec = encoder::find_by_name(name)
            .ok_or_else(|| format!("{name} is unavailable for this media export."))?;
        let mut encoder = codec::context::Context::new_with_codec(codec)
            .encoder()
            .audio()
            .map_err(native_error)?;
        encoder.set_rate(RATE as i32);
        encoder.set_time_base(TIME);
        encoder.set_channel_layout(LAYOUT);
        // FFmpeg 6 exposes both channel layouts, while current FFmpeg uses ch_layout.
        unsafe {
            ffmpeg::ffi::av_channel_layout_default(&mut (*encoder.as_mut_ptr()).ch_layout, 2);
        }
        encoder.set_format(format);
        encoder.set_bit_rate(128_000);
        if output
            .format()
            .flags()
            .contains(format::Flags::GLOBAL_HEADER)
        {
            encoder.set_flags(codec::Flags::GLOBAL_HEADER);
        }
        let encoder = encoder.open().map_err(native_error)?;
        let mut stream = output.add_stream(codec).map_err(native_error)?;
        stream.set_parameters(&encoder);
        stream.set_time_base(TIME);
        Ok(Self {
            input_index: input.index(),
            past_end: false,
            input_time: input.time_base(),
            decoder,
            encoder,
            output_index: stream.index(),
            resampler: None,
            fifo: VecDeque::new(),
            fifo_pts: 0,
            next_sample: None,
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
            while let Some(delay) = self
                .resampler
                .as_ref()
                .and_then(|resampler| resampler.delay())
            {
                check()?;
                let mut samples = frame::Audio::new(PACKED, (delay.output + 32) as usize, LAYOUT);
                self.resampler
                    .as_mut()
                    .expect("resampler present")
                    .flush(&mut samples)
                    .map_err(native_error)?;
                if samples.samples() == 0 {
                    break;
                }
                self.append(&samples, None, output, timeline, progress)?;
            }
        }
        self.encode_pending(output, true)?;
        self.encoder.send_eof().map_err(native_error)?;
        mux_packets(output, self.output_index, TIME, |packet| {
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
        let mut decoded = frame::Audio::empty();
        loop {
            match self.decoder.receive_frame(&mut decoded) {
                Ok(()) => {}
                Err(error) if is_drained(error) => return Ok(()),
                Err(error) => return Err(native_error(error)),
            }
            check()?;
            let rate = decoded.rate();
            let channels = decoded.channels();
            if !(4_000..=384_000).contains(&rate)
                || !(1..=32).contains(&channels)
                || decoded.samples() > 262_144
            {
                return Err(
                    "The audio track uses an unsupported sample rate or channel layout.".into(),
                );
            }
            if decoded.channel_layout().is_empty() {
                decoded.set_channel_layout(ChannelLayout::default(i32::from(channels)));
            }
            let layout = decoded.channel_layout();
            if self.resampler.as_ref().is_none_or(|resampler| {
                resampler.input().format != decoded.format()
                    || resampler.input().rate != rate
                    || resampler.input().channel_layout != layout
            }) {
                self.resampler = Some(
                    resampling::Context::get(decoded.format(), layout, rate, PACKED, LAYOUT, RATE)
                        .map_err(native_error)?,
                );
            }
            let resampler = self.resampler.as_mut().expect("resampler configured");
            let delay = resampler.delay().map_or(0, |delay| delay.output);
            let capacity = (decoded.samples() * RATE as usize)
                .div_ceil(rate as usize)
                .saturating_add(delay as usize)
                .saturating_add(32);
            let mut samples = frame::Audio::new(PACKED, capacity, LAYOUT);
            resampler
                .run(&decoded, &mut samples)
                .map_err(native_error)?;
            let timestamp = decoded.timestamp().or(decoded.pts()).map(|timestamp| {
                timestamp
                    .rescale(self.input_time, TIME)
                    .saturating_sub(delay)
            });
            self.append(&samples, timestamp, output, timeline, progress)?;
            if self.past_end {
                return Ok(());
            }
        }
    }

    fn append(
        &mut self,
        samples: &frame::Audio,
        timestamp: Option<i64>,
        output: &mut format::context::Output,
        timeline: Timeline,
        progress: &impl Fn(Option<f64>),
    ) -> Result<(), String> {
        let clip_start = timeline.start.rescale(MICROS, TIME);
        let clip_end = timeline
            .end
            .map_or(i64::MAX, |end| end.rescale(MICROS, TIME));
        let expected = self.next_sample.or(timestamp).unwrap_or(clip_start);
        // Container audio PTS can have millisecond granularity. Ignore timestamp
        // rounding while preserving a discontinuity between decoded segments.
        let first = timestamp
            .filter(|time| time.abs_diff(expected) > u64::from(RATE / 10))
            .unwrap_or(expected);
        self.next_sample = Some(first.saturating_add(samples.samples() as i64));
        self.past_end = first.saturating_add(samples.samples() as i64) >= clip_end;
        let start = clip_start
            .saturating_sub(first)
            .clamp(0, samples.samples() as i64) as usize;
        let end = clip_end
            .saturating_sub(first)
            .clamp(0, samples.samples() as i64) as usize;
        if start >= end {
            return Ok(());
        }
        if first != expected && !self.fifo.is_empty() {
            self.encode_pending(output, true)?;
        }
        if self.fifo.is_empty() {
            self.fifo_pts = first
                .saturating_add(start as i64)
                .saturating_sub(clip_start)
                .max(self.fifo_pts);
        }
        self.fifo
            .extend(&samples.plane::<(f32, f32)>(0)[start..end]);
        self.encode_pending(output, false)?;
        progress(timeline.fraction(first.saturating_add(end as i64).rescale(TIME, MICROS)));
        Ok(())
    }

    fn encode_pending(
        &mut self,
        output: &mut format::context::Output,
        flush: bool,
    ) -> Result<(), String> {
        let frame_size = self.encoder.frame_size().max(1) as usize;
        while self.fifo.len() >= frame_size || (flush && !self.fifo.is_empty()) {
            let count = frame_size.min(self.fifo.len());
            let format = self.encoder.format();
            let mut pcm = frame::Audio::new(format, count, LAYOUT);
            pcm.set_rate(RATE);
            pcm.set_pts(Some(self.fifo_pts));
            self.fifo_pts = self.fifo_pts.saturating_add(count as i64);
            if format == PACKED {
                for (target, pair) in pcm
                    .plane_mut::<(f32, f32)>(0)
                    .iter_mut()
                    .zip(self.fifo.drain(..count))
                {
                    *target = pair;
                }
            } else {
                for (index, (left, right)) in self.fifo.drain(..count).enumerate() {
                    pcm.plane_mut::<f32>(0)[index] = left;
                    pcm.plane_mut::<f32>(1)[index] = right;
                }
            }
            self.encoder.send_frame(&pcm).map_err(native_error)?;
            mux_packets(output, self.output_index, TIME, |packet| {
                self.encoder.receive_packet(packet)
            })?;
        }
        Ok(())
    }
}
