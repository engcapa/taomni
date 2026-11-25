//! Taomni's model cache location for the shared, verified ASR catalog.
use std::path::PathBuf;

pub use taomni_asr_models::*;

pub fn path(m: &Model) -> PathBuf {
    version_path(&crate::models::store::models_root(), m)
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
}
