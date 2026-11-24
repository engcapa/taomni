//! Keep the original on-disk attachment layout for existing mailboxes.
use std::path::{Path, PathBuf};

fn component(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    match cleaned.as_str() {
        "" | "." | ".." => format!("_{cleaned}_"),
        _ => cleaned,
    }
}

pub fn attachment_cache_path(
    root: &Path,
    account_stem: &str,
    folder: &str,
    uid: u32,
    key: &str,
) -> PathBuf {
    root.join("attachments")
        .join(component(account_stem))
        .join(component(folder))
        .join(format!("{uid}-{}.bin", component(key)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_legacy_layout_and_keeps_special_mailboxes_inside_the_account() {
        let root = Path::new("data");
        assert_eq!(
            attachment_cache_path(root, "acct", "INBOX/Sub", 7, "1.2"),
            root.join("attachments/acct/INBOX_Sub/7-1.2.bin")
        );
        for folder in [".", "..", ""] {
            let path = attachment_cache_path(root, "acct", folder, 7, "i0");
            let relative = path.strip_prefix(root.join("attachments/acct")).unwrap();
            assert_eq!(relative.components().count(), 2);
            assert!(
                relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_)))
            );
        }
    }
}
