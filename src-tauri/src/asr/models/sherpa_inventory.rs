use futures::StreamExt;
use serde::Serialize;

pub const SHERPA_UPSTREAM_REVISION: &str = "98590b7ed6443e77b714204da2757d75e1a642f4";
pub(super) const SHERPA_UPSTREAM_REPOSITORY: &str =
    "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20";
pub(super) const SHERPA_REVISION_FILE: &str = ".revision";
pub(super) const SHERPA_MODEL_ID: &str = "sherpa-zipformer-zh-en";
pub(super) const SHERPA_FILES: &[(&str, u64, &str)] = &[
    (
        "encoder-epoch-99-avg-1.int8.onnx",
        181_895_032,
        "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b",
    ),
    (
        "decoder-epoch-99-avg-1.onnx",
        13_876_452,
        "2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d",
    ),
    (
        "joiner-epoch-99-avg-1.int8.onnx",
        3_228_404,
        "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0",
    ),
    (
        "tokens.txt",
        56_317,
        "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3",
    ),
];

#[derive(Clone, Serialize)]
pub struct SherpaFileStatus {
    pub filename: &'static str,
    pub bytes: u64,
    pub downloaded: u64,
    pub installed: bool,
    pub sha256: &'static str,
}

#[derive(Clone, Serialize)]
pub struct SherpaModelStatus {
    pub model_id: &'static str,
    pub revision: &'static str,
    pub download_url: String,
    pub available_version: String,
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub integrity: &'static str,
    pub files: Vec<SherpaFileStatus>,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    pub installed: bool,
}

pub(super) fn sherpa_storage_dir() -> std::path::PathBuf {
    if let Ok(path) = std::env::var("TAOMNI_SHERPA_MODEL_DIR") {
        return std::path::PathBuf::from(path);
    }
    crate::resolved_cache_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("taomni/models/sherpa-zipformer-zh-en")
}

/// Publish a complete revision by its marker, keeping legacy weights usable
/// while individual files in the new revision are downloaded and verified.
pub(crate) fn sherpa_model_dir() -> std::path::PathBuf {
    active_sherpa_dir(sherpa_storage_dir(), SHERPA_UPSTREAM_REVISION)
}

pub(super) fn active_sherpa_dir(root: std::path::PathBuf, revision: &str) -> std::path::PathBuf {
    let candidate = root.join(revision);
    if std::fs::read_to_string(candidate.join(SHERPA_REVISION_FILE))
        .is_ok_and(|value| value == revision)
    {
        candidate
    } else if let Ok(previous) = std::fs::read_to_string(root.join(".active")) {
        if previous.len() == 40 && previous.chars().all(|c| c.is_ascii_hexdigit()) {
            let previous_dir = root.join(&previous);
            if std::fs::read_to_string(previous_dir.join(SHERPA_REVISION_FILE))
                .is_ok_and(|value| value == previous)
            {
                return previous_dir;
            }
        }
        root
    } else {
        root
    }
}

pub(super) fn sherpa_file_status() -> SherpaModelStatus {
    let dir = sherpa_model_dir();
    let files = SHERPA_FILES
        .iter()
        .map(|(filename, bytes, sha256)| {
            let path = dir.join(filename);
            let part = sherpa_storage_dir()
                .join(SHERPA_UPSTREAM_REVISION)
                .join(format!("{filename}.part"));
            let downloaded = std::fs::metadata(&part)
                .map(|m| m.len())
                .unwrap_or(0)
                .min(*bytes);
            let installed = std::fs::metadata(&path)
                .map(|m| m.len() == *bytes)
                .unwrap_or(false)
                && crate::models::downloader::sha256_file(&path)
                    .map(|hash| hash == *sha256)
                    .unwrap_or(false);
            SherpaFileStatus {
                filename,
                bytes: *bytes,
                downloaded,
                installed,
                sha256,
            }
        })
        .collect::<Vec<_>>();
    let installed = files.iter().all(|file| file.installed);
    let any_target = files.iter().any(|file| dir.join(file.filename).is_file());
    let installed_version = std::fs::read_to_string(dir.join(SHERPA_REVISION_FILE))
        .ok()
        .map(|version| version.trim().chars().take(12).collect::<String>())
        .filter(|version| !version.is_empty())
        .or_else(|| installed.then(|| SHERPA_UPSTREAM_REVISION[..12].into()));
    SherpaModelStatus {
        model_id: SHERPA_MODEL_ID,
        revision: SHERPA_UPSTREAM_REVISION,
        download_url: format!("{SHERPA_UPSTREAM_REPOSITORY}/tree/{SHERPA_UPSTREAM_REVISION}"),
        available_version: SHERPA_UPSTREAM_REVISION[..12].into(),
        update_available: !installed && any_target,
        integrity: if installed {
            "verified"
        } else if any_target {
            "corrupt"
        } else {
            "missing"
        },
        installed_version,
        total_bytes: files.iter().map(|f| f.bytes).sum(),
        downloaded_bytes: files
            .iter()
            .map(|f| if f.installed { f.bytes } else { f.downloaded })
            .sum(),
        installed: files.iter().all(|f| f.installed),
        files,
    }
}

#[tauri::command]
pub fn voice_sherpa_model_status() -> SherpaModelStatus {
    sherpa_file_status()
}
