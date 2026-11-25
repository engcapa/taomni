//! Window-free entry. This module never creates a Tauri Builder or AppHandle.
use super::Core;
use crate::state::AppState;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

pub fn initialize(data: &Path) -> Result<AppState, String> {
    let config = crate::ai::config::AiConfig::load(&crate::ai::config::default_ai_config_path());
    initialize_with_config(data, config)
}

pub(super) fn initialize_with_config(
    data: &Path,
    config: crate::ai::config::AiConfig,
) -> Result<AppState, String> {
    crate::runtime::bootstrap::isolated_state(data, config)
}
fn argument(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}
pub fn run() -> i32 {
    super::headless_ops::initialize();
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => match rt.block_on(serve()) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("Headless: {e}");
                1
            }
        },
        Err(_) => {
            eprintln!("Cannot initialize headless runtime");
            1
        }
    }
}
async fn serve() -> Result<(), String> {
    let custom_data = argument("--data-dir");
    let data = match custom_data.as_ref() {
        Some(p) => PathBuf::from(p),
        None => dirs::data_dir()
            .ok_or("No application data directory")?
            .join("com.taomni.app"),
    };
    let port = argument("--mobile-port")
        .unwrap_or_else(|| "8787".into())
        .parse::<u16>()
        .map_err(|_| "Invalid port")?;
    let lan = std::env::args().any(|a| a == "--mobile-lan");
    let paths = crate::runtime::paths::ProfilePaths::headless(&data, custom_data.is_some())?;
    let boot = crate::runtime::bootstrap::bootstrap(
        paths,
        crate::runtime::profile::StartupMode::Headless,
        None,
        custom_data.is_none(),
    )
    .map_err(|error| error.to_string())?;
    let state = Arc::new(boot.state);
    let runtime = boot.runtime;
    runtime.start();
    let result = serve_state(&state, &runtime, &data, lan, port).await;
    let shutdown = runtime.shutdown(&state).await;
    if let Err(error) = &shutdown {
        tracing::warn!(%error, "Headless plugin termination was not confirmed");
    }
    result.and(shutdown)
}

async fn serve_state(
    state: &Arc<AppState>,
    runtime: &crate::runtime::ApplicationRuntime,
    data: &PathBuf,
    lan: bool,
    port: u16,
) -> Result<(), String> {
    let address = state
        .legacy
        .mobile
        .start(Core::Headless(state.clone()), data.clone(), lan, port)
        .await?;
    // Explicit operator-facing stdout, never tracing/log files. Codes rotate on
    // expiry and can be requested with SIGHUP on Unix without restarting work.
    println!("Mobile endpoint: {address}");
    println!(
        "Pairing code (5 minutes): {}",
        state
            .legacy
            .mobile
            .auth
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pairing_code()
    );
    if std::env::args().any(|a| a == "--feishu") {
        let config = super::im_adapter::Config::load(&data)?;
        let secret = super::headless_ops::secret(std::env::var("TAOMNI_FEISHU_APP_SECRET").ok())?;
        state
            .legacy
            .mobile
            .im
            .start(Core::Headless(state.clone()), config, secret)
            .await?;
    }
    let mut observer = super::headless_ops::observe(state.legacy.mobile.clone());
    let observer_cancel = runtime.tasks.cancellation();
    runtime.tasks.spawn("headless-observer", async move {
        tokio::select! {
            _ = observer_cancel.cancelled() => { observer.abort(); let _ = observer.await; },
            _ = &mut observer => {}
        }
    });
    let mobile = state.legacy.mobile.clone();
    let cancel = runtime.tasks.cancellation();
    runtime.tasks.spawn("headless-pairing-rotation", async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {
                    println!("Pairing code (5 minutes): {}", mobile.auth.lock().unwrap_or_else(|e| e.into_inner()).pairing_code());
                }
            }
        }
    });
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .map_err(|e| e.to_string())?;
        let mut hup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
            .map_err(|e| e.to_string())?;
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => break,
                _ = term.recv() => break,
                _ = hup.recv() => println!("Pairing code (5 minutes): {}", state.legacy.mobile.auth.lock().unwrap_or_else(|e| e.into_inner()).pairing_code()),
            }
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
    Ok(())
}
