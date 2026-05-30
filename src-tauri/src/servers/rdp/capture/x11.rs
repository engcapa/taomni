//! X11 screen capture using `x11rb`, with a fast path and a safe fallback.
//!
//! Fast path mirrors RustDesk: MIT-SHM (`shm`) — a shared memory segment is
//! allocated once and each frame is a single `shm_get_image` of the root window
//! into that buffer, with no per-frame protocol image transfer. The modern
//! FD-passing `shm_create_segment` needs MIT-SHM ≥ 1.2, which is not available
//! everywhere (older Xorg, some remote/forwarded or sandboxed connections), so
//! when SHM setup fails we fall back to plain `GetImage` (slower — the image
//! travels over the X connection each frame — but always available on a local
//! TrueColor display). Either way the root window's pixels are BGRA on a
//! depth-24/32 visual (little-endian Z_PIXMAP), matching `PixelFormat::BgrA32`.

use std::os::unix::io::OwnedFd;
use std::ptr::NonNull;

use anyhow::{bail, Context as _};
use x11rb::connection::{Connection, RequestConnection as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _, ImageFormat};
use x11rb::rust_connection::RustConnection;

use super::{Capturer, Frame};
use crate::servers::engine::LogEmitter;

/// A mmap'd MIT-SHM segment shared with the X server.
struct ShmBuffer {
    seg: shm::Seg,
    ptr: NonNull<u8>,
    len: usize,
    // Kept alive for the lifetime of the mapping; closed on drop.
    _fd: OwnedFd,
}

impl ShmBuffer {
    fn as_slice(&self) -> &[u8] {
        // SAFETY: `ptr`/`len` come from a successful mmap of a SHM segment of
        // exactly `len` bytes that stays mapped until `Drop`. The X server only
        // writes here during `shm_get_image().reply()`, which we await before
        // reading, so there is no concurrent mutation while this slice lives.
        unsafe { std::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
    }
}

impl Drop for ShmBuffer {
    fn drop(&mut self) {
        // SAFETY: `ptr`/`len` describe the live mapping created in `new`.
        unsafe {
            libc::munmap(self.ptr.as_ptr().cast(), self.len);
        }
    }
}

/// Which grab mechanism the capturer is using.
enum Backend {
    /// MIT-SHM fast path: one shared segment, no per-frame transfer.
    Shm(ShmBuffer),
    /// Plain `GetImage`: image travels over the X connection each frame.
    Plain,
}

pub(crate) struct X11Capturer {
    conn: RustConnection,
    root: xproto::Window,
    width: u16,
    height: u16,
    depth: u8,
    backend: Backend,
}

impl X11Capturer {
    pub(crate) fn new(log: &LogEmitter) -> anyhow::Result<Self> {
        let (conn, screen_num) =
            x11rb::connect(None).context("cannot connect to X11 display (is DISPLAY set?)")?;

        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let width = screen.width_in_pixels;
        let height = screen.height_in_pixels;
        let depth = screen.root_depth;

        if depth != 24 && depth != 32 {
            log.line(format!(
                "WARNING: X11 root depth is {} (expected 24/32); colors may be wrong",
                depth
            ));
        }

        // Try the MIT-SHM fast path; on any failure fall back to plain GetImage
        // rather than giving up (which would surface the synthetic placeholder).
        let backend = match Self::try_init_shm(&conn, width, height) {
            Ok(shm) => {
                log.line(format!(
                    "X11 capture ready: {}x{} depth {} (MIT-SHM)",
                    width, height, depth
                ));
                tracing::info!(%width, %height, depth, "X11 capture using MIT-SHM");
                Backend::Shm(shm)
            }
            Err(e) => {
                // Mirror to BOTH the UI log panel and tracing/stdout so the
                // reason is visible wherever the operator is looking.
                let msg = format!(
                    "MIT-SHM unavailable ({}); falling back to plain GetImage (slower).",
                    e
                );
                log.line(msg.clone());
                tracing::warn!("X11 capture: {}", msg);
                Backend::Plain
            }
        };

        Ok(Self {
            conn,
            root,
            width,
            height,
            depth,
            backend,
        })
    }

    /// Probe MIT-SHM and, if usable, allocate the shared segment. Returns `Err`
    /// (rather than panicking or bailing the whole capturer) so the caller can
    /// fall back to plain `GetImage`.
    fn try_init_shm(conn: &RustConnection, width: u16, height: u16) -> anyhow::Result<ShmBuffer> {
        if conn
            .extension_information(shm::X11_EXTENSION_NAME)
            .context("querying SHM extension")?
            .is_none()
        {
            bail!("X11 server has no MIT-SHM extension");
        }
        // `shm_create_segment` (FD passing) needs MIT-SHM >= 1.2. Check the
        // version so we fail fast on old servers instead of erroring mid-request.
        let ver = conn
            .shm_query_version()
            .context("SHM query_version")?
            .reply()
            .context("SHM query_version reply")?;
        if (ver.major_version, ver.minor_version) < (1, 2) {
            bail!(
                "MIT-SHM {}.{} too old for fd-passing (need >= 1.2)",
                ver.major_version,
                ver.minor_version
            );
        }
        Self::alloc_shm(conn, width, height)
    }

