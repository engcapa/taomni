//! JVM-free HBase shell client over the HBase REST/Stargate API.
//!
//! This module intentionally does not call `hbase shell`, `sqlline`, JDBC, or a
//! helper process. The frontend sends HBase-shell-like commands, we parse the
//! small command language here, and each operation is translated into REST API
//! calls against an HBase-compatible endpoint such as Stargate/Lindorm REST.
//!
//! The `native` submodule provides an alternative transport that speaks the
//! native RegionServer/Master RPC protocol directly (bootstrapped via
//! ZooKeeper), for clusters that do not expose a REST gateway.

use self::configuration::build_session;
use self::configuration::parse_hbase_site_xml;
use self::native_commands::native_describe_table;
use self::native_commands::native_execute;
use self::native_commands::native_list_tables;
use self::rest_catalog::describe_table;
use self::rest_catalog::list_tables;
use self::rest_http::ping_session;
use self::rest_operations::execute_command;
use self::shell_parser::parse_shell_command;
use self::thrift_commands::thrift_describe_table;
use self::thrift_commands::thrift_execute;
use self::thrift_commands::thrift_list_tables;
use crate::state::AppState;
pub use model::{
    HBaseColumnFamily, HBaseConfig, HBaseConnectResult, HBaseSession, HBaseSessionInner,
    HBaseShellResult, HBaseTableInfo, HBaseTableSchema,
};
pub use rest_session::RestSession;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;
use tauri::State;
mod configuration;
mod model;
mod native_commands;
mod rest_catalog;
mod rest_http;
mod rest_operations;
mod rest_session;
mod shell_parser;
mod shell_results;
mod thrift_commands;

#[cfg(test)]
mod tests;

pub mod native;
pub mod thrift;

#[tauri::command]
pub async fn hbase_connect(
    state: State<'_, AppState>,
    session_id: String,
    config: HBaseConfig,
) -> Result<HBaseConnectResult, String> {
    let password = resolve_secret(&state, config.password.as_deref())?;
    let session_inner = build_session(&config, password).await?;
    ping_backend(&session_inner).await?;
    let session = Arc::new(HBaseSession {
        inner: session_inner,
        cancel: tokio::sync::Mutex::new(tokio_util::sync::CancellationToken::new()),
    });
    let mut map = state.database.hbase_sessions.write().await;
    map.insert(session_id, session);
    Ok(HBaseConnectResult { ok: true })
}

#[tauri::command]
pub async fn hbase_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    let mut guard = session.cancel.lock().await;
    guard.cancel();
    *guard = tokio_util::sync::CancellationToken::new();
    Ok(())
}

#[tauri::command]
pub async fn hbase_ping(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    ping_backend(&session.inner).await
}

#[tauri::command]
pub async fn hbase_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    state
        .database
        .hbase_sessions
        .write()
        .await
        .remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn hbase_parse_site_xml(path: String) -> Result<BTreeMap<String, String>, String> {
    parse_hbase_site_xml(&path)
}

#[tauri::command]
pub async fn hbase_parse_keytab_principal(path: String) -> Result<String, String> {
    let data = std::fs::read(&path).map_err(|e| format!("Failed to read keytab file: {e}"))?;

    if data.len() < 2 {
        return Err("Truncated keytab file".into());
    }

    let version = u16::from_be_bytes([data[0], data[1]]);
    if version != 0x0502 && version != 0x0501 {
        return Err(format!("Unsupported keytab version: 0x{:04x}", version));
    }

    let mut cursor = 2;
    while cursor < data.len() {
        if cursor + 4 > data.len() {
            break;
        }
        let size = i32::from_be_bytes([
            data[cursor],
            data[cursor + 1],
            data[cursor + 2],
            data[cursor + 3],
        ]);
        cursor += 4;

        if size < 0 {
            cursor += (-size) as usize;
            continue;
        }
        if size == 0 {
            break;
        }

        let entry_end = cursor + size as usize;
        if entry_end > data.len() {
            break;
        }

        if cursor + 2 > entry_end {
            break;
        }
        let num_components = u16::from_be_bytes([data[cursor], data[cursor + 1]]);
        cursor += 2;

        if cursor + 2 > entry_end {
            break;
        }
        let realm_len = u16::from_be_bytes([data[cursor], data[cursor + 1]]) as usize;
        cursor += 2;
        if cursor + realm_len > entry_end {
            break;
        }
        let realm = String::from_utf8_lossy(&data[cursor..cursor + realm_len]).into_owned();
        cursor += realm_len;

        let mut components = Vec::new();
        let mut component_parse_failed = false;
        for _ in 0..num_components {
            if cursor + 2 > entry_end {
                component_parse_failed = true;
                break;
            }
            let comp_len = u16::from_be_bytes([data[cursor], data[cursor + 1]]) as usize;
            cursor += 2;
            if cursor + comp_len > entry_end {
                component_parse_failed = true;
                break;
            }
            let comp = String::from_utf8_lossy(&data[cursor..cursor + comp_len]).into_owned();
            cursor += comp_len;
            components.push(comp);
        }

        if component_parse_failed {
            break;
        }

        if !components.is_empty() {
            let principal = format!("{}@{}", components.join("/"), realm);
            return Ok(principal);
        }

        cursor = entry_end;
    }

    Err("No principal found in keytab".into())
}

