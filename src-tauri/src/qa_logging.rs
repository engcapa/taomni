//! Keep the isolated QA binary's file logger inside its run-owned data root.
//! Tauri's OS log resolver on Windows does not honor NEWMOB_DATA_DIR itself.

use std::path::{Path, PathBuf};

pub(crate) fn directory(identifier: &str, data_root: Option<&Path>) -> Option<PathBuf> {
    if !cfg!(debug_assertions) || identifier != crate::QA_APP_ID {
        return None;
    }
    data_root.map(|root| root.join(crate::QA_APP_ID).join("logs"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_explicit_qa_profile_redirects_logs() {
        let root = Path::new("run-owned-data");
        assert_eq!(directory("com.taomni.app", Some(root)), None);
        assert_eq!(directory(crate::QA_APP_ID, None), None);
        assert_eq!(
            directory(crate::QA_APP_ID, Some(root)),
            Some(root.join(crate::QA_APP_ID).join("logs"))
        );
    }
}
