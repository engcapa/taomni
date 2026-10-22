use super::mailbox::LatestFrameMailbox;
use super::updates::DisplayUpdatesImpl;
#[cfg(target_os = "linux")]
use super::warmup_linux::start_warmed_linux_capture;
#[cfg(target_os = "macos")]
use super::warmup_macos::start_warmed_macos_capture;
#[cfg(target_os = "windows")]
use super::warmup_windows::start_warmed_windows_capture;
use crate::servers::engine::LogEmitter;
#[cfg(target_os = "linux")]
use crate::servers::rdp::capture::PortalInput;
#[cfg(target_os = "macos")]
use crate::servers::rdp::gfx::GfxTransport;
use crate::servers::rdp::metrics::RdpMetrics;
use async_trait::async_trait;
use ironrdp::server::DesktopSize;
use ironrdp::server::RdpServerDisplay;
use ironrdp::server::RdpServerDisplayUpdates;
use std::sync::Arc;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU32;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
#[cfg(target_os = "linux")]
use std::sync::mpsc::SyncSender;
#[cfg(target_os = "macos")]
use std::time::Duration;
#[cfg(target_os = "macos")]
use tokio::sync::oneshot;

/// Display handler handed to the IronRDP builder. Probes the capture backend to
/// learn the real desktop size, falling back to the configured default.
pub(crate) struct RdpDisplay {
    pub(super) log: LogEmitter,
    pub(super) metrics: RdpMetrics,
    /// Desktop size reported to the client. Set from the capture backend when
    /// available, else the fallback size passed in at construction.
    pub(super) size: DesktopSize,
    /// Windows capture is warmed before the listener accepts clients. This
    /// avoids creating a native capture object during post-auth display
    /// activation and guarantees a static desktop has a first frame.
    #[cfg(target_os = "windows")]
    pub(super) mailbox: Arc<LatestFrameMailbox>,
    /// macOS capture is warmed before the listener becomes ready and remains
    /// alive across client authentication. This removes ScreenCaptureKit setup
    /// from the post-login critical path.
    #[cfg(target_os = "macos")]
    pub(super) mailbox: Arc<LatestFrameMailbox>,
    #[cfg(target_os = "macos")]
    pub(super) gfx: GfxTransport,
    #[cfg(target_os = "macos")]
    pub(super) resize_tx: std::sync::mpsc::Sender<CaptureResizeRequest>,
    #[cfg(target_os = "macos")]
    pub(super) supports_client_size: bool,
    #[cfg(target_os = "macos")]
    pub(super) input_surface_size: Arc<AtomicU32>,
    /// Linux capture is also warmed before the listener starts. For Wayland
    /// this keeps the portal grant and PipeWire stream alive across RDP login;
    /// for X11 it avoids opening a second X connection per client.
    #[cfg(target_os = "linux")]
    pub(super) mailbox: Arc<LatestFrameMailbox>,
    #[cfg(target_os = "linux")]
    pub(super) portal_input: Option<std::sync::mpsc::SyncSender<PortalInput>>,
}

#[cfg(target_os = "macos")]
pub(super) const CAPTURE_RESIZE_TIMEOUT: Duration = Duration::from_secs(7);

#[cfg(target_os = "macos")]
pub(super) struct CaptureResizeRequest {
    pub(super) size: DesktopSize,
    pub(super) result: oneshot::Sender<Result<DesktopSize, String>>,
}

