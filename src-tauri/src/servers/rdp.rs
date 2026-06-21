//! Real in-process RDP server built on `ironrdp-server` 0.10 (`ironrdp::server`).
//!
//! This is the SERVER half of RDP — it shares *this* machine's desktop with an
//! RDP client (mstsc, FreeRDP, Remote Desktop mobile). It is the mirror image of
//! the RDP *client* in `crate::rdp` (which connects out to a Windows host); the
//! two share the IronRDP umbrella but use opposite halves (`server`/`acceptor`
//! vs `connector`/`session`) and keep entirely separate state.
//!
//! Like [`super::ssh`], this is an in-process pure-Rust server (not an external
//! daemon like [`super::vnc`]), so `ServerStarted.pid` is `None`. It is NOT an
//! OS/PAM gateway: credentials are validated against the server config, never
//! against system accounts.
//!
//! Server-specific config (`config.extra`, camelCase as sent by the frontend):
//!   - `username`     (string) RDP username clients must present
//!   - `password`     (string) RDP password clients must present
//!   - `domain`       (string) optional NLA domain
//!   - `viewOnly`     (bool)   ignore client keyboard/mouse input (default false)
//!   - `securityMode` (string) "tls" | "hybrid" (NLA, default) | "none" (insecure)
//!
//! ## Security
//!
//! Default mode is `hybrid` (NLA/CredSSP over TLS), which mstsc requires out of
//! the box. `tls` offers TLS without NLA; `none` is plain unencrypted RDP for
//! diagnostics only. TLS uses a self-signed cert cached in app-data (see
//! [`tls`]). Credentials are mandatory except in `none` mode, where a loud
//! warning is logged — mirroring [`super::ssh`]'s refusal to run wide open and
//! [`super::vnc`]'s `-nopw` warning.
//!
//! ## Cancel bridge (the one new integration step vs `ssh.rs`)
//!
//! `RdpServer::run()` owns its own accept loop and is not aware of `ctx.cancel`.
//! It does, however, expose `event_sender()`: sending [`ServerEvent::Quit`] makes
//! the loop break cleanly the next time it is idle on the listener. We spawn a
//! small bridge task that forwards `ctx.cancel` → `ServerEvent::Quit`, and also
//! race `run()` against the cancel token as a hard backstop for the case where a
//! client connection is mid-flight when stop is requested.

use std::net::SocketAddr;

use ironrdp::server::{Credentials, DesktopSize, RdpServer, ServerEvent, TlsIdentityCtx};
use tokio_util::sync::CancellationToken;

use super::engine::{LogEmitter, ServerCtx, ServerStarted};
use super::ServerConfig;

mod auth;
/// Screen-capture backends (X11 / Wayland). Exposed crate-wide so the LanChat
/// native A/V stack can reuse the X11 capturer for screen sharing.
pub(crate) mod capture;
mod clipboard;
mod diff;
mod display;
mod input;
mod session;
mod tls;

use auth::AuthConfig;
use clipboard::ClipboardFactory;
use display::RdpDisplay;
use input::RdpInput;

/// How the listening socket is secured.
///   - `Hybrid` — NLA/CredSSP over TLS (mstsc's default; recommended).
///   - `Tls` — TLS without NLA (FreeRDP `/sec:tls`).
///   - `None` — plain RDP security, no encryption (FreeRDP `/sec:rdp`; insecure,
///     for diagnostics only).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SecurityMode {
    None,
    Tls,
    Hybrid,
}

impl SecurityMode {
    fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "none" | "rdp" | "insecure" => SecurityMode::None,
            "tls" => SecurityMode::Tls,
            // Default to NLA/CredSSP — the only thing mstsc accepts out of the box.
            _ => SecurityMode::Hybrid,
        }
    }
}

