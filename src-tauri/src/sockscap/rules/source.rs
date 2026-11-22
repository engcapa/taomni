//! Fetch / import / cache GFWList rule sources.

use super::GfwListMeta;
use std::path::{Path, PathBuf};
use taomni_sockscap_api::gfwlist_rules::RuleCache;

fn raw_path(dir: &Path) -> PathBuf {
    dir.join("gfwlist.raw")
}
fn meta_path(dir: &Path) -> PathBuf {
    dir.join("gfwlist.meta.json")
}

pub(in crate::sockscap) fn load_legacy(dir: &Path) -> Option<RuleCache> {
    let raw = std::fs::read_to_string(raw_path(dir)).ok()?;
    let meta = GfwListMeta::load(&meta_path(dir)).unwrap_or_else(|| GfwListMeta {
        source: "cache".into(),
        rule_count: 0,
        skipped: 0,
        last_refresh: None,
        etag: None,
    });
    Some(RuleCache { raw, meta })
}

pub(in crate::sockscap) fn save_legacy(dir: &Path, cache: &RuleCache) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(raw_path(dir), &cache.raw).map_err(|e| format!("write gfwlist.raw: {e}"))?;
    cache.meta.save(&meta_path(dir))
}

/// Download using the existing desktop network path.
pub(in crate::sockscap) async fn fetch(url: &str) -> Result<(String, Option<String>), String> {
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
    Ok((body, etag))
}