impl RdpDisplay {
    pub(crate) fn new(
        log: LogEmitter,
        display_id: Option<String>,
        metrics: RdpMetrics,
        view_only: bool,
        #[cfg(target_os = "macos")] gfx: GfxTransport,
    ) -> anyhow::Result<Self> {
        #[cfg(target_os = "windows")]
        let _ = view_only;

        #[cfg(target_os = "macos")]
        let (size, mailbox, resize_tx, supports_client_size) =
            start_warmed_macos_capture(log.clone(), display_id.clone(), metrics.clone())?;

        #[cfg(target_os = "linux")]
        let (size, mailbox, portal_input) = start_warmed_linux_capture(
            log.clone(),
            display_id.clone(),
            metrics.clone(),
            !view_only,
        )?;

        #[cfg(target_os = "macos")]
        let input_surface_size = Arc::new(AtomicU32::new(pack_desktop_size(size)));

        #[cfg(target_os = "windows")]
        let (size, mailbox) =
            start_warmed_windows_capture(log.clone(), display_id.clone(), metrics.clone())?;

        // Keep size() honest for the client on every native warm-up path.
        Ok(Self {
            log,
            metrics,
            size,
            #[cfg(target_os = "windows")]
            mailbox,
            #[cfg(target_os = "macos")]
            mailbox,
            #[cfg(target_os = "macos")]
            gfx,
            #[cfg(target_os = "macos")]
            resize_tx,
            #[cfg(target_os = "macos")]
            supports_client_size,
            #[cfg(target_os = "macos")]
            input_surface_size,
            #[cfg(target_os = "linux")]
            mailbox,
            #[cfg(target_os = "linux")]
            portal_input,
        })
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn desktop_size(&self) -> DesktopSize {
        self.size
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn input_surface_size(&self) -> Arc<AtomicU32> {
        self.input_surface_size.clone()
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn supports_client_size(&self) -> bool {
        self.supports_client_size
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn portal_input(&self) -> Option<std::sync::mpsc::SyncSender<PortalInput>> {
        self.portal_input.clone()
    }
}

#[cfg(target_os = "macos")]
pub(super) fn pack_desktop_size(size: DesktopSize) -> u32 {
    (u32::from(size.width) << 16) | u32::from(size.height)
}

#[async_trait]
impl RdpServerDisplay for RdpDisplay {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    #[cfg(target_os = "macos")]
    async fn request_initial_size(&mut self, client_size: DesktopSize) -> DesktopSize {
        if !self.supports_client_size || client_size == self.size {
            return self.size;
        }

        let (result_tx, result_rx) = oneshot::channel();
        if self
            .resize_tx
            .send(CaptureResizeRequest {
                size: client_size,
                result: result_tx,
            })
            .is_err()
        {
            self.log
                .line("macOS capture resize channel closed; keeping physical display size");
            return self.size;
        }

        match tokio::time::timeout(CAPTURE_RESIZE_TIMEOUT, result_rx).await {
            Ok(Ok(Ok(size))) => {
                self.size = size;
                self.input_surface_size
                    .store(pack_desktop_size(size), Ordering::Relaxed);
                self.log.line(format!(
                    "macOS capture resized for RDP client: {}x{}",
                    size.width, size.height
                ));
                size
            }
            Ok(Ok(Err(error))) => {
                self.log.line(format!(
                    "macOS capture could not adopt client size; keeping {}x{}: {error}",
                    self.size.width, self.size.height
                ));
                self.size
            }
            Ok(Err(_)) => {
                self.log
                    .line("macOS capture resize response closed; keeping physical display size");
                self.size
            }
            Err(_) => {
                self.log.line(format!(
                    "macOS capture resize exceeded {}ms; keeping physical display size",
                    CAPTURE_RESIZE_TIMEOUT.as_millis()
                ));
                self.size
            }
        }
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        self.log.line("client requested display stream");
        #[cfg(target_os = "macos")]
        {
            // Authentication may finish while the desktop is static and
            // ScreenCaptureKit is emitting only idle markers. Replay the
            // retained complete frame rather than waiting for a future change.
            self.mailbox.replay_latest_full();
            return Ok(Box::new(DisplayUpdatesImpl::from_warmed_capture(
                self.mailbox.clone(),
                self.size,
                self.metrics.clone(),
                self.gfx.clone(),
            )));
        }

        #[cfg(target_os = "linux")]
        {
            self.mailbox.replay_latest_full();
            return Ok(Box::new(DisplayUpdatesImpl::from_warmed_linux_capture(
                self.mailbox.clone(),
                self.size,
                self.metrics.clone(),
            )));
        }

        #[cfg(target_os = "windows")]
        {
            self.mailbox.replay_latest_full();
            Ok(Box::new(DisplayUpdatesImpl::from_warmed_windows_capture(
                self.mailbox.clone(),
                self.size,
                self.metrics.clone(),
            )))
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for RdpDisplay {
    fn drop(&mut self) {
        self.mailbox.close();
    }
}

#[cfg(target_os = "linux")]
impl Drop for RdpDisplay {
    fn drop(&mut self) {
        self.mailbox.close();
    }
}

#[cfg(target_os = "windows")]
impl Drop for RdpDisplay {
    fn drop(&mut self) {
        self.mailbox.close();
    }
}
