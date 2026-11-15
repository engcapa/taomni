use std::os::unix::io::OwnedFd;
use std::ptr::NonNull;
use x11rb::protocol::shm;

/// A mmap'd MIT-SHM segment shared with the X server.
pub(super) struct ShmBuffer {
    pub(super) seg: shm::Seg,
    pub(super) ptr: NonNull<u8>,
    pub(super) len: usize,
    // Kept alive for the lifetime of the mapping; closed on drop.
    pub(super) _fd: OwnedFd,
}

impl ShmBuffer {
    pub(super) fn as_slice(&self) -> &[u8] {
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
pub(super) enum Backend {
    /// MIT-SHM fast path: one shared segment, no per-frame transfer.
    Shm(ShmBuffer),
    /// Plain `GetImage`: image travels over the X connection each frame.
    Plain,
}
