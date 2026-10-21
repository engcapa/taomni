use super::session::DbHandle;
use super::session::get_session;
use crate::database::redis_ops;
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

// ---------------------------------------------------------------------------
// Tauri commands — Redis
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct RedisKeyEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// TTL in seconds: -1 = persistent, -2 = missing, else seconds remaining.
    pub ttl: i64,
}

#[derive(Debug, Serialize)]
pub struct RedisScanPage {
    pub cursor: String,
    pub keys: Vec<RedisKeyEntry>,
}

#[derive(Debug, Serialize)]
pub struct RedisValue {
    /// "string" | "hash" | "list" | "set" | "zset" | "stream" | "none".
    pub kind: String,
    /// JSON-encoded value whose shape depends on `kind`. Strings → JSON string;
    /// hashes/zsets → array of [field,value]; lists/sets → array of strings;
    /// streams → array of {id, fields}.
    pub value: serde_json::Value,
    pub ttl: i64,
    pub encoding: Option<String>,
    #[serde(rename = "memoryUsage")]
    pub memory_usage: Option<i64>,
}

#[tauri::command]
pub async fn redis_list_keys(
    state: State<'_, AppState>,
    session_id: String,
    pattern: String,
    cursor: String,
    count: u64,
) -> Result<RedisScanPage, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::list_keys(conn, &pattern, &cursor, count).await,
        _ => Err("redis_list_keys requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_get_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> Result<RedisValue, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::get_key(conn, &key).await,
        _ => Err("redis_get_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_set_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
    kind: String,
    value: serde_json::Value,
    ttl: Option<i64>,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::set_key(conn, &key, &kind, value, ttl).await,
        _ => Err("redis_set_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_del_key(
    state: State<'_, AppState>,
    session_id: String,
    key: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::del_key(conn, &key).await,
        _ => Err("redis_del_key requires a Redis session".into()),
    }
}

#[tauri::command]
pub async fn redis_exec(
    state: State<'_, AppState>,
    session_id: String,
    raw_command: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id).await?;
    match &session.handle {
        DbHandle::Redis(conn) => redis_ops::exec(conn, &raw_command).await,
        _ => Err("redis_exec requires a Redis session".into()),
    }
}