pub async fn start(ctx: ServerCtx, config: ServerConfig) -> Result<ServerStarted, String> {
    let port = if config.port == 0 { 3389 } else { config.port };
    let bind = config.bind_address.clone();

    let view_only = config.bool_field("viewOnly", false);
    let security = SecurityMode::parse(config.str_field("securityMode", "hybrid"));

    // Credentials are mandatory unless explicitly running the insecure `none`
    // mode for diagnostics (where there is no CredSSP to check them anyway).
    let auth = AuthConfig::from_fields(
        config.str_field("username", ""),
        config.str_field("password", ""),
        config.str_field("domain", ""),
    );
    let auth = match (security, auth) {
        (_, Ok(a)) => Some(a),
        (SecurityMode::None, Err(_)) => {
            ctx.log.line(
                "WARNING: RDP server starting with NO security and NO credentials — anyone \
                 who can reach this port gets full control of this desktop. Use only on a \
                 trusted, isolated network.",
            );
            None
        }
        (_, Err(e)) => return Err(e),
    };

    // Resolve the bind address to a concrete SocketAddr up front so a bad
    // address surfaces as a startup error rather than inside the spawned task.
    let addr: SocketAddr = format!("{}:{}", bind, port)
        .parse()
        .map_err(|e| format!("invalid RDP bind address {}:{} — {}", bind, port, e))?;

    // Probe-bind the port so "address already in use" / privilege errors surface
    // as a startup Error. Small TOCTOU window before IronRDP binds for real —
    // acceptable for a developer tool, same tradeoff as `iperf.rs`.
    match std::net::TcpListener::bind(addr) {
        Ok(probe) => drop(probe),
        Err(e) => return Err(format!("cannot bind {} for RDP — {}", addr, e)),
    }

    if bind == "0.0.0.0" || bind == "::" {
        ctx.log.line(
            "WARNING: RDP server is bound to all interfaces — anyone who can reach this \
             port may attempt to connect. Restrict the bind address or firewall the port.",
        );
    }

    // For TLS/Hybrid, generate (or load) the self-signed identity up front so a
    // cert/key failure surfaces as a startup Error rather than inside the thread.
    let identity = match security {
        SecurityMode::None => {
            ctx.log.line(
                "NOTE: securityMode='none' — traffic is unencrypted. Connect with FreeRDP \
                 `/sec:rdp`. mstsc requires NLA; use the default 'hybrid' mode for it.",
            );
            None
        }
        SecurityMode::Tls | SecurityMode::Hybrid => {
            let id = tls::identity(&ctx.app).map_err(|e| format!("RDP TLS setup failed: {}", e))?;
            ctx.log
                .line("loaded self-signed TLS certificate (clients will see a trust warning)");
            Some(id)
        }
    };

    let size = DesktopSize {
        width: 1920,
        height: 1080,
    };

    // Phase 7 (Linux advanced): independent/headless virtual sessions. The base
    // server mirrors the current console desktop; when the user asks for a
    // virtual session we report what the host can actually do rather than
    // silently falling back to the console mirror.
    if config.bool_field("headlessSession", false) {
        let caps = session::probe();
        ctx.log.line(format!(
            "headless/virtual session requested — {}. This build mirrors the current \
             console desktop; per-session virtual displays (xrdp model) are not yet a live \
             gateway. Sharing the console desktop instead.",
            caps.summary()
        ));
    }

    ctx.log.line(format!(
        "RDP server listening on {} ({}x{}, {:?} security, {})",
        addr,
        size.width,
        size.height,
        security,
        if view_only {
            "view-only"
        } else {
            "interactive"
        }
    ));

    let params = ServerParams {
        addr,
        size,
        view_only,
        security,
        identity,
        credentials: auth.as_ref().map(AuthConfig::to_credentials),
    };
    let task = spawn_server(params, ctx.cancel.clone(), ctx.log.clone());
    Ok(ServerStarted { pid: None, task })
}

/// Everything the server thread needs to build and run the [`RdpServer`].
struct ServerParams {
    addr: SocketAddr,
    size: DesktopSize,
    view_only: bool,
    security: SecurityMode,
    identity: Option<TlsIdentityCtx>,
    credentials: Option<Credentials>,
}

