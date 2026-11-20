use super::*;

impl FrameFlow {
    pub(super) fn new() -> Self {
        Self {
            damage: Damage::default(),
            frontend_ready: true,
            request_deferred: false,
            frames_sent: 0,
            // The handshake already sent the first full request.
            outstanding: 1,
            last_update_at: Instant::now(),
            last_server_at: Instant::now(),
            probe_sent_at: None,
        }
    }

    /// Record the damage carried by one decoded update and report whether a
    /// new request may be sent before the frontend ACK. Pixel damage occupies
    /// the single canvas frame in flight; an empty update can be polled again.
    pub(super) fn note_update<I>(&mut self, rects: I) -> bool
    where
        I: IntoIterator<Item = FbRect>,
    {
        for rect in rects {
            self.damage.add(rect);
        }
        let waiting_for_frontend = !self.frontend_ready || !self.damage.is_empty();
        self.request_deferred = waiting_for_frontend;
        !waiting_for_frontend
    }

    pub(super) fn take_deferred_request(&mut self) -> bool {
        // An unsolicited update or a refresh can queue another frame before
        // this ACK arrives. Keep waiting if flush_frame sent that damage to
        // the WebView; its own paint must be acknowledged first.
        self.frontend_ready && self.damage.is_empty() && std::mem::take(&mut self.request_deferred)
    }
}

impl StatsWindow {
    pub(super) fn new() -> Self {
        Self {
            started: Instant::now(),
            wire_bytes: 0,
            updates: 0,
            frames: 0,
            update_micros: 0,
            line_kbps: None,
            initialized: false,
            burst: None,
        }
    }

    pub(super) fn close_burst(&mut self) {
        if let Some((start, end, bytes)) = self.burst.take() {
            let micros = end.duration_since(start).as_micros() as u64;
            if bytes >= LINE_SPEED_MIN_BYTES && micros > 0 {
                let sample = bytes * 8 * 1000 / micros;
                self.line_kbps = Some(match self.line_kbps {
                    Some(previous) => (previous * 3 + sample) / 4,
                    None => sample,
                });
            }
        }
    }

    pub(super) fn observe(
        &mut self,
        stats: RuntimeStats,
        frames_sent: u64,
        labels: &StatsLabels,
    ) -> Option<String> {
        if !self.initialized {
            self.initialized = true;
            self.wire_bytes = stats.wire_bytes;
            self.updates = stats.updates.saturating_sub(1);
            self.frames = frames_sent.saturating_sub(1);
        }
        self.update_micros += stats.last_update_micros;
        if let (Some(start), Some(end)) =
            (stats.last_update_started_at, stats.last_update_finished_at)
        {
            match self.burst {
                Some((burst_start, burst_end, bytes))
                    if start.saturating_duration_since(burst_end) < BURST_GAP =>
                {
                    self.burst = Some((burst_start, end, bytes + stats.last_update_wire_bytes));
                }
                _ => {
                    self.close_burst();
                    self.burst = Some((start, end, stats.last_update_wire_bytes));
                }
            }
        }
        let elapsed = self.started.elapsed();
        if elapsed < STATS_INTERVAL {
            return None;
        }
        let seconds = elapsed.as_secs_f32();
        let updates = stats.updates.saturating_sub(self.updates);
        let frames = frames_sent.saturating_sub(self.frames);
        let message = WsOutgoingText::Stats {
            requested_encoding: labels.requested,
            last_encoding: stats.last_encoding.map(encoding_name).unwrap_or("-"),
            pixel_format: stats.pixel_format.label(),
            quality: labels.quality,
            quality_level: labels.level,
            wire_kbps: (stats.wire_bytes.saturating_sub(self.wire_bytes) as f32 * 8.0
                / 1000.0
                / seconds) as u64,
            line_kbps: self.line_kbps,
            updates_per_sec: updates as f32 / seconds,
            frames_per_sec: frames as f32 / seconds,
            update_ms: if updates > 0 {
                self.update_micros as f32 / 1000.0 / updates as f32
            } else {
                0.0
            },
        };
        self.started = Instant::now();
        self.wire_bytes = stats.wire_bytes;
        self.updates = stats.updates;
        self.frames = frames_sent;
        self.update_micros = 0;
        serde_json::to_string(&message).ok()
    }
}

