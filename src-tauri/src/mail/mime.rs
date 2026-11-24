pub(super) use taomni_mail_engine::{
    clean_message_id, empty_cached_message, merge_body, thread_references, truncate_utf8_bytes,
};

#[cfg(any(test, feature = "legacy-mail-imap", feature = "legacy-mail-pop3"))]
pub(super) use taomni_mail_engine::{extract_attachment, parse_body_message};

#[cfg(any(test, feature = "legacy-mail-imap"))]
pub(super) use taomni_mail_engine::extract_attachment_section;

#[cfg(test)]
pub(super) use taomni_mail_engine::{attachment_info, header_message_ids};

pub(super) use taomni_mail_engine::imap_folders::decode_imap_modified_utf7;
