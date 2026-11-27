//! Optional file associations shared by installed manifests and the signed store catalog.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTypes {
    pub file_kinds: Vec<String>,
    pub extensions: Vec<String>,
}

impl DocumentTypes {
    pub fn validate(&self) -> Result<(), &'static str> {
        fn valid_list(values: &[String]) -> bool {
            !values.is_empty()
                && values.len() <= 64
                && values.iter().all(|s| {
                    !s.is_empty()
                        && s.len() <= 24
                        && s.bytes()
                            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
                })
                && values.iter().collect::<BTreeSet<_>>().len() == values.len()
        }
        if valid_list(&self.file_kinds) && valid_list(&self.extensions) {
            Ok(())
        } else {
            Err("invalid document file kinds or extensions")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn associations_are_literal_unique_suffixes() {
        let mut types = DocumentTypes {
            file_kinds: vec!["excel".into()],
            extensions: vec!["xlsx".into()],
        };
        assert!(types.validate().is_ok());
        for value in ["*.xlsx", ".xls", "XML", "a/b", ""] {
            types.extensions = vec![value.into()];
            assert!(types.validate().is_err());
        }
        types.extensions = vec!["xlsx".into(), "xlsx".into()];
        assert!(types.validate().is_err());
    }
}
