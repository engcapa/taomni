//! Pinned multilingual whisper.cpp weights. No network request during startup.
use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Serialize)]
pub struct Model {
    pub id: &'static str,
    pub filename: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}
pub const UPSTREAM_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
pub const CATALOG_VERSION: &str = "2026-10-whisper-1";

pub const MODELS: &[Model] = &[
    Model {
        id: "whisper-base",
        filename: "ggml-base.bin",
        bytes: 147951465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    Model {
        id: "whisper-small",
        filename: "ggml-small.bin",
        bytes: 487601967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    },
    Model {
        id: "whisper-medium",
        filename: "ggml-medium.bin",
        bytes: 1533763059,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
    },
];
pub fn download_url(m: &Model) -> String {
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/{UPSTREAM_REVISION}/{}?download=true",
        m.filename
    )
}
pub fn model(id: &str) -> Result<&'static Model, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| "Unknown Whisper model".into())
}
pub fn path(m: &Model) -> PathBuf {
    version_path(&crate::models::store::models_root(), m)
}
/// Content-addressed versions keep the last artifact intact during an update.
pub fn version_path(root: &std::path::Path, m: &Model) -> PathBuf {
    root.join(m.id).join(m.sha256).join(m.filename)
}
pub fn verify(m: &Model, path: &std::path::Path) -> Result<(), String> {
    if std::fs::metadata(path).map(|v| v.len()).unwrap_or(0) != m.bytes {
        return Err("MODEL_MISSING: Download or import the selected Whisper model.".into());
    }
    if crate::models::downloader::sha256_file(path)? != m.sha256 {
        return Err("MODEL_CORRUPT: SHA-256 mismatch. Reinstall this model.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_and_inventory_use_the_same_versioned_artifact() {
        let m = model("whisper-base").unwrap();
        // Installation and decoding use path(); inventory uses version_path().
        // A legacy unversioned runtime path made successful installs invisible.
        let runtime = path(m);
        assert_eq!(
            runtime,
            version_path(&crate::models::store::models_root(), m)
        );
        assert_eq!(runtime.parent().unwrap().file_name().unwrap(), m.sha256);
    }
    #[test]
    fn rejects_missing_truncated_and_wrong_hash_models() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("weights.bin");
        let m = Model {
            id: "fixture",
            filename: "weights.bin",
            bytes: 3,
            sha256: "bad-hash",
        };
        assert!(verify(&m, &path).unwrap_err().starts_with("MODEL_MISSING"));
        std::fs::write(&path, b"ab").unwrap();
        assert!(verify(&m, &path).unwrap_err().starts_with("MODEL_MISSING"));
        std::fs::write(&path, b"abc").unwrap();
        assert!(verify(&m, &path).unwrap_err().starts_with("MODEL_CORRUPT"));
        assert!(model("../../escape").is_err());
    }
}
