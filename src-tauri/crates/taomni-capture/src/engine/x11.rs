//! X11 screen capture using `x11rb`, with an event-driven fast path and safe
//! fallbacks, mirroring how RustDesk/NoMachine keep latency and idle CPU low.
//!
//! Three things stack here:
//!
//! 1. **Grab mechanism** — MIT-SHM (`shm`): a shared memory segment is allocated
//!    once and each grab is a single `shm_get_image` into that buffer, with no
//!    per-frame protocol image transfer. The modern FD-passing
//!    `shm_create_segment` needs MIT-SHM ≥ 1.2, which is not available
//!    everywhere (older Xorg, some remote/forwarded or sandboxed connections),
//!    so when SHM setup fails we fall back to plain `GetImage` (the image travels
//!    over the X connection each frame — slower, but always available on a local
//!    TrueColor display).
//!
//! 2. **Change detection** — the XDamage extension. Instead of polling the whole
//!    screen on a fixed interval and hashing 8 MB to ask "did anything change?",
//!    we let the X server tell us *when* and *where* it changed. A `Damage`
//!    object on the root window (report level `BoundingBox`) delivers a
//!    `DamageNotify` whose `area` is the bounding box of what changed. Idle ⇒ no
//!    events ⇒ zero readback, zero hashing, zero CPU. When DAMAGE is missing we
//!    fall back to the legacy fixed-interval full-frame path (`is_event_driven()`
//!    stays false and the display layer adds its own interval + dedup).
//!
//! 3. **Region cropping** — we read back and send only the damaged bounding box,
//!    not the whole screen. The IronRDP encoder diffs that sub-rectangle against
//!    its framebuffer and RemoteFX-encodes only the changed tiles, so a small
//!    on-screen change costs O(changed area), not O(screen). The first frame of
//!    each connection is always full so the encoder's framebuffer is seeded.
//!
//! Either grab path yields BGRA on a depth-24/32 visual (little-endian
//! Z_PIXMAP), matching `PixelFormat::BgrA32`.

mod limits;

mod shared_memory;

mod model;

mod lifetime;

mod startup;

mod damage;

#[cfg(test)]
mod tests;

pub(crate) use lifetime::X11Capturer;
