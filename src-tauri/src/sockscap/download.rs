//! Rule-source downloader with last-good retention (plan §6.1, §6.2, §16.3).
//!
//! Pipeline: download → integrity check → decode → parse/project → compile →
//! atomic replace. Any failure keeps the previous last-good compiled snapshot.
//! Partial `unsupported` rules do *not* block an update; a base64/structure
//! failure does (plan §16.3-12). The built-in GFWList source rotates across a
//! set of healthy official mirrors; a user-supplied Bitbucket URL is kept only
//! as provenance and falls back on 404 (plan §6.1, §16.3-10).
//!
//! The pure processing/state functions here are unit-tested without network;
//! the async fetch is a thin reqwest layer over them.

use sha2::{Digest, Sha256};

use super::autoproxy::{self, ProjectionStats, UnsupportedRule};
use super::matcher::CompiledRuleSource;
use super::SockscapError;

/// Healthy official GFWList mirrors, tried in order (plan §6.1, §16.3-10). The
/// Bitbucket URL the user historically used returns 404 and is intentionally
/// not a default.
pub const GFWLIST_MIRRORS: &[&str] = &[
    "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt",
    "https://gitlab.com/gfwlist/gfwlist/raw/master/gfwlist.txt",
    "https://repo.or.cz/gfwlist.git/blob_plain/HEAD:/gfwlist.txt",
];

/// Network limits applied to every fetch (plan §6.2).
#[derive(Debug, Clone)]
pub struct DownloadLimits {
    pub timeout_secs: u64,
    pub max_bytes: usize,
    pub max_redirects: usize,
}

impl Default for DownloadLimits {
    fn default() -> Self {
        DownloadLimits {
            timeout_secs: 30,
            max_bytes: 8 * 1024 * 1024,
            max_redirects: 5,
        }
    }
}

/// Raw bytes fetched from one mirror, plus caching metadata.
#[derive(Debug, Clone)]
pub struct RawDownload {
    pub url: String,
    pub bytes: Vec<u8>,
    pub etag: Option<String>,
    pub sha256: String,
}

/// A compiled, ready-to-serve rule-source snapshot with its provenance.
pub struct CompiledSnapshot {
    pub source_id: String,
    pub compiled: CompiledRuleSource,
    pub stats: ProjectionStats,
    /// Capped sample of unsupported lines for the UI (plan §6.2).
    pub unsupported_examples: Vec<UnsupportedRule>,
    pub sha256: String,
    pub mirror_url: String,
    /// Unix seconds of the successful compile.
    pub last_good_at: i64,
}

/// Live state for one rule source: the current last-good snapshot plus the
/// outcome of the most recent attempt.
#[derive(Default)]
pub struct RuleSourceState {
    pub current: Option<CompiledSnapshot>,
    pub last_error: Option<String>,
    pub last_attempt_at: i64,
    pub last_etag: Option<String>,
}

impl RuleSourceState {
    /// Replace the last-good snapshot on a successful compile. `etag`, when
    /// present, is retained for the next conditional GET.
    pub fn apply_success(&mut self, snap: CompiledSnapshot, etag: Option<String>, now: i64) {
        if etag.is_some() {
            self.last_etag = etag;
        }
        self.last_error = None;
        self.last_attempt_at = now;
        self.current = Some(snap);
    }

    /// Record a failure without disturbing the current last-good snapshot.
    pub fn apply_failure(&mut self, err: impl Into<String>, now: i64) {
        self.last_error = Some(err.into());
        self.last_attempt_at = now;
    }

    pub fn has_snapshot(&self) -> bool {
        self.current.is_some()
    }
}

/// Hex-encoded SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// How many unsupported examples to keep for the UI.
const UNSUPPORTED_SAMPLE_CAP: usize = 25;

/// Decode → parse → compile a downloaded document into a snapshot. Fails (and
/// thus keeps last-good) on base64/structure errors or a document that yields
/// zero usable rules; partial unsupported lines are tolerated.
pub fn process_document(
    source_id: &str,
    bytes: &[u8],
    mirror_url: &str,
    now: i64,
) -> Result<CompiledSnapshot, SockscapError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| SockscapError::Decode(format!("utf8: {e}")))?;
    let projection = autoproxy::parse(text)?;
    if projection.rules.is_empty() {
        return Err(SockscapError::Integrity(
            "document produced zero usable rules".into(),
        ));
    }
    let sha256 = sha256_hex(bytes);
    let compiled = projection.compile(source_id);
    let mut unsupported_examples = projection.unsupported.clone();
    unsupported_examples.truncate(UNSUPPORTED_SAMPLE_CAP);
    Ok(CompiledSnapshot {
        source_id: source_id.to_string(),
        compiled,
        stats: projection.stats,
        unsupported_examples,
        sha256,
        mirror_url: mirror_url.to_string(),
        last_good_at: now,
    })
}

