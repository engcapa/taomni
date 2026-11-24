//! Select Sent and Drafts folders from a snapshot of the mailbox tree.

use crate::MailFolder;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecialFolder {
    Sent,
    Drafts,
}

impl SpecialFolder {
    fn attribute(self) -> &'static str {
        match self {
            Self::Sent => "\\sent",
            Self::Drafts => "\\drafts",
        }
    }

    fn names(self) -> &'static [&'static str] {
        match self {
            Self::Sent => &[
                "sent",
                "sent items",
                "sent messages",
                "sent mail",
                "已发送",
                "已發送",
                "已傳送",
                "寄件备份",
                "已发送邮件",
            ],
            Self::Drafts => &["drafts", "draft", "草稿", "草稿箱", "草稿夹"],
        }
    }

    pub fn create_name(self) -> &'static str {
        match self {
            Self::Sent => "Sent",
            Self::Drafts => "Drafts",
        }
    }
}

/// Match a configured wire or display name, then RFC 6154 and common names.
pub fn special_folder_name(
    folders: &[MailFolder],
    kind: SpecialFolder,
    configured: Option<&str>,
) -> Option<String> {
    if let Some(wanted) = configured
        .map(str::trim)
        .filter(|wanted| !wanted.is_empty())
        && let Some(folder) = folders
            .iter()
            .find(|folder| folder.name == wanted || folder.display_name == wanted)
    {
        return Some(folder.name.clone());
    }
    let attribute = kind.attribute();
    if let Some(folder) = folders.iter().find(|folder| {
        folder
            .flags
            .iter()
            .any(|flag| flag.to_ascii_lowercase().contains(attribute))
    }) {
        return Some(folder.name.clone());
    }
    for name in kind.names() {
        if let Some(folder) = folders.iter().find(|folder| {
            let delimiter = folder.delimiter.as_deref().unwrap_or("/");
            let label = folder.display_name.as_str();
            let last = label.rsplit(delimiter).next().unwrap_or(label);
            last.trim().to_lowercase() == *name
        }) {
            return Some(folder.name.clone());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, display_name: &str, flags: &[&str]) -> MailFolder {
        MailFolder {
            name: name.into(),
            display_name: display_name.into(),
            delimiter: Some("/".into()),
            flags: flags.iter().map(|flag| flag.to_string()).collect(),
            ..MailFolder::default()
        }
    }

    #[test]
    fn resolves_override_then_special_use_then_known_name() {
        let folders = [
            folder("INBOX", "INBOX", &[]),
            folder("Sent", "Sent", &[]),
            folder("[Gmail]/Sent Mail", "[Gmail]/Sent Mail", &["\\Sent"]),
            folder("&g0l6P3ux-", "草稿箱", &[]),
        ];
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Sent, Some(" 草稿箱 ")).as_deref(),
            Some("&g0l6P3ux-"),
        );
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Sent, Some("Missing")).as_deref(),
            Some("[Gmail]/Sent Mail"),
        );
        assert_eq!(
            special_folder_name(&folders, SpecialFolder::Drafts, None).as_deref(),
            Some("&g0l6P3ux-"),
        );
        assert_eq!(
            special_folder_name(&folders[..1], SpecialFolder::Sent, None),
            None
        );
    }
}