/// Serialize the pending damage as one relay frame if the WebView is ready.
/// Returns true when a frame boundary was queued.
pub(super) fn flush_frame(
    flow: &SharedFrameFlow,
    framebuffer: &SharedFramebuffer,
    ws_out: &FrameQueueSender,
) -> bool {
    let rects = {
        let Ok(mut flow) = flow.lock() else {
            return false;
        };
        if !flow.frontend_ready || flow.damage.is_empty() {
            return false;
        }
        flow.frontend_ready = false;
        flow.frames_sent += 1;
        flow.damage.take()
    };
    let frames: Vec<Vec<u8>> = match framebuffer.lock() {
        Ok(fb) => rects
            .into_iter()
            .filter_map(|rect| fb.relay_frame(rect))
            .collect(),
        Err(_) => return false,
    };
    for frame in frames {
        let _ = ws_out.push_rect(frame);
    }
    if ws_out.finish_frame().unwrap_or(false) {
        // Either an undelivered older frame was replaced (after a Refresh or
        // resize marked the WebView ready early) or this frame exceeded the
        // queue budget. The pixels of the lost frame are unknown here, so
        // repaint the whole surface with the next frame.
        damage_full_framebuffer(flow, framebuffer);
        if !ws_out.has_pending_frame()
            && let Ok(mut flow) = flow.lock()
        {
            // Nothing is in flight, so no ACK will arrive to release the
            // next frame.
            flow.frontend_ready = true;
        }
    }
    true
}

pub(super) fn stats_labels(quality: &SharedQuality) -> StatsLabels {
    match quality.lock() {
        Ok(quality) => StatsLabels {
            requested: quality.applied().requested_label(),
            quality: quality.preset().label(),
            level: quality.level().label(),
        },
        Err(_) => StatsLabels {
            requested: "-",
            quality: "-",
            level: "-",
        },
    }
}

/// Send the pending encoding profile: SetEncodings, SetPixelFormat when it
/// changed, and a full update request so the new quality shows at once.
/// Callers make sure no update is outstanding when the format changes.
pub(super) fn apply_pending_quality(
    writer: &mut RfbWriter,
    quality: &SharedQuality,
    flow: &SharedFrameFlow,
) -> Result<bool, String> {
    let Some((profile, format_changed)) = quality
        .lock()
        .map_err(|_| "VNC quality lock poisoned".to_string())?
        .take_pending()
    else {
        return Ok(false);
    };
    writer.set_encodings(&profile.encodings)?;
    if format_changed {
        writer.set_pixel_format(profile.pixel_format)?;
    }
    writer.request_update(false)?;
    if let Ok(mut flow) = flow.lock() {
        flow.outstanding = flow.outstanding.saturating_add(1);
    }
    Ok(true)
}

/// Whether the pending quality change can be sent now.
pub(super) fn quality_ready(quality: &SharedQuality, flow: &SharedFrameFlow) -> bool {
    let Ok(quality) = quality.lock() else {
        return false;
    };
    if !quality.has_pending() {
        return false;
    }
    if !quality.pending_needs_sync() {
        return true;
    }
    flow.lock()
        .map(|flow| {
            flow.outstanding == 0
                && flow.frontend_ready
                && flow.damage.is_empty()
                && !flow.request_deferred
        })
        .unwrap_or(false)
}

pub(super) fn note_request(flow: &SharedFrameFlow) {
    if let Ok(mut flow) = flow.lock() {
        flow.outstanding = flow.outstanding.saturating_add(1);
    }
}

pub(super) fn damage_full_framebuffer(flow: &SharedFrameFlow, framebuffer: &SharedFramebuffer) {
    let size = framebuffer
        .lock()
        .map(|fb| (fb.width(), fb.height()))
        .unwrap_or((0, 0));
    if let Ok(mut flow) = flow.lock() {
        flow.damage.add(FbRect::new(0, 0, size.0, size.1));
    }
}
