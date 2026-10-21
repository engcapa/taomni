use super::damage::DamageRect;
use super::limits::DAMAGE_POLL_STEP;
use super::limits::DAMAGE_WAIT_BUDGET;
use super::limits::MIN_FRAME_INTERVAL;
use super::model::DamageState;
use super::shared_memory::Backend;
use crate::servers::rdp::capture::Capturer;
use crate::servers::rdp::capture::Frame;
use anyhow::Context as _;
use std::time::Instant;
use x11rb::connection::Connection as _;
use x11rb::protocol::damage::ConnectionExt as _;
use x11rb::protocol::shm;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xproto;
use x11rb::rust_connection::RustConnection;

pub(crate) struct X11Capturer {
    pub(super) conn: RustConnection,
    pub(super) root: xproto::Window,
    pub(super) width: u16,
    pub(super) height: u16,
    pub(super) depth: u8,
    pub(super) backend: Backend,
    /// `Some` when event-driven (XDamage) capture is active; `None` falls back
    /// to fixed-interval full-frame polling driven by the display layer.
    pub(super) damage: Option<DamageState>,
    pub(super) randr: bool,
}

impl Drop for X11Capturer {
    fn drop(&mut self) {
        // Tear down the damage object first (best effort).
        if let Some(d) = &self.damage {
            let _ = self.conn.damage_destroy(d.damage);
        }
        // Detach the SHM segment from the X server (no-op for the plain backend).
        // The local mapping is freed by ShmBuffer::drop.
        if let Backend::Shm(shm) = &self.backend {
            let _ = self.conn.shm_detach(shm.seg);
        }
        let _ = self.conn.flush();
    }
}

impl Capturer for X11Capturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        if !self.randr {
            let _ = self.refresh_geometry()?;
        }
        self.grab_rect(0, 0, self.width, self.height)
    }

    fn is_event_driven(&self) -> bool {
        self.damage.is_some()
    }

    fn poll_frame(&mut self) -> anyhow::Result<Option<Frame>> {
        if self.randr {
            let (_, resize_event) = self.drain_damage_events()?;
            if resize_event && self.refresh_geometry()? {
                return Ok(Some(self.capture()?));
            }
        }
        self.capture().map(Some)
    }

    fn next_updates(&mut self, first: bool) -> anyhow::Result<Vec<Frame>> {
        // DAMAGE uses ReportLevel::NON_EMPTY: the X server notifies only when
        // the damage region goes from empty to non-empty. A notify drained
        // here must therefore be honoured (not discarded), otherwise the
        // region stays non-empty without a subtract and no further notify is
        // ever sent — capture would stall after the first frame.
        let mut pending_damage = false;
        if self.randr {
            let (damage_event, resize_event) = self.drain_damage_events()?;
            if resize_event && self.refresh_geometry()? {
                self.clear_damage()?;
                return Ok(vec![self.capture()?]);
            }
            pending_damage = damage_event;
        } else if self.refresh_geometry()? {
            self.clear_damage()?;
            return Ok(vec![self.capture()?]);
        }
        // Polling fallback (no DAMAGE): one full frame; the display layer adds
        // its own interval + dedup.
        if self.damage.is_none() {
            return Ok(vec![self.capture()?]);
        }

        // First frame of a connection MUST be full so the encoder seeds its
        // framebuffer before any cropped region is diffed against it. Clear any
        // damage accumulated before the client connected so we don't immediately
        // re-send a region that's already covered by this full frame.
        if first {
            self.conn.flush().context("flush")?;
            self.clear_damage()?;
            self.conn.flush().context("flush")?;
            let frame = self.capture()?;
            if let Some(d) = self.damage.as_mut() {
                d.last_capture = Some(Instant::now());
            }
            return Ok(vec![frame]);
        }

        // Wait (sleeping, no readback) until the X server reports damage or the
        // budget elapses. When the budget elapses we still fall through to one
        // cheap subtract: it returns no rectangles when idle, and it re-arms the
        // NON_EMPTY notify if a notify was ever missed, so capture self-heals
        // instead of stalling.
        let deadline = Instant::now() + DAMAGE_WAIT_BUDGET;
        while !pending_damage {
            self.conn.flush().context("flush")?;
            let (damage_event, resize_event) = self.drain_damage_events()?;
            if resize_event && self.refresh_geometry()? {
                self.clear_damage()?;
                return Ok(vec![self.capture()?]);
            }
            if damage_event || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(DAMAGE_POLL_STEP);
        }

        // Enforce a max capture rate under continuous damage: if we captured
        // very recently, sleep the remainder and let more damage accumulate
        // server-side (free coalescing — it folds into the one subtract below).
        if let Some(last) = self.damage.as_ref().and_then(|d| d.last_capture) {
            if let Some(rem) = MIN_FRAME_INTERVAL.checked_sub(last.elapsed()) {
                std::thread::sleep(rem);
                self.conn.flush().context("flush")?;
                let _ = self.drain_damage_events()?;
            }
        }

        // Atomically consume + read back the exact changed rectangles, then grab
        // only those regions. Many tiny scattered rects (e.g. text carets) would
        // mean many small readbacks; cap the count by falling back to a single
        // bounding box when the server reports a lot of fragments.
        let rects = self.subtract_into_rects()?;
        self.conn.flush().context("flush")?;
        if rects.is_empty() {
            return Ok(vec![]);
        }

        const MAX_RECTS: usize = 8;
        let regions: Vec<DamageRect> = if rects.len() > MAX_RECTS {
            // Coalesce everything into one bounding box: cheaper than dozens of
            // round-trips, and the encoder still tile-diffs it.
            let mut bbox = rects[0];
            for r in &rects[1..] {
                bbox = bbox.union(*r);
            }
            vec![bbox]
        } else {
            rects
        };

        let mut frames = Vec::with_capacity(regions.len());
        for r in regions {
            frames.push(self.grab_rect(r.x, r.y, r.w, r.h)?);
        }
        if let Some(d) = self.damage.as_mut() {
            d.last_capture = Some(Instant::now());
        }
        Ok(frames)
    }
}
