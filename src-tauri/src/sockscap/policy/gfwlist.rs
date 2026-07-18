//! GFWList source metadata, official mirrors, and last-good update pipeline.
//!
//! The updater never exposes a half-compiled snapshot: payloads are bounded,
//! decoded, structurally validated and parsed before the last-good files are
//! atomically replaced. A failed mirror leaves the previous snapshot intact.

use super::rules::{ParseReport, decode_gfwlist_base64, parse_rule_document};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const GFWLIST_OFFICIAL_SOURCE_ID: &str = "gfwlist-official";
pub const MAX_RULE_PAYLOAD_BYTES: usize = 5 * 1024 * 1024;
pub const MIN_REFRESH_INTERVAL_SECONDS: u64 = 6 * 60 * 60;

/// Official mirrors listed by the GFWList project (order = preference).
pub fn official_gfwlist_mirrors() -> Vec<&'static str> {
    vec![
        "https://raw.githubusercontent.com/gfwlist/gfwlist/master/gfwlist.txt",
        "https://gitlab.com/gfwlist/gfwlist/raw/master/gfwlist.txt",
        "https://repo.or.cz/gfwlist.git/blob_plain/HEAD:/gfwlist.txt",
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSourceState {
    pub source_id: String,
    pub kind: RuleSourceKind,
    pub url: Option<String>,
    pub last_good_path: Option<String>,
    pub last_success_unix: Option<u64>,
    pub last_mirror: Option<String>,
    pub last_sha256: Option<String>,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    #[serde(default)]
    pub refresh_after_unix: Option<u64>,
    pub last_error: Option<String>,
    pub parse_stats: Option<ParseStats>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleSourceKind {
    GfwlistOfficial,
    CustomUrl,
    LocalFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseStats {
    pub total_lines: usize,
    pub proxy_rules: usize,
    pub direct_rules: usize,
    pub unsupported: usize,
    pub ignored_comments: usize,
}

impl From<&ParseReport> for ParseStats {
    fn from(report: &ParseReport) -> Self {
        Self {
            total_lines: report.total_lines,
            proxy_rules: report.proxy_rules.len(),
            direct_rules: report.direct_rules.len(),
            unsupported: report.unsupported.len(),
            ignored_comments: report.ignored_comments,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshOutcome {
    pub ok: bool,
    pub used_last_good: bool,
    #[serde(default)]
    pub not_modified: bool,
    pub mirror: Option<String>,
    pub sha256: Option<String>,
    pub parse_stats: Option<ParseStats>,
    pub error: Option<String>,
    pub report: Option<ParseReport>,
}

#[derive(Debug, Clone, Default)]
struct CacheValidators {
    etag: Option<String>,
    last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastGoodEnvelope {
    schema_version: u32,
    decoded_text: String,
    state: RuleSourceState,
}

pub fn validate_source_id(source_id: &str) -> Result<(), String> {
    if source_id.is_empty()
        || source_id.len() > 128
        || !source_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("rule source id must be 1-128 ASCII letters, digits, '-' or '_'".into());
    }
    Ok(())
}

fn validate_provenance(
    source_id: &str,
    kind: RuleSourceKind,
    source: Option<&str>,
) -> Result<(), String> {
    validate_source_id(source_id)?;
    if source_id == GFWLIST_OFFICIAL_SOURCE_ID && kind != RuleSourceKind::GfwlistOfficial {
        return Err("the built-in GFWList source id is reserved".into());
    }
    if kind == RuleSourceKind::GfwlistOfficial && source_id != GFWLIST_OFFICIAL_SOURCE_ID {
        return Err(format!(
            "official GFWList must use source id '{GFWLIST_OFFICIAL_SOURCE_ID}'"
        ));
    }
    if let Some(source) = source {
        if source.len() > 4096 || source.contains('\0') {
            return Err("rule source location is too long or contains NUL".into());
        }
        if matches!(
            kind,
            RuleSourceKind::GfwlistOfficial | RuleSourceKind::CustomUrl
        ) {
            let url =
                url::Url::parse(source).map_err(|error| format!("invalid source URL: {error}"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("remote rule source URL must use http or https".into());
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err("credentials in rule source URLs are not persisted".into());
            }
        }
    }
    Ok(())
}

pub fn rules_dir(app_data: &Path) -> PathBuf {
    app_data.join("sockscap").join("rules")
}

pub fn last_good_path(app_data: &Path, source_id: &str) -> PathBuf {
    rules_dir(app_data).join(format!("{source_id}.last-good.json"))
}

/// Compile raw AutoProxy/GFWList Base64 or a plain domain list.
pub fn compile_gfwlist_payload(source_id: &str, payload: &str) -> Result<ParseReport, String> {
    validate_source_id(source_id)?;
    let text = decode_payload(payload)?;
    let report = parse_rule_document(source_id, &text);
    ensure_effective_rules(&report)?;
    Ok(report)
}

fn decode_payload(payload: &str) -> Result<String, String> {
    if payload.len() > MAX_RULE_PAYLOAD_BYTES {
        return Err(format!(
            "rule payload exceeds {} byte limit",
            MAX_RULE_PAYLOAD_BYTES
        ));
    }
    let text = if looks_like_base64_blob(payload) {
        decode_gfwlist_base64(payload)?
    } else {
        payload.to_string()
    };
    if text.len() > MAX_RULE_PAYLOAD_BYTES {
        return Err(format!(
            "decoded rule payload exceeds {} byte limit",
            MAX_RULE_PAYLOAD_BYTES
        ));
    }
    Ok(text)
}

fn ensure_effective_rules(report: &ParseReport) -> Result<(), String> {
    if report.proxy_rules.is_empty() && report.direct_rules.is_empty() {
        return Err("rule document contains no supported domain or IP rules".into());
    }
    Ok(())
}

fn compile_for_source(
    source_id: &str,
    kind: RuleSourceKind,
    payload: &str,
) -> Result<(String, ParseReport), String> {
    let text = decode_payload(payload)?;
    if kind == RuleSourceKind::GfwlistOfficial
        && !text
            .lines()
            .take(32)
            .any(|line| line.trim().starts_with("[AutoProxy"))
    {
        return Err("official GFWList payload is missing its AutoProxy header".into());
    }
    let report = parse_rule_document(source_id, &text);
    ensure_effective_rules(&report)?;
    Ok((text, report))
}

fn looks_like_base64_blob(input: &str) -> bool {
    let compact: String = input.chars().filter(|char| !char.is_whitespace()).collect();
    compact.len() >= 16
        && !compact.starts_with('[')
        && compact
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '+' | '/' | '='))
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("create rules dir: {error}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "rule cache path is not valid UTF-8".to_string())?;
    let temp = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nonce));
    let write_result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("create temporary rule file: {error}"))?;
        file.write_all(contents)
            .map_err(|error| format!("write temporary rule file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync temporary rule file: {error}"))?;
        replace_file(&temp, path).map_err(|error| format!("replace rule file: {error}"))?;
        sync_parent_directory(parent)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    write_result
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::winbase::{MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW};

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both buffers are NUL-terminated and live for the duration of the
    // call. Flags request Windows' replace-existing atomic rename semantics.
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    std::fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("sync rules directory: {error}"))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

pub fn write_last_good(
    app_data: &Path,
    source_id: &str,
    decoded_text: &str,
    state: &RuleSourceState,
) -> Result<(), String> {
    validate_source_id(source_id)?;
    if state.source_id != source_id {
        return Err("rule source state id does not match cache target".into());
    }
    let envelope = LastGoodEnvelope {
        schema_version: 1,
        decoded_text: decoded_text.to_string(),
        state: state.clone(),
    };
    let serialized = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
    atomic_write(&last_good_path(app_data, source_id), &serialized)
}

pub fn load_last_good_text(app_data: &Path, source_id: &str) -> Option<String> {
    validate_source_id(source_id).ok()?;
    load_last_good_envelope(app_data, source_id).map(|envelope| envelope.decoded_text)
}

pub fn load_source_state(app_data: &Path, source_id: &str) -> Option<RuleSourceState> {
    validate_source_id(source_id).ok()?;
    load_last_good_envelope(app_data, source_id).map(|envelope| envelope.state)
}

fn load_last_good_envelope(app_data: &Path, source_id: &str) -> Option<LastGoodEnvelope> {
    let raw = std::fs::read(last_good_path(app_data, source_id)).ok()?;
    let envelope: LastGoodEnvelope = serde_json::from_slice(&raw).ok()?;
    (envelope.schema_version == 1 && envelope.state.source_id == source_id).then_some(envelope)
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn refresh_interval_seconds(text: &str) -> u64 {
    let advertised = text.lines().take(64).find_map(|line| {
        let line = line.trim().trim_start_matches('!').trim();
        let (key, value) = line.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("expires") {
            return None;
        }
        let value = value.trim().to_ascii_lowercase();
        let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
        let amount = digits.parse::<u64>().ok()?;
        let unit = value[digits.len()..].trim();
        match unit {
            "m" | "min" | "mins" | "minute" | "minutes" => amount.checked_mul(60),
            "h" | "hr" | "hrs" | "hour" | "hours" => amount.checked_mul(60 * 60),
            "d" | "day" | "days" => amount.checked_mul(24 * 60 * 60),
            _ => None,
        }
    });
    advertised
        .unwrap_or(MIN_REFRESH_INTERVAL_SECONDS)
        .max(MIN_REFRESH_INTERVAL_SECONDS)
}

pub fn refresh_due(app_data: &Path, source_id: &str, at_unix: u64) -> bool {
    load_source_state(app_data, source_id)
        .and_then(|state| state.refresh_after_unix)
        .map(|refresh_after| at_unix >= refresh_after)
        .unwrap_or(true)
}

pub fn ingest_payload(
    app_data: &Path,
    source_id: &str,
    kind: RuleSourceKind,
    source: Option<&str>,
    payload: &str,
) -> RefreshOutcome {
    ingest_payload_with_validators(
        app_data,
        source_id,
        kind,
        source,
        payload,
        CacheValidators::default(),
    )
}

fn ingest_payload_with_validators(
    app_data: &Path,
    source_id: &str,
    kind: RuleSourceKind,
    source: Option<&str>,
    payload: &str,
    validators: CacheValidators,
) -> RefreshOutcome {
    if let Err(error) = validate_provenance(source_id, kind, source) {
        return failed_outcome(source, error);
    }
    let (decoded, report) = match compile_for_source(source_id, kind, payload) {
        Ok(compiled) => compiled,
        Err(error) => return fallback_last_good(app_data, source_id, Some(error)),
    };
    let digest = sha256_hex(decoded.as_bytes());
    let stats = ParseStats::from(&report);
    let now = now_unix();
    let state = RuleSourceState {
        source_id: source_id.to_string(),
        kind,
        url: source.map(str::to_string),
        last_good_path: Some(
            last_good_path(app_data, source_id)
                .to_string_lossy()
                .into_owned(),
        ),
        last_success_unix: Some(now),
        last_mirror: source.map(str::to_string),
        last_sha256: Some(digest.clone()),
        etag: validators.etag,
        last_modified: validators.last_modified,
        refresh_after_unix: Some(now.saturating_add(refresh_interval_seconds(&decoded))),
        last_error: None,
        parse_stats: Some(stats.clone()),
    };
    if let Err(error) = write_last_good(app_data, source_id, &decoded, &state) {
        return RefreshOutcome {
            ok: false,
            used_last_good: load_last_good_text(app_data, source_id).is_some(),
            not_modified: false,
            mirror: source.map(str::to_string),
            sha256: Some(digest),
            parse_stats: Some(stats),
            error: Some(error),
            report: Some(report),
        };
    }
    RefreshOutcome {
        ok: true,
        used_last_good: false,
        not_modified: false,
        mirror: source.map(str::to_string),
        sha256: Some(digest),
        parse_stats: Some(stats),
        error: None,
        report: Some(report),
    }
}

fn failed_outcome(source: Option<&str>, error: String) -> RefreshOutcome {
    RefreshOutcome {
        ok: false,
        used_last_good: false,
        not_modified: false,
        mirror: source.map(str::to_string),
        sha256: None,
        parse_stats: None,
        error: Some(error),
        report: None,
    }
}

fn fallback_last_good(app_data: &Path, source_id: &str, error: Option<String>) -> RefreshOutcome {
    if let Err(validation_error) = validate_source_id(source_id) {
        return failed_outcome(None, validation_error);
    }
    let Some(text) = load_last_good_text(app_data, source_id) else {
        return RefreshOutcome {
            error: error.or_else(|| Some("no last-good snapshot available".into())),
            ..failed_outcome(None, "no last-good snapshot available".into())
        };
    };
    match compile_gfwlist_payload(source_id, &text) {
        Ok(report) => {
            let state = load_source_state(app_data, source_id);
            RefreshOutcome {
                ok: true,
                used_last_good: true,
                not_modified: false,
                mirror: state.as_ref().and_then(|value| value.last_mirror.clone()),
                sha256: state.as_ref().and_then(|value| value.last_sha256.clone()),
                parse_stats: Some(ParseStats::from(&report)),
                error,
                report: Some(report),
            }
        }
        Err(last_good_error) => RefreshOutcome {
            ok: false,
            used_last_good: true,
            not_modified: false,
            mirror: None,
            sha256: None,
            parse_stats: None,
            error: Some(format!(
                "refresh failed ({}); last-good is invalid: {last_good_error}",
                error.unwrap_or_default()
            )),
            report: None,
        },
    }
}

fn not_modified_outcome(app_data: &Path, source_id: &str) -> RefreshOutcome {
    let mut outcome = fallback_last_good(app_data, source_id, None);
    outcome.not_modified = outcome.ok;
    outcome
}

/// Refresh the built-in list from the first healthy official mirror. Conditional
/// validators are sent only to the mirror that produced the current snapshot.
pub fn refresh_official_gfwlist(app_data: &Path) -> RefreshOutcome {
    refresh_gfwlist_from_mirrors(app_data, &official_gfwlist_mirrors())
}

fn refresh_gfwlist_from_mirrors(app_data: &Path, mirrors: &[&str]) -> RefreshOutcome {
    refresh_source_from_mirrors(
        app_data,
        GFWLIST_OFFICIAL_SOURCE_ID,
        RuleSourceKind::GfwlistOfficial,
        mirrors,
    )
}

/// Refresh one persisted custom URL under the same bounded, conditional,
/// last-good pipeline as the official source.
pub fn refresh_custom_url(app_data: &Path, source_id: &str, url: &str) -> RefreshOutcome {
    if let Err(error) = validate_provenance(source_id, RuleSourceKind::CustomUrl, Some(url)) {
        return failed_outcome(Some(url), error);
    }
    refresh_source_from_mirrors(app_data, source_id, RuleSourceKind::CustomUrl, &[url])
}

fn refresh_source_from_mirrors(
    app_data: &Path,
    source_id: &str,
    kind: RuleSourceKind,
    mirrors: &[&str],
) -> RefreshOutcome {
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return fallback_last_good(app_data, source_id, Some(error.to_string()));
        }
    };

    let previous = load_source_state(app_data, source_id);
    let mut last_error = None;
    for &mirror in mirrors {
        let mut request = client
            .get(mirror)
            .header(reqwest::header::USER_AGENT, "taomni-sockscap/0.1");
        if previous
            .as_ref()
            .and_then(|state| state.last_mirror.as_deref())
            == Some(mirror)
        {
            if let Some(etag) = previous.as_ref().and_then(|state| state.etag.as_deref()) {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            if let Some(modified) = previous
                .as_ref()
                .and_then(|state| state.last_modified.as_deref())
            {
                request = request.header(reqwest::header::IF_MODIFIED_SINCE, modified);
            }
        }

        let mut response = match request.send() {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(format!("mirror {mirror}: {error}"));
                continue;
            }
        };
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return not_modified_outcome(app_data, source_id);
        }
        if !response.status().is_success() {
            last_error = Some(format!("mirror {mirror} status {}", response.status()));
            continue;
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RULE_PAYLOAD_BYTES as u64)
        {
            last_error = Some(format!("mirror {mirror} response too large"));
            continue;
        }
        let validators = CacheValidators {
            etag: response
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            last_modified: response
                .headers()
                .get(reqwest::header::LAST_MODIFIED)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        };
        let mut bytes = Vec::new();
        if let Err(error) = response
            .by_ref()
            .take(MAX_RULE_PAYLOAD_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
        {
            last_error = Some(format!("mirror {mirror} body: {error}"));
            continue;
        }
        if bytes.len() > MAX_RULE_PAYLOAD_BYTES {
            last_error = Some(format!("mirror {mirror} response too large"));
            continue;
        }
        let payload = match String::from_utf8(bytes) {
            Ok(payload) => payload,
            Err(error) => {
                last_error = Some(format!("mirror {mirror} body is not UTF-8: {error}"));
                continue;
            }
        };
        let outcome = ingest_payload_with_validators(
            app_data,
            source_id,
            kind,
            Some(mirror),
            &payload,
            validators,
        );
        if outcome.ok && !outcome.used_last_good {
            return outcome;
        }
        last_error = outcome.error;
    }
    fallback_last_good(app_data, source_id, last_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn temp_app_data() -> tempfile::TempDir {
        tempfile::tempdir().expect("temporary app data")
    }

    fn official_document(domain: &str) -> String {
        format!("[AutoProxy 0.2.9]\n! Expires: 6h\n||{domain}\n")
    }

    fn serve_documents(
        documents: Vec<(&'static str, String)>,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            for (expected_path, body) in documents {
                let (mut stream, _) = listener.accept().expect("accept updater request");
                let mut request = [0_u8; 2048];
                let bytes_read = stream.read(&mut request).expect("read updater request");
                let request = String::from_utf8_lossy(&request[..bytes_read]);
                assert!(
                    request.starts_with(&format!("GET {expected_path} ")),
                    "unexpected request: {request}"
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .expect("write updater response");
            }
        });
        (base, handle)
    }

    #[test]
    fn ingest_writes_last_good_and_invalid_update_keeps_it() {
        let directory = temp_app_data();
        let first = official_document("example.com");
        let outcome = ingest_payload(
            directory.path(),
            GFWLIST_OFFICIAL_SOURCE_ID,
            RuleSourceKind::GfwlistOfficial,
            Some(official_gfwlist_mirrors()[0]),
            &first,
        );
        assert!(outcome.ok, "{:?}", outcome.error);
        assert!(!outcome.used_last_good);

        let bad = ingest_payload(
            directory.path(),
            GFWLIST_OFFICIAL_SOURCE_ID,
            RuleSourceKind::GfwlistOfficial,
            Some(official_gfwlist_mirrors()[1]),
            "this is not an official list",
        );
        assert!(bad.ok);
        assert!(bad.used_last_good);
        assert_eq!(
            load_last_good_text(directory.path(), GFWLIST_OFFICIAL_SOURCE_ID).as_deref(),
            Some(first.as_str())
        );
    }

    #[test]
    fn repeated_update_replaces_snapshot_and_metadata() {
        let directory = temp_app_data();
        for domain in ["one.example", "two.example"] {
            let outcome = ingest_payload(
                directory.path(),
                GFWLIST_OFFICIAL_SOURCE_ID,
                RuleSourceKind::GfwlistOfficial,
                Some(official_gfwlist_mirrors()[0]),
                &official_document(domain),
            );
            assert!(outcome.ok, "{:?}", outcome.error);
        }
        let current = load_last_good_text(directory.path(), GFWLIST_OFFICIAL_SOURCE_ID).unwrap();
        assert!(current.contains("two.example"));
        assert!(!current.contains("one.example"));
        assert!(load_source_state(directory.path(), GFWLIST_OFFICIAL_SOURCE_ID).is_some());
    }

    #[test]
    fn base64_gfwlist_ingest() {
        let directory = temp_app_data();
        let text = official_document("google.com");
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, text);
        let outcome = ingest_payload(
            directory.path(),
            GFWLIST_OFFICIAL_SOURCE_ID,
            RuleSourceKind::GfwlistOfficial,
            Some(official_gfwlist_mirrors()[0]),
            &encoded,
        );
        assert!(outcome.ok, "{:?}", outcome.error);
        assert_eq!(outcome.parse_stats.unwrap().proxy_rules, 1);
    }

    #[test]
    fn source_id_cannot_escape_rules_directory() {
        let directory = temp_app_data();
        let outcome = ingest_payload(
            directory.path(),
            "../escape",
            RuleSourceKind::LocalFile,
            None,
            "example.com\n",
        );
        assert!(!outcome.ok);
        assert!(!directory.path().join("escape.last-good.txt").exists());
    }

    #[test]
    fn oversized_payload_is_rejected_without_cache_write() {
        let directory = temp_app_data();
        let payload = "a".repeat(MAX_RULE_PAYLOAD_BYTES + 1);
        let outcome = ingest_payload(
            directory.path(),
            "custom",
            RuleSourceKind::LocalFile,
            None,
            &payload,
        );
        assert!(!outcome.ok);
        assert!(!last_good_path(directory.path(), "custom").exists());
    }

    #[test]
    fn refresh_interval_never_drops_below_six_hours() {
        assert_eq!(
            refresh_interval_seconds("[AutoProxy]\n! Expires: 5m\n||example.com"),
            MIN_REFRESH_INTERVAL_SECONDS
        );
        assert_eq!(
            refresh_interval_seconds("[AutoProxy]\n! Expires: 2d\n||example.com"),
            2 * 24 * 60 * 60
        );
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn official_mirrors_are_https_and_non_empty() {
        let mirrors = official_gfwlist_mirrors();
        assert!(mirrors.len() >= 3);
        assert!(mirrors.iter().all(|mirror| mirror.starts_with("https://")));
    }

    #[test]
    fn custom_url_uses_bounded_last_good_refresh_pipeline() {
        let directory = temp_app_data();
        let (base, server) = serve_documents(vec![(
            "/custom",
            "[AutoProxy 0.2.9]\n||custom.example\n".into(),
        )]);
        let url = format!("{base}/custom");
        let outcome = refresh_custom_url(directory.path(), "custom-source", &url);
        server.join().expect("test HTTP server");
        assert!(outcome.ok, "{:?}", outcome.error);
        assert!(!outcome.used_last_good);
        let state =
            load_source_state(directory.path(), "custom-source").expect("custom source state");
        assert_eq!(state.kind, RuleSourceKind::CustomUrl);
        assert_eq!(state.url.as_deref(), Some(url.as_str()));
    }

    #[test]
    fn invalid_mirror_continues_to_next_healthy_mirror() {
        let directory = temp_app_data();
        let seed = official_document("seed.example");
        assert!(
            ingest_payload(
                directory.path(),
                GFWLIST_OFFICIAL_SOURCE_ID,
                RuleSourceKind::GfwlistOfficial,
                Some(official_gfwlist_mirrors()[0]),
                &seed,
            )
            .ok
        );

        let healthy = official_document("healthy.example");
        let (base, server) = serve_documents(vec![
            ("/bad", "not an AutoProxy document".into()),
            ("/healthy", healthy.clone()),
        ]);
        let bad_url = format!("{base}/bad");
        let healthy_url = format!("{base}/healthy");
        let outcome = refresh_gfwlist_from_mirrors(
            directory.path(),
            &[bad_url.as_str(), healthy_url.as_str()],
        );
        server.join().expect("test HTTP server");

        assert!(outcome.ok, "{:?}", outcome.error);
        assert!(!outcome.used_last_good);
        assert_eq!(outcome.mirror.as_deref(), Some(healthy_url.as_str()));
        assert_eq!(
            load_last_good_text(directory.path(), GFWLIST_OFFICIAL_SOURCE_ID).as_deref(),
            Some(healthy.as_str())
        );
    }
}
