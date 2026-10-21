use super::lifetime::X11Capturer;
use super::shared_memory::Backend;
use crate::servers::rdp::capture::Frame;
use anyhow::Context as _;
use anyhow::bail;
use x11rb::connection::Connection as _;
use x11rb::protocol::Event;
use x11rb::protocol::damage;
use x11rb::protocol::damage::ConnectionExt as _;
use x11rb::protocol::randr;
use x11rb::protocol::shm;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto;
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::xproto::ImageFormat;

/// A pixel rectangle in desktop coordinates, used to accumulate (union) damaged
/// areas before a single readback. Kept tiny and pure so the union/clamp logic
/// can be unit-tested without an X server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DamageRect {
    pub(super) x: u16,
    pub(super) y: u16,
    pub(super) w: u16,
    pub(super) h: u16,
}

impl DamageRect {
    /// Build from a raw X `Rectangle`, clamped to the desktop bounds. Returns
    /// `None` if the rectangle is empty or lies fully outside the screen.
    pub(super) fn from_x_rect(r: xproto::Rectangle, screen_w: u16, screen_h: u16) -> Option<Self> {
        // X rectangles use i16 origins and u16 extents; clamp into the screen.
        let x0 = r.x.max(0) as u16;
        let y0 = r.y.max(0) as u16;
        if x0 >= screen_w || y0 >= screen_h {
            return None;
        }
        let x1 = (i32::from(r.x) + i32::from(r.width)).clamp(0, i32::from(screen_w)) as u16;
        let y1 = (i32::from(r.y) + i32::from(r.height)).clamp(0, i32::from(screen_h)) as u16;
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        Some(Self {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        })
    }

    /// Smallest rectangle covering both `self` and `other`.
    pub(super) fn union(self, other: Self) -> Self {
        let x0 = self.x.min(other.x);
        let y0 = self.y.min(other.y);
        let x1 = (self.x + self.w).max(other.x + other.w);
        let y1 = (self.y + self.h).max(other.y + other.h);
        Self {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        }
    }
}

impl X11Capturer {
    /// Grab a sub-rectangle of the root window into a tightly-packed BGRA
    /// [`Frame`] at origin `(x, y)`. `capture()` is just the full-screen case.
    ///
    /// GetImage/shm_get_image always pack the reply at the *requested* width
    /// (`bytes_per_line = bpp * width`), so a cropped grab is tightly packed at
    /// `w * 4` regardless of the full-frame stride.
    pub(super) fn grab_rect(&self, x: u16, y: u16, w: u16, h: u16) -> anyhow::Result<Frame> {
        let mut data = match &self.backend {
            Backend::Shm(shm) => {
                self.conn
                    .shm_get_image(
                        self.root,
                        x as i16,
                        y as i16,
                        w,
                        h,
                        !0,
                        ImageFormat::Z_PIXMAP.into(),
                        shm.seg,
                        0,
                    )
                    .context("shm_get_image")?
                    .reply()
                    .context("shm_get_image reply")?;
                // Copy out only the bytes this region occupies (packed at w*4);
                // the X server may overwrite the segment on the next grab.
                let len = usize::from(w) * usize::from(h) * 4;
                shm.as_slice()[..len].to_vec()
            }
            Backend::Plain => {
                let reply = self
                    .conn
                    .get_image(
                        ImageFormat::Z_PIXMAP,
                        self.root,
                        x as i16,
                        y as i16,
                        w,
                        h,
                        !0,
                    )
                    .context("get_image")?
                    .reply()
                    .context("get_image reply")?;
                reply.data
            }
        };

        let expected = usize::from(w)
            .checked_mul(usize::from(h))
            .and_then(|pixels| pixels.checked_mul(4))
            .context("X11 image size overflow")?;
        if data.len() != expected {
            bail!(
                "X11 image returned {} bytes for {}x{} BGRA pixels (expected {})",
                data.len(),
                w,
                h,
                expected
            );
        }

        // Depth 24 still arrives as 4 bytes/pixel in Z_PIXMAP on 32-bpp visuals;
        // the unused 4th byte is undefined, so force it opaque for BgrA32.
        if self.depth == 24 {
            for px in data.chunks_exact_mut(4) {
                px[3] = 0xff;
            }
        }

        Ok(Frame::bgra(data, x, y, w, h, usize::from(w) * 4))
    }

