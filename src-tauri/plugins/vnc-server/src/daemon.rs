//! Locate and supervise the installed VNC server for the current platform.

#[cfg(any(target_os = "linux", target_os = "windows"))]
use taomni_server_process::spawn_supervised;
use taomni_server_process::{Log, Started, vnc::Config};
use tokio_util::sync::CancellationToken;

pub async fn start(config: Config, cancel: CancellationToken, log: Log) -> Result<Started, String> {
    let port = if config.port == 0 { 5900 } else { config.port };

    #[cfg(target_os = "linux")]
    {
        start_linux(config, port, cancel, log).await
    }

    #[cfg(target_os = "macos")]
    {
        let _ = (config, port);
        start_macos(cancel, log).await
    }

    #[cfg(target_os = "windows")]
    {
        start_windows(config, port, cancel, log).await
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (config, cancel, log, port);
        Err("VNC server is not supported on this platform".to_string())
    }
}

#[cfg(target_os = "linux")]
async fn start_linux(
    config: Config,
    port: u16,
    cancel: CancellationToken,
    log: Log,
) -> Result<Started, String> {
    if which::which("x11vnc").is_err() {
        return Err(
            "x11vnc not found in PATH — install it to share this desktop over VNC \
             (e.g. `apt install x11vnc`). x11vnc also requires a running X display."
                .to_string(),
        );
    }

    let view_only = config.view_only;
    let shared = config.shared_desktop;
    let password = config.password;
    let bind = config.bind_address.clone();

    let mut args: Vec<String> = vec![
        "-rfbport".into(),
        port.to_string(),
        // Keep serving after the first client disconnects.
        "-forever".into(),
    ];
    // Restrict the listening interface when the user picked a specific address.
    if !bind.is_empty() && bind != "0.0.0.0" && bind != "::" {
        args.push("-listen".into());
        args.push(bind.clone());
    }
    if shared {
        args.push("-shared".into());
    }
    if view_only {
        args.push("-viewonly".into());
    }
    if !password.is_empty() {
        // `-passwd` sets a plaintext runtime password (not stored to disk).
        args.push("-passwd".into());
        args.push(password);
    } else {
        // No password configured: x11vnc refuses some setups without this, and
        // it makes the "no auth" decision explicit rather than accidental.
        args.push("-nopw".into());
        log("WARNING: starting x11vnc with no password — anyone who can reach this port can view/control the desktop".into());
    }

    log(format!("starting x11vnc on {}:{}", bind, port));
    spawn_supervised("x11vnc", args, cancel, log).await
}

#[cfg(target_os = "macos")]
async fn start_macos(_: CancellationToken, log: Log) -> Result<Started, String> {
    // The built-in ARDAgent / Screen Sharing service cannot be started from the
    // CLI in a way we can supervise. Be honest about it.
    let msg = "macOS VNC must be enabled via System Settings > General > Sharing > \
               Screen Sharing (or Remote Management). Taomni cannot start it for you.";
    log(msg.into());
    Err(msg.to_string())
}

#[cfg(target_os = "windows")]
async fn start_windows(
    config: Config,
    port: u16,
    cancel: CancellationToken,
    log: Log,
) -> Result<Started, String> {
    let _ = &config;
    // Try common standalone VNC servers that expose a CLI.
    let program = if which::which("winvnc").is_ok() {
        "winvnc"
    } else if which::which("tvnserver").is_ok() {
        "tvnserver"
    } else {
        return Err(
            "No VNC server found in PATH. Install a VNC server such as TightVNC \
             (tvnserver) or UltraVNC (winvnc), or enable it via its own settings."
                .to_string(),
        );
    };

    // tvnserver runs as a foreground app with -run; winvnc launches its tray app.
    let args: Vec<String> = match program {
        "tvnserver" => vec!["-run".into()],
        _ => Vec::new(),
    };
    log(format!(
        "starting {} (VNC) — listening port is configured in the server's own settings \
         (requested {}:{})",
        program, config.bind_address, port
    ));
    spawn_supervised(program, args, cancel, log).await
}