    /// Allocate a SHM segment sized for one BGRA frame and mmap it into our
    /// address space, sharing the same fd with the X server.
    fn alloc_shm(conn: &RustConnection, width: u16, height: u16) -> anyhow::Result<ShmBuffer> {
        let len = usize::from(width)
            .checked_mul(usize::from(height))
            .and_then(|p| p.checked_mul(4))
            .context("frame size overflow")?;

        let seg = conn.generate_id().context("generate SHM seg id")?;
        let reply = conn
            .shm_create_segment(seg, len as u32, false)
            .context("shm_create_segment")?
            .reply()
            .context("shm_create_segment reply")?;
        let fd = OwnedFd::from(reply.shm_fd);

        // SAFETY: mmap a shared, readable/writable view of the segment fd of
        // exactly `len` bytes. We check for MAP_FAILED before constructing the
        // NonNull. The mapping outlives `fd` (kept in ShmBuffer) and is unmapped
        // in Drop.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                std::os::unix::io::AsRawFd::as_raw_fd(&fd),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            // Detach the segment we just created before bailing.
            let _ = conn.shm_detach(seg);
            bail!("mmap of SHM segment failed: {}", std::io::Error::last_os_error());
        }
        let ptr = NonNull::new(ptr.cast::<u8>()).context("mmap returned null")?;

        Ok(ShmBuffer {
            seg,
            ptr,
            len,
            _fd: fd,
        })
    }
}

impl Drop for X11Capturer {
    fn drop(&mut self) {
        // Detach the SHM segment from the X server (no-op for the plain backend).
        // The local mapping is freed by ShmBuffer::drop.
        if let Backend::Shm(shm) = &self.backend {
            let _ = self.conn.shm_detach(shm.seg);
            let _ = self.conn.flush();
        }
    }
}

impl Capturer for X11Capturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        let mut data = match &self.backend {
            Backend::Shm(shm) => {
                // Pull the whole root window into the shared segment in one request.
                self.conn
                    .shm_get_image(
                        self.root,
                        0,
                        0,
                        self.width,
                        self.height,
                        !0,
                        ImageFormat::Z_PIXMAP.into(),
                        shm.seg,
                        0,
                    )
                    .context("shm_get_image")?
                    .reply()
                    .context("shm_get_image reply")?;
                // Copy out of the shared buffer (the X server may overwrite it on
                // the next capture).
                shm.as_slice().to_vec()
            }
            Backend::Plain => {
                // Image data travels over the X connection in the reply.
                let reply = self
                    .conn
                    .get_image(
                        ImageFormat::Z_PIXMAP,
                        self.root,
                        0,
                        0,
                        self.width,
                        self.height,
                        !0,
                    )
                    .context("get_image")?
                    .reply()
                    .context("get_image reply")?;
                reply.data
            }
        };

        // Depth 24 still arrives as 4 bytes/pixel in Z_PIXMAP on 32-bpp visuals;
        // the unused 4th byte is undefined, so force it opaque for BgrA32.
        if self.depth == 24 {
            for px in data.chunks_exact_mut(4) {
                px[3] = 0xff;
            }
        }

        Ok(Frame {
            data,
            width: self.width,
            height: self.height,
            stride: usize::from(self.width) * 4,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runtime smoke test: only meaningful with a reachable X11 display. Skips
    /// cleanly (passes) when DISPLAY is unset or the server has no MIT-SHM, so
    /// CI on headless boxes does not fail. When a display IS present it proves
    /// the full SHM grab path end to end and sanity-checks the frame geometry.
    #[test]
    fn x11_capture_produces_a_frame_when_display_present() {
        if std::env::var_os("DISPLAY").is_none() {
            eprintln!("skipping: no DISPLAY");
            return;
        }
        // We need a LogEmitter, which requires an AppHandle we don't have in a
        // unit test. Exercise the connection + SHM path directly instead.
        let (conn, screen_num) = match x11rb::connect(None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("skipping: cannot connect to X11: {e}");
                return;
            }
        };
        if conn
            .extension_information(shm::X11_EXTENSION_NAME)
            .ok()
            .flatten()
            .is_none()
        {
            eprintln!("skipping: no MIT-SHM");
            return;
        }
        let screen = &conn.setup().roots[screen_num];
        let (w, h) = (screen.width_in_pixels, screen.height_in_pixels);
        assert!(w > 0 && h > 0, "screen size should be positive");

        let shm = X11Capturer::alloc_shm(&conn, w, h).expect("alloc shm");
        let _reply = shm::get_image(
            &conn,
            screen.root,
            0,
            0,
            w,
            h,
            !0,
            ImageFormat::Z_PIXMAP.into(),
            shm.seg,
            0,
        )
        .expect("shm_get_image request")
        .reply()
        .expect("shm_get_image reply");

        let data = shm.as_slice();
        assert_eq!(
            data.len(),
            usize::from(w) * usize::from(h) * 4,
            "BGRA buffer length matches geometry"
        );
        let _ = conn.shm_detach(shm.seg);
    }

    /// The plain `GetImage` fallback must produce a correctly-sized BGRA frame
    /// on any local TrueColor display, independent of MIT-SHM. This exercises
    /// the path taken when SHM setup fails (the cause of the placeholder
    /// rainbow). Skips when no DISPLAY is reachable.
    #[test]
    fn plain_get_image_fallback_produces_a_frame() {
        if std::env::var_os("DISPLAY").is_none() {
            eprintln!("skipping: no DISPLAY");
            return;
        }
        let (conn, screen_num) = match x11rb::connect(None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("skipping: cannot connect to X11: {e}");
                return;
            }
        };
        let screen = &conn.setup().roots[screen_num];
        let mut cap = X11Capturer {
            root: screen.root,
            width: screen.width_in_pixels,
            height: screen.height_in_pixels,
            depth: screen.root_depth,
            backend: Backend::Plain,
            conn,
        };
        let frame = cap.capture().expect("plain GetImage capture");
        assert_eq!(frame.width, cap.width);
        assert_eq!(frame.height, cap.height);
        assert_eq!(
            frame.data.len(),
            usize::from(frame.width) * usize::from(frame.height) * 4,
            "BGRA frame length matches geometry"
        );
        assert_eq!(frame.stride, usize::from(frame.width) * 4);
    }
}

