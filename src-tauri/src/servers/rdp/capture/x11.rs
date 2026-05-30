//! X11 screen capture via the MIT-SHM (`shm`) extension, using `x11rb`.
//!
//! Mirrors RustDesk's X11 path (XShm rather than plain `XGetImage`): a shared
//! memory segment is allocated once, and each frame is a single `shm_get_image`
//! of the root window directly into that buffer — no per-frame X protocol image
//! transfer. The root window's pixels are already BGRA on a depth-24/32
//! TrueColor visual (little-endian Z_PIXMAP), matching `PixelFormat::BgrA32`.

use std::os::unix::io::OwnedFd;
use std::ptr::NonNull;

use anyhow::{bail, Context as _};
use x11rb::connection::{Connection, RequestConnection as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{self, ImageFormat};
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

pub(crate) struct X11Capturer {
    conn: RustConnection,
    root: xproto::Window,
    width: u16,
    height: u16,
    depth: u8,
    shm: ShmBuffer,
}

impl X11Capturer {
    pub(crate) fn new(log: &LogEmitter) -> anyhow::Result<Self> {
        let (conn, screen_num) =
            x11rb::connect(None).context("cannot connect to X11 display (is DISPLAY set?)")?;

        // MIT-SHM must be present for the fast path.
        if conn
            .extension_information(shm::X11_EXTENSION_NAME)
            .context("querying SHM extension")?
            .is_none()
        {
            bail!("X11 server has no MIT-SHM extension — cannot capture efficiently");
        }
        let _ = conn.shm_query_version().context("SHM query_version")?.reply();

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

        let shm = Self::alloc_shm(&conn, width, height)?;

        log.line(format!(
            "X11 capture ready: {}x{} depth {} (MIT-SHM)",
            width, height, depth
        ));

        Ok(Self {
            conn,
            root,
            width,
            height,
            depth,
            shm,
        })
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
        // Detach the SHM segment from the X server. The local mapping is freed
        // by ShmBuffer::drop.
        let _ = self.conn.shm_detach(self.shm.seg);
        let _ = self.conn.flush();
    }
}

impl Capturer for X11Capturer {
    fn desktop_size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    fn capture(&mut self) -> anyhow::Result<Frame> {
        // Pull the whole root window into the shared segment in one request.
        let _reply = self
            .conn
            .shm_get_image(
                self.root,
                0,
                0,
                self.width,
                self.height,
                !0,
                ImageFormat::Z_PIXMAP.into(),
                self.shm.seg,
                0,
            )
            .context("shm_get_image")?
            .reply()
            .context("shm_get_image reply")?;

        // Copy out of the shared buffer (the X server may overwrite it on the
        // next capture). Depth 24 still arrives as 4 bytes/pixel in Z_PIXMAP on
        // 32-bpp visuals; the unused byte becomes alpha, which we force opaque.
        let mut data = self.shm.as_slice().to_vec();
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
}