/// Fetch the first healthy mirror, applying limits and conditional GET. Returns
/// `Ok(None)` when the server answers `304 Not Modified`. On error, every
/// mirror was tried and failed — the caller keeps last-good.
pub async fn fetch_first_healthy(
    urls: &[String],
    limits: &DownloadLimits,
    if_none_match: Option<&str>,
) -> Result<Option<RawDownload>, SockscapError> {
    if urls.is_empty() {
        return Err(SockscapError::Download("no mirror urls configured".into()));
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(limits.timeout_secs))
        .redirect(reqwest::redirect::Policy::limited(limits.max_redirects))
        .build()
        .map_err(|e| SockscapError::Download(format!("client build: {e}")))?;

    let mut last_err = String::new();
    for url in urls {
        match fetch_one(&client, url, limits, if_none_match).await {
            Ok(outcome) => return Ok(outcome),
            Err(e) => {
                tracing::warn!("sockscap: rule-source mirror {url} failed: {e}");
                last_err = e;
            }
        }
    }
    Err(SockscapError::Download(format!(
        "all {} mirror(s) failed; last error: {last_err}",
        urls.len()
    )))
}

async fn fetch_one(
    client: &reqwest::Client,
    url: &str,
    limits: &DownloadLimits,
    if_none_match: Option<&str>,
) -> Result<Option<RawDownload>, String> {
    use futures::StreamExt as _;

    let mut req = client.get(url);
    if let Some(etag) = if_none_match {
        req = req.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let resp = req.send().await.map_err(|e| format!("request: {e}"))?;

    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status()));
    }

    // Reject over-large bodies up front when the server advertises the size.
    if let Some(len) = resp.content_length() {
        if len as usize > limits.max_bytes {
            return Err(format!("content-length {len} exceeds cap {}", limits.max_bytes));
        }
    }
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Stream and cap to defend against a missing/mismatched content-length.
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("body: {e}"))?;
        if bytes.len() + chunk.len() > limits.max_bytes {
            return Err(format!("body exceeds cap {}", limits.max_bytes));
        }
        bytes.extend_from_slice(&chunk);
    }
    let sha256 = sha256_hex(&bytes);
    Ok(Some(RawDownload {
        url: url.to_string(),
        bytes,
        etag,
        sha256,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    fn encode(doc: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .encode(doc.as_bytes())
            .into_bytes()
    }

    #[test]
    fn process_compiles_base64_gfwlist() {
        let doc = "[AutoProxy 0.2.9]\n||google.com\n@@||cache.google.com\n";
        let snap = process_document("gfwlist-official", &encode(doc), GFWLIST_MIRRORS[0], 100).unwrap();
        assert_eq!(snap.stats.domain_rules, 1);
        assert_eq!(snap.stats.exception_rules, 1);
        assert_eq!(snap.compiled.domain_len(), 2);
        assert_eq!(snap.last_good_at, 100);
    }

    #[test]
    fn process_rejects_garbage_but_keeps_last_good() {
        let mut state = RuleSourceState::default();
        // Seed a good snapshot.
        let good = process_document("s", &encode("||example.com\n"), "u", 1).unwrap();
        state.apply_success(good, None, 1);
        assert!(state.has_snapshot());

        // A broken document must not replace the good snapshot.
        let msg = match process_document("s", b"\xff\xfe not base64 not autoproxy", "u", 2) {
            Ok(_) => panic!("expected a decode/integrity failure"),
            Err(e) => e.to_string(),
        };
        state.apply_failure(msg, 2);
        assert!(state.has_snapshot(), "last-good must survive a failed update");
        assert!(state.last_error.is_some());
    }

    #[test]
    fn empty_document_is_integrity_failure() {
        let err = process_document("s", &encode("! only a comment\n"), "u", 1);
        assert!(matches!(err, Err(SockscapError::Integrity(_))));
    }

    #[test]
    fn sha256_is_stable() {
        assert_eq!(sha256_hex(b"abc"), sha256_hex(b"abc"));
        assert_ne!(sha256_hex(b"abc"), sha256_hex(b"abd"));
    }

    #[tokio::test]
    async fn fetch_requires_urls() {
        let r = fetch_first_healthy(&[], &DownloadLimits::default(), None).await;
        assert!(matches!(r, Err(SockscapError::Download(_))));
    }
}
