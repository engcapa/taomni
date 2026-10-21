use super::injection::apply;
#[cfg(target_os = "macos")]
use super::macos::MacInputMapping;
#[cfg(target_os = "macos")]
use super::macos::MacMouse;
#[cfg(target_os = "macos")]
use super::permissions::control_permission_granted;
#[cfg(target_os = "linux")]
use super::portal::input_cmd_to_portal;
use super::queue::InputQueue;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::ControlGate;
#[cfg(target_os = "linux")]
use crate::servers::rdp::capture::PortalInput;
use crate::servers::rdp::metrics::RdpMetrics;
use enigo::Enigo;
use enigo::Settings;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Instant;

/// RDP server input handler.
///
/// `Enigo` is **not `Send`** on macOS (it holds a `CGEventSource`, a thread-affine
/// `NonNull` pointer), yet `RdpServerInputHandler: Send` and `ironrdp-server`
/// actually moves the handler onto `spawn_blocking` worker threads. Wrapping the
/// `Enigo` in a `Mutex` does *not* help — `Mutex<T>: Send` still requires
/// `T: Send`. So instead of holding the `Enigo` directly, we own it on a single
/// dedicated thread (the actor) and keep only an [`InputQueue`] here.
/// `InputQueue` is `Send`, which makes `RdpInput`
/// `Send` uniformly across platforms — no `unsafe impl Send`, no per-OS `cfg`.
/// As a bonus, all CGEvent posting happens on one consistent thread.
pub(crate) struct RdpInput {
    pub(super) log: LogEmitter,
    pub(super) view_only: bool,
    /// `None` if enigo failed to initialize (no display / no permission) or the
    /// actor thread has exited; we log once and then silently drop input.
    pub(super) tx: Option<InputQueue>,
    pub(super) warned: bool,
    pub(super) control_gate: Option<std::sync::Arc<ControlGate>>,
    pub(super) metrics: RdpMetrics,
}

impl RdpInput {
    pub(crate) fn new(
        log: LogEmitter,
        view_only: bool,
        control_gate: Option<std::sync::Arc<ControlGate>>,
        metrics: RdpMetrics,
        #[cfg(target_os = "linux")] portal_tx: Option<mpsc::SyncSender<PortalInput>>,
        #[cfg(target_os = "macos")] mapping: Option<MacInputMapping>,
    ) -> Self {
        let tx = if view_only {
            None
        } else {
            Self::spawn_actor(
                &log,
                metrics.clone(),
                #[cfg(target_os = "linux")]
                portal_tx,
                #[cfg(target_os = "macos")]
                mapping,
            )
        };
        Self {
            log,
            view_only,
            tx,
            warned: false,
            control_gate,
            metrics,
        }
    }

    /// Spawn the dedicated input thread that owns the `Enigo`. Returns the
    /// command sender, or `None` if enigo could not be initialized (no display
    /// / no accessibility permission) — in which case the connection stays
    /// view-only. `Enigo::new` runs *inside* the thread because the resulting
    /// value is `!Send` on macOS and so cannot be constructed here and moved in.
    pub(super) fn spawn_actor(
        log: &LogEmitter,
        metrics: RdpMetrics,
        #[cfg(target_os = "linux")] portal_tx: Option<mpsc::SyncSender<PortalInput>>,
        #[cfg(target_os = "macos")] mapping: Option<MacInputMapping>,
    ) -> Option<InputQueue> {
        let tx = InputQueue::new();
        let rx = tx.clone();
        // Bootstrap channel: the thread reports back whether `Enigo::new`
        // succeeded so `new()` can decide view-only vs interactive synchronously.
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let actor_log = log.clone();

        let spawned = std::thread::Builder::new()
            .name("rdp-input".to_string())
            .spawn(move || {
                let settings = Settings {
                    #[cfg(target_os = "macos")]
                    open_prompt_to_get_permissions: false,
                    ..Settings::default()
                };
                #[cfg(target_os = "linux")]
                let mut enigo = if portal_tx.is_some() {
                    None
                } else {
                    match Enigo::new(&settings) {
                        Ok(e) => Some(e),
                        Err(e) => {
                            let _ = ready_tx.send(Err(e.to_string()));
                            return;
                        }
                    }
                };
                #[cfg(not(target_os = "linux"))]
                let mut enigo = match Enigo::new(&settings) {
                    Ok(e) => e,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e.to_string()));
                        return;
                    }
                };
                #[cfg(target_os = "macos")]
                let mut mac_mouse = match mapping
                    .ok_or_else(|| "macOS input display mapping is unavailable".to_string())
                    .and_then(MacMouse::new)
                {
                    Ok(mouse) => mouse,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                drop(ready_tx);
                #[cfg(target_os = "macos")]
                let mut permission_checked_at = Instant::now();

                // Drain commands until the server drops the queue on shutdown.
                while let Some(queued) = rx.recv() {
                    metrics.record_input_handoff(queued.received_at);
                    #[cfg(target_os = "macos")]
                    if permission_checked_at.elapsed() >= std::time::Duration::from_secs(1) {
                        if !control_permission_granted() {
                            actor_log.line(
                                "input injection stopped: macOS Accessibility permission was revoked",
                            );
                            rx.close();
                            break;
                        }
                        permission_checked_at = Instant::now();
                    }
                    #[cfg(target_os = "linux")]
                    let result = if let Some(portal_tx) = &portal_tx {
                        input_cmd_to_portal(queued.cmd)
                            .ok_or_else(|| "unsupported input command for Wayland portal".to_string())
                            .and_then(|input| {
                                portal_tx
                                    .send(input)
                                    .map_err(|_| "Wayland portal input channel closed".to_string())
                            })
                    } else {
                        match enigo.as_mut() {
                            Some(enigo) => apply(
                                enigo,
                                #[cfg(target_os = "macos")]
                                &mut mac_mouse,
                                queued.cmd,
                            ),
                            None => Err("input backend was not initialized".to_string()),
                        }
                    };
                    #[cfg(not(target_os = "linux"))]
                    let result = apply(
                        &mut enigo,
                        #[cfg(target_os = "macos")]
                        &mut mac_mouse,
                        queued.cmd,
                    );
                    if let Err(error) = result {
                        actor_log.line(format!("input injection stopped: {error}"));
                        rx.close();
                        break;
                    }
                    metrics.report_if_due();
                }
            });

        if let Err(e) = spawned {
            log.line(format!(
                "input injection unavailable (cannot start input thread: {e}); connection will be view-only"
            ));
            return None;
        }

        match ready_rx.recv() {
            Ok(Ok(())) => Some(tx),
            Ok(Err(e)) => {
                log.line(format!(
                    "input injection unavailable ({e}); connection will be view-only"
                ));
                None
            }
            Err(_) => {
                // Thread died before reporting — treat as unavailable.
                log.line("input injection unavailable (input thread exited during init); connection will be view-only");
                None
            }
        }
    }

    pub(super) fn warn_if_missing(&mut self) {
        if !self.view_only && self.tx.is_none() && !self.warned {
            self.warned = true;
            self.log.line("input dropped: no injection backend");
        }
    }
}

impl Drop for RdpInput {
    fn drop(&mut self) {
        if let Some(tx) = &self.tx {
            tx.close();
        }
    }
}
