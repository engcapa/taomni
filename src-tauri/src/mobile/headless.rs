//! Window-free entry. This module never creates a Tauri Builder or AppHandle.
use super::Core;
use crate::state::AppState;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// Desktop instances share this lock; a headless process owns it exclusively.
/// ProfileLease independently protects backup/restore operations.
pub struct ModeLease(std::fs::File);
impl ModeLease {
    pub fn acquire(data: &Path, headless: bool) -> Result<Self, String> {
        std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(data.join(".mobile-mode.lock"))
            .map_err(|e| e.to_string())?;
        let result = if headless {
            file.try_lock()
        } else {
            file.try_lock_shared()
        };
        result.map_err(|_| "Close the other Taomni mode using this profile first")?;
        Ok(Self(file))
    }
}
impl Drop for ModeLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub fn initialize(data: &Path) -> Result<AppState, String> {
    let config = crate::ai::config::AiConfig::load(&crate::ai::config::default_ai_config_path());
    initialize_with_config(data, config)
}

pub(super) fn initialize_with_config(
    data: &Path,
    config: crate::ai::config::AiConfig,
) -> Result<AppState, String> {
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    let db = rusqlite::Connection::open(data.join("taomni.db")).map_err(|e| e.to_string())?;
    crate::session::db::init_db(&db).map_err(|e| e.to_string())?;
    crate::terminal::local_directories::init_tables(&db).map_err(|e| e.to_string())?;
    crate::servers::db::init_server_tables(&db).map_err(|e| e.to_string())?;
    crate::rdp::tls::init_trust_table(&db).map_err(|e| e.to_string())?;
    let notes = rusqlite::Connection::open(data.join("notes.db")).map_err(|e| e.to_string())?;
    crate::notes::init_db(&notes).map_err(|e| e.to_string())?;
    let vault =
        Arc::new(crate::vault::Vault::open(&data.join("vault.db")).map_err(|e| e.to_string())?);
    let ai = crate::ai::AppAiCtx::from_config_with_proxy_db(config, vault.clone(), Some(&db));
    let mail = data.join("mail-cache");
    std::fs::create_dir_all(&mail).map_err(|e| e.to_string())?;
    Ok(AppState::new(
        db,
        notes,
        Arc::new(crate::mfa::store::MfaStore::new(data.join("mfa.db"))),
        mail,
        vault,
        ai,
        Arc::new(crate::lanchat::LanChatState::new(data)),
    ))
}
fn argument(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}
pub fn run() -> i32 {
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
    let data = match argument("--data-dir") {
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
    let _mode = ModeLease::acquire(&data, true)?;
    let _profile = crate::backup::coordination::ProfileLease::prepare(&data)?;
    let state = Arc::new(initialize(&data)?);
    let address = state
        .mobile
        .start(Core::Headless(state.clone()), data, lan, port)
        .await?;
    // Explicit operator-facing stdout, never tracing/log files. Codes rotate on
    // expiry and can be requested with SIGHUP on Unix without restarting work.
    println!("Mobile endpoint: {address}");
    println!(
        "Pairing code (5 minutes): {}",
        state.mobile.auth.lock().unwrap().pairing_code()
    );
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
                _ = hup.recv() => println!("Pairing code (5 minutes): {}", state.mobile.auth.lock().unwrap().pairing_code()),
            }
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await.map_err(|e| e.to_string())?;
    state.mobile.stop().await;
    let runs = std::mem::take(&mut *state.agent.chat_runs.lock().await);
    for (_, run) in runs {
        run.stop().await;
    }
    Ok(())
}
