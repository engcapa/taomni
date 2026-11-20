use crate::{MailMessageBody, MailMessageCached};

pub fn cached_to_body(message: MailMessageCached, source: &str) -> MailMessageBody {
    MailMessageBody {
        account_id: message.header.account_id,
        folder: message.header.folder,
        uid: message.header.uid,
        message_id: message.header.message_id,
        subject: message.header.subject,
        text: message.body_text,
        html: message.body_html,
        snippet: message.header.snippet,
        attachments: message.header.attachments,
        raw_size: message.header.raw_size,
        cached_at: message.body_cached_at,
        source: source.into(),
    }
}