    /// Drain all currently-queued `DamageNotify` events. Returns true if at
    /// least one arrived (we don't trust their coordinates — the precise region
    /// comes from `subtract_into_region`; the event is just the wakeup signal).
    pub(super) fn drain_damage_events(&self) -> anyhow::Result<(bool, bool)> {
        let mut damage = false;
        let mut resize = false;
        while let Some(event) = self.conn.poll_for_event().context("poll_for_event")? {
            match event {
                Event::DamageNotify(_) => damage = true,
                Event::RandrScreenChangeNotify(change) if change.root == self.root => {
                    resize = true;
                }
                Event::RandrNotify(_) => resize = true,
                _ => {}
            }
        }
        Ok((damage, resize))
    }

    /// Atomically consume the accumulated damage into our scratch region and
    /// fetch back the exact changed rectangles, clamped to the screen. This is
    /// race-free: any change between the notify and here is folded into the same
    /// subtract, so nothing is cleared without being reported.
    pub(super) fn subtract_into_rects(&self) -> anyhow::Result<Vec<DamageRect>> {
        let Some(d) = &self.damage else {
            return Ok(vec![]);
        };
        // repair = NONE means "report everything"; parts = our region receives
        // the consumed area, which we then fetch.
        self.conn
            .damage_subtract(d.damage, x11rb::NONE, d.region)
            .context("damage_subtract")?;
        let reply = self
            .conn
            .xfixes_fetch_region(d.region)
            .context("xfixes_fetch_region")?
            .reply()
            .context("xfixes_fetch_region reply")?;
        let rects = reply
            .rectangles
            .into_iter()
            .filter_map(|r| DamageRect::from_x_rect(r, self.width, self.height))
            .collect();
        Ok(rects)
    }

    /// Discard any pending damage without capturing (used to reset state after a
    /// full frame so we don't immediately re-send already-covered regions).
    pub(super) fn clear_damage(&self) -> anyhow::Result<()> {
        let _ = self.drain_damage_events()?;
        let _ = self.subtract_into_rects()?;
        Ok(())
    }

    pub(super) fn refresh_geometry(&mut self) -> anyhow::Result<bool> {
        let geometry = self
            .conn
            .get_geometry(self.root)
            .context("get root geometry")?
            .reply()
            .context("get root geometry reply")?;
        let new_width = geometry.width;
        let new_height = geometry.height;
        if !geometry_changed((self.width, self.height), (new_width, new_height)) {
            return Ok(false);
        }
        if new_width == 0 || new_height == 0 {
            bail!("X11 root geometry changed to zero size");
        }
        if let Backend::Shm(shm) = &self.backend {
            let _ = self.conn.shm_detach(shm.seg);
        }
        self.backend = match Self::try_init_shm(&self.conn, new_width, new_height) {
            Ok(shm) => Backend::Shm(shm),
            Err(error) => {
                tracing::warn!(%error, "X11 SHM reallocation failed after resize; using GetImage");
                Backend::Plain
            }
        };
        self.width = new_width;
        self.height = new_height;
        self.depth = geometry.depth;
        if self.damage.is_some() {
            self.clear_damage()?;
        }
        tracing::info!(
            width = new_width,
            height = new_height,
            randr = self.randr,
            "X11 capture geometry changed"
        );
        Ok(true)
    }
}

pub(super) fn geometry_changed(old: (u16, u16), new: (u16, u16)) -> bool {
    old != new
}
