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
pub const CATALOG_VERSION: &str = "2026-10-asr-2";

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
    Model {
        id: "whisper-base-q8",
        filename: "ggml-base-q8_0.bin",
        bytes: 81768585,
        sha256: "c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9",
    },
    Model {
        id: "whisper-small-q8",
        filename: "ggml-small-q8_0.bin",
        bytes: 264464607,
        sha256: "49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f",
    },
    Model {
        id: "whisper-medium-q8",
        filename: "ggml-medium-q8_0.bin",
        bytes: 823369779,
        sha256: "42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502",
    },
    Model {
        id: "whisper-turbo-q5",
        filename: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574041195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
    Model {
        id: "sensevoice-small",
        filename: "model.int8.onnx",
        bytes: 239233841,
        sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
    },
];
pub const SENSE_REVISION: &str = "2365baeacb507f821a0c8120fcee3d484dba7a07";
pub const SENSE_REPOSITORY: &str =
    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17";
pub const SENSE_TOKENS: Model = Model {
    id: "sensevoice-small",
    filename: "tokens.txt",
    bytes: 315894,
    sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
};
pub fn replacement(id: &str) -> Option<&'static str> {
    match id {
        "whisper-base" => Some("whisper-base-q8"),
        "whisper-small" => Some("whisper-small-q8"),
        "whisper-medium" => Some("whisper-medium-q8"),
        _ => None,
    }
}
pub fn download_url(m: &Model) -> String {
    if m.id == "sensevoice-small" {
        return format!(
            "{SENSE_REPOSITORY}/resolve/{SENSE_REVISION}/{}?download=true",
            m.filename
        );
    }
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