/// Drive `RdpServer::run()` and bridge `cancel` → clean shutdown.
///
/// `RdpServer` and its `run()` future are `!Send` (they hold `Rc` internally),
/// so they cannot live on Tauri's multi-threaded Tokio runtime via
/// `tokio::spawn`. Instead we own a dedicated OS thread running a
/// `current_thread` runtime — mirroring the official example's
/// `#[tokio::main(flavor = "current_thread")]` — and build the server *inside*
/// that thread. The returned [`JoinHandle`] is an async wrapper that waits for
/// that thread to finish, so the registry's `task.abort()` plus the `cancel`
/// token both tear it down cleanly.
fn spawn_server(
    params: ServerParams,
    cancel: CancellationToken,
    log: LogEmitter,
) -> tokio::task::JoinHandle<()> {
    let thread = std::thread::Builder::new()
        .name("rdp-server".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    log.line(format!("RDP server: failed to start runtime: {}", e));
                    return;
                }
            };

            rt.block_on(async move {
                let mut server = match build_server(&params, &log) {
                    Ok(s) => s,
                    Err(e) => {
                        log.line(format!("RDP server: {}", e));
                        return;
                    }
                };
                if let Some(creds) = params.credentials.clone() {
                    server.set_credentials(Some(creds));
                }

                // Grab the event sender before moving `server`: sending Quit
                // makes the accept loop break the next time it is idle. The
                // bridge future is `Send` (only a token + sender), so plain
                // `tokio::spawn` works even on this current-thread runtime.
                let ev_sender = server.event_sender().clone();
                let bridge = {
                    let cancel = cancel.clone();
                    tokio::spawn(async move {
                        cancel.cancelled().await;
                        let _ = ev_sender.send(ServerEvent::Quit("server stopped".to_string()));
                    })
                };

                tokio::select! {
                    res = server.run() => {
                        if let Err(e) = res {
                            log.line(format!("RDP server error: {}", e));
                        }
                    }
                    // Hard backstop guaranteeing the thread exits (and the join
                    // wrapper completes) even if a client connection is
                    // mid-flight when stop is requested — otherwise the Quit
                    // event would not be processed until run_connection returns.
                    _ = cancel.cancelled() => {}
                }

                bridge.abort();
                log.line("RDP server stopped");
            });
        });

    let handle = match thread {
        Ok(h) => h,
        Err(e) => {
            // Spawn failed: return a no-op completed task so the caller's
            // JoinHandle contract still holds.
            return tokio::spawn(async move {
                let _ = e;
            });
        }
    };

    // Bridge the std thread join into an async JoinHandle the registry can hold.
    tokio::task::spawn_blocking(move || {
        let _ = handle.join();
    })
}

/// Assemble the [`RdpServer`] for the requested security mode. Each branch
/// produces a different builder type (the builder is a typestate machine), so
/// the input/display/build tail is repeated per branch.
fn build_server(params: &ServerParams, log: &LogEmitter) -> anyhow::Result<RdpServer> {
    let input = RdpInput::new(log.clone(), params.view_only);
    let display = RdpDisplay::new(log.clone(), params.size);
    let cliprdr: Box<dyn ironrdp::server::CliprdrServerFactory> =
        Box::new(ClipboardFactory::new(log.clone()));

    let base = RdpServer::builder().with_addr(params.addr);

    let server = match params.security {
        SecurityMode::None => base
            .with_no_security()
            .with_input_handler(input)
            .with_display_handler(display)
            .with_cliprdr_factory(Some(cliprdr))
            .build(),
        SecurityMode::Tls => {
            let identity = params
                .identity
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("TLS identity missing"))?;
            let acceptor = identity.make_acceptor()?;
            base.with_tls(acceptor)
                .with_input_handler(input)
                .with_display_handler(display)
                .with_cliprdr_factory(Some(cliprdr))
                .build()
        }
        SecurityMode::Hybrid => {
            let identity = params
                .identity
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("TLS identity missing"))?;
            let acceptor = identity.make_acceptor()?;
            base.with_hybrid(acceptor, identity.pub_key.clone())
                .with_input_handler(input)
                .with_display_handler(display)
                .with_cliprdr_factory(Some(cliprdr))
                .build()
        }
    };
    Ok(server)
}
