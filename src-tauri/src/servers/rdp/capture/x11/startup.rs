use super::lifetime::X11Capturer;
use super::model::DamageState;
use super::shared_memory::Backend;
use super::shared_memory::ShmBuffer;
use crate::servers::engine::LogEmitter;
use anyhow::Context as _;
use anyhow::bail;
use std::os::unix::io::OwnedFd;
use std::ptr::NonNull;
use x11rb::connection::Connection as _;
use x11rb::connection::RequestConnection as _;
use x11rb::protocol::damage;
use x11rb::protocol::damage::ConnectionExt as _;
use x11rb::protocol::randr;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::shm;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xfixes;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto;
use x11rb::rust_connection::RustConnection;

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

        // Try to set up XDamage so capture can be event-driven and cropped to
        // changed regions. On any failure we log once and fall back to the
        // legacy fixed-interval full-frame path (damage = None).
        let damage = match Self::try_init_damage(&conn, root) {
            Ok(d) => {
                log.line("X11 capture: XDamage active (event-driven, region-cropped)".to_string());
                tracing::info!("X11 capture using XDamage");
                Some(d)
            }
            Err(e) => {
                let msg = format!(
                    "XDamage unavailable ({}); falling back to fixed-interval full-frame capture.",
                    e
                );
                log.line(msg.clone());
                tracing::warn!("X11 capture: {}", msg);
                None
            }
        };
        let randr = match Self::try_init_randr(&conn, root) {
            Ok(()) => {
                log.line("X11 capture: XRandR geometry monitoring active".to_string());
                true
            }
            Err(error) => {
                tracing::warn!(%error, "X11 XRandR monitoring unavailable; geometry is checked during capture");
                false
            }
        };

        Ok(Self {
            conn,
            root,
            width,
            height,
            depth,
            backend,
            damage,
            randr,
        })
    }

    /// Probe the DAMAGE (and XFixes) extensions and, if present, create a
    /// root-window damage object plus a scratch region for race-free subtract.
    /// Returns `Err` (rather than bailing) so the caller can fall back to
    /// interval polling.
    pub(super) fn try_init_damage(
        conn: &RustConnection,
        root: xproto::Window,
    ) -> anyhow::Result<DamageState> {
        if conn
            .extension_information(damage::X11_EXTENSION_NAME)
            .context("querying DAMAGE extension")?
            .is_none()
        {
            bail!("X11 server has no DAMAGE extension");
        }
        if conn
            .extension_information(xfixes::X11_EXTENSION_NAME)
            .context("querying XFIXES extension")?
            .is_none()
        {
            bail!("X11 server has no XFIXES extension (needed for damage regions)");
        }
        // Negotiate versions (also verifies the server actually speaks them).
        // XFixes ≥ 2.0 is required before any XFixes request is allowed.
        conn.xfixes_query_version(5, 0)
            .context("XFIXES query_version")?
            .reply()
            .context("XFIXES query_version reply")?;
        conn.damage_query_version(1, 1)
            .context("DAMAGE query_version")?
            .reply()
            .context("DAMAGE query_version reply")?;

        let damage_id = conn.generate_id().context("generate Damage id")?;
        // NON_EMPTY: the server delivers a single notify when the damage region
        // transitions empty→non-empty (least chatty). The precise multi-rect
        // damage is read back via `damage_subtract` into our region regardless
        // of report level, so we get exact changed rectangles, not a coarse box.
        conn.damage_create(damage_id, root, damage::ReportLevel::NON_EMPTY)
            .context("damage_create")?
            .check()
            .context("damage_create check")?;

        let region = conn.generate_id().context("generate Region id")?;
        conn.xfixes_create_region(region, &[])
            .context("xfixes_create_region")?
            .check()
            .context("xfixes_create_region check")?;

        Ok(DamageState {
            damage: damage_id,
            region,
            last_capture: None,
        })
    }

    pub(super) fn try_init_randr(
        conn: &RustConnection,
        root: xproto::Window,
    ) -> anyhow::Result<()> {
        if conn
            .extension_information(randr::X11_EXTENSION_NAME)
            .context("querying RANDR extension")?
            .is_none()
        {
            bail!("X11 server has no RANDR extension");
        }
        conn.randr_query_version(1, 5)
            .context("RANDR query_version")?
            .reply()
            .context("RANDR query_version reply")?;
        conn.randr_select_input(
            root,
            randr::NotifyMask::SCREEN_CHANGE
                | randr::NotifyMask::CRTC_CHANGE
                | randr::NotifyMask::OUTPUT_CHANGE
                | randr::NotifyMask::RESOURCE_CHANGE,
        )
        .context("RANDR select_input")?
        .check()
        .context("RANDR select_input check")?;
        Ok(())
    }

    /// Probe MIT-SHM and, if usable, allocate the shared segment. Returns `Err`
    /// (rather than panicking or bailing the whole capturer) so the caller can
    /// fall back to plain `GetImage`.
    pub(super) fn try_init_shm(
        conn: &RustConnection,
        width: u16,
        height: u16,
    ) -> anyhow::Result<ShmBuffer> {
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
    pub(super) fn alloc_shm(
        conn: &RustConnection,
        width: u16,
        height: u16,
    ) -> anyhow::Result<ShmBuffer> {
        let len = usize::from(width)
            .checked_mul(usize::from(height))
            .and_then(|p| p.checked_mul(4))
            .context("frame size overflow")?;
        let len_u32 = u32::try_from(len).context("X11 SHM frame exceeds request size limit")?;

        let seg = conn.generate_id().context("generate SHM seg id")?;
        let reply = conn
            .shm_create_segment(seg, len_u32, false)
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
            bail!(
                "mmap of SHM segment failed: {}",
                std::io::Error::last_os_error()
            );
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