async fn run_cancellable<F, T>(
    cancel_mutex: &tokio::sync::Mutex<tokio_util::sync::CancellationToken>,
    future: F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let token = {
        let mut guard = cancel_mutex.lock().await;
        if guard.is_cancelled() {
            *guard = tokio_util::sync::CancellationToken::new();
        }
        guard.clone()
    };
    tokio::select! {
        res = future => res,
        _ = token.cancelled() => Err("Operation cancelled".to_string()),
    }
}

#[tauri::command]
pub async fn hbase_list_tables(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<HBaseTableInfo>, String> {
    let session = get_session(&state, &session_id).await?;
    let fut = async {
        match &session.inner {
            HBaseSessionInner::Rest(rest) => list_tables(rest).await,
            HBaseSessionInner::Native(client) => native_list_tables(client).await,
            HBaseSessionInner::Thrift(t) => thrift_list_tables(t).await,
        }
    };
    run_cancellable(&session.cancel, fut).await
}

#[tauri::command]
pub async fn hbase_describe_table(
    state: State<'_, AppState>,
    session_id: String,
    table: String,
) -> Result<HBaseTableSchema, String> {
    let session = get_session(&state, &session_id).await?;
    let fut = async {
        match &session.inner {
            HBaseSessionInner::Rest(rest) => describe_table(rest, &table).await,
            HBaseSessionInner::Native(client) => native_describe_table(client, &table).await,
            HBaseSessionInner::Thrift(t) => thrift_describe_table(t, &table).await,
        }
    };
    run_cancellable(&session.cancel, fut).await
}

#[tauri::command]
pub async fn hbase_execute(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<HBaseShellResult, String> {
    let session = get_session(&state, &session_id).await?;
    let parsed = parse_shell_command(&command)?;
    let started = Instant::now();
    let raw = command.trim().to_string();
    let fut = async {
        let mut result = match &session.inner {
            HBaseSessionInner::Rest(rest) => execute_command(rest, parsed, raw).await?,
            HBaseSessionInner::Native(client) => native_execute(client, parsed, raw).await?,
            HBaseSessionInner::Thrift(t) => thrift_execute(t, parsed, raw).await?,
        };
        result.duration_ms = started.elapsed().as_millis() as u64;
        Ok(result)
    };
    run_cancellable(&session.cancel, fut).await
}

/// Ping whichever backend the session uses.
async fn ping_backend(session: &HBaseSessionInner) -> Result<String, String> {
    match session {
        HBaseSessionInner::Rest(rest) => ping_session(rest).await,
        HBaseSessionInner::Native(client) => client.ping().await.map_err(|e| e.to_string()),
        HBaseSessionInner::Thrift(t) => t.ping().await,
    }
}

fn resolve_secret(
    state: &State<'_, AppState>,
    value: Option<&str>,
) -> Result<Option<String>, String> {
    match value {
        Some(v) if !v.is_empty() => match state.vault.resolve(v)? {
            Some(z) => Ok(Some((*z).clone())),
            None => Ok(Some(v.to_string())),
        },
        _ => Ok(None),
    }
}

async fn get_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<Arc<HBaseSession>, String> {
    state
        .database
        .hbase_sessions
        .read()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("No active HBase shell session for {session_id}"))
}

#[cfg(all(test, feature = "hbase-kerberos"))]
mod kerberos_live_tests;

#[cfg(test)]
mod native_shell_live_tests;
