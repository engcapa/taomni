//! Fetch / import / cache GFWList rule sources.

use super::gfwlist::{CompiledRules, GfwListMeta};
use std::path::{Path, PathBuf};

fn raw_path(dir: &Path) -> PathBuf {
    dir.join("gfwlist.raw")
}
fn meta_path(dir: &Path) -> PathBuf {
    dir.join("gfwlist.meta.json")
}

/// Load previously cached raw payload and recompile.
pub fn load_cached(dir: &Path) -> Option<CompiledRules> {
    let raw = std::fs::read_to_string(raw_path(dir)).ok()?;
    let meta = GfwListMeta::load(&meta_path(dir));
    let source = meta
        .as_ref()
        .map(|m| m.source.clone())
        .unwrap_or_else(|| "cache".into());
    let mut compiled = CompiledRules::compile(&raw, &source).ok()?;
    if let Some(m) = meta {
        // Preserve last_refresh/etag from disk meta when recompiling.
        compiled.meta.last_refresh = m.last_refresh;
        compiled.meta.etag = m.etag;
        compiled.meta.source = m.source;
    }
    Some(compiled)
}

fn persist(dir: &Path, raw: &str, compiled: &CompiledRules) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(raw_path(dir), raw).map_err(|e| format!("write gfwlist.raw: {e}"))?;
    compiled.meta.save(&meta_path(dir))?;
    Ok(())
}

/// Download from URL, compile, and write cache.
pub async fn refresh_from_url(url: &str, dir: &Path) -> Result<CompiledRules, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("gfwlist url is empty".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("fetch gfwlist: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch gfwlist: HTTP {}", resp.status()));
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read gfwlist body: {e}"))?;
    let mut compiled = CompiledRules::compile(&body, url)?;
    compiled.meta.etag = etag;
    persist(dir, &body, &compiled)?;
    Ok(compiled)
}

/// Import from a local file (base64 gfwlist or plain AutoProxy).
pub fn import_from_path(path: &Path, dir: &Path) -> Result<CompiledRules, String> {
    let body = std::fs::read_to_string(path).map_err(|e| format!("read rules file: {e}"))?;
    let source = format!("file:{}", path.display());
    let compiled = CompiledRules::compile(&body, &source)?;
    persist(dir, &body, &compiled)?;
    Ok(compiled)
}
