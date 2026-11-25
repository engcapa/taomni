//! Attachment helpers for the desktop compatibility path.

use std::io::Write;
use std::path::Path;
pub(super) use taomni_mail_storage::attachment_cache::attachment_cache_path;

pub(super) fn write_cache_file(path: &Path, bytes: &[u8]) {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    // Best effort: a failed cache write never fails the download.
    let tmp = path.with_extension("part");
    if std::fs::File::create(&tmp)
        .and_then(|mut file| file.write_all(bytes))
        .is_ok()
    {
        let _ = std::fs::rename(&tmp, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_mail_engine::imap_parts::imap_fetch_section;
    use taomni_mail_engine::{cache::MailCacheSettings, imap_messages::Mailbox};

    #[test]
    fn large_message_reads_text_sections_and_one_attachment() {
        let fake = super::super::fake_imap::FakeImap::start(false);
        let uid = fake.deliver_raw("INBOX", vec![b'x'; 4096]);
        let structure = "((\"TEXT\" \"PLAIN\" (\"CHARSET\" \"utf-8\") NIL NIL \"QUOTED-PRINTABLE\" 9 1 NIL NIL NIL)(\"APPLICATION\" \"PDF\" (\"NAME\" \"big.pdf\") NIL NIL \"BASE64\" 4 NIL (\"ATTACHMENT\" (\"FILENAME\" \"big.pdf\")) NIL) \"MIXED\" (\"BOUNDARY\" \"b0\") NIL NIL)";
        fake.set_structure(
            "INBOX",
            uid,
            structure,
            &[
                ("1.MIME", b"Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"),
                ("1", b"caf=C3=A9 ok"),
                ("2.MIME", b"Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n"),
                ("2", b"JVBE"),
            ],
        );
        let mut session = fake.session();
        let mut mailbox = Mailbox {
            account_id: "acct",
            name: "INBOX",
            cache: &MailCacheSettings {
                body_max_bytes: 1024,
                ..MailCacheSettings::default()
            },
            save_original: |_, _: &[u8]| -> Result<(), String> {
                panic!("the truncated fetch cannot be saved as an original")
            },
        };
        let large = mailbox.fetch_body(&mut session, uid).unwrap();
        assert_eq!(large.body_text.as_deref(), Some("caf\u{e9} ok"));
        assert!(large.body_html.is_none());
        let attachments = &large.header.attachments;
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].section.as_deref(), Some("2"));
        assert_eq!(attachments[0].name.as_deref(), Some("big.pdf"));
        let pdf = imap_fetch_section(&mut session, uid, "2").unwrap();
        assert_eq!(pdf, b"%PD".to_vec());
        assert!(
            !fake
                .log()
                .iter()
                .map(|line| line.to_ascii_uppercase())
                .any(|line| line.contains("BODY.PEEK[]") && !line.contains("BODY.PEEK[]<0.1024>")),
            "never fetched the whole message: {:?}",
            fake.log()
        );
    }

    #[test]
    fn cache_paths_are_sanitised() {
        let path = attachment_cache_path(Path::new("/c"), "acct", "INBOX/Sub", 7, "1.2");
        assert!(
            path.ends_with("attachments/acct/INBOX_Sub/7-1.2.bin"),
            "{path:?}"
        );
    }
}
