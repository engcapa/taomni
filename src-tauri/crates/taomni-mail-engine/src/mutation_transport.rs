//! Typed IMAP commands shared by the Mail host and the compatibility client.

use std::io::{Read, Write};

use taomni_mail_api::imap_mutation::{MutationError, MutationReply, MutationRequest, Rejection};

use crate::{imap_messages::uid_set_string, imap_transport::ImapSession};

impl ImapSession {
    pub fn mutate(&mut self, request: MutationRequest) -> Result<MutationReply, MutationError> {
        match self {
            Self::Plain(session) => execute(session, request),
            Self::Tls(session) => execute(session, request),
        }
    }
}

fn failure(error: imap::Error) -> MutationError {
    let rejection = match error {
        imap::Error::Bad(_) => Some(Rejection::Bad),
        imap::Error::No(_) => Some(Rejection::No),
        _ => None,
    };
    MutationError {
        message: error.to_string(),
        rejection,
    }
}

fn mailbox(name: &str) -> Result<&str, MutationError> {
    if name.trim().is_empty() || name.contains(['\r', '\n', '\0']) {
        return Err(MutationError::unavailable(
            "IMAP operation requires a valid folder name",
        ));
    }
    Ok(name)
}

fn uid_set(uids: &[u32]) -> Result<String, MutationError> {
    if uids.is_empty() || uids.contains(&0) {
        return Err(MutationError::unavailable(
            "IMAP operation requires valid UIDs",
        ));
    }
    let set = uid_set_string(uids);
    if set.len() > 4096 {
        return Err(MutationError::unavailable(
            "IMAP operation UID set exceeds the command limit",
        ));
    }
    Ok(set)
}

pub fn execute<T: Read + Write>(
    session: &mut imap::Session<T>,
    request: MutationRequest,
) -> Result<MutationReply, MutationError> {
    let result = match request {
        MutationRequest::Select {
            folder,
            capabilities,
        } => {
            let selected = session.select(mailbox(&folder)?).map_err(|error| {
                MutationError::unavailable(format!("IMAP SELECT failed: {error}"))
            })?;
            let validity = selected.uid_validity.ok_or_else(|| {
                MutationError::unavailable(
                    "Server did not provide UIDVALIDITY; no messages were changed",
                )
            })?;
            let (move_supported, uidplus) = if capabilities {
                let caps = session.capabilities().map_err(|error| {
                    MutationError::unavailable(format!("IMAP CAPABILITY failed: {error}"))
                })?;
                (caps.has_str("MOVE"), caps.has_str("UIDPLUS"))
            } else {
                (false, false)
            };
            return Ok(MutationReply::Selected {
                validity,
                move_supported,
                uidplus,
            });
        }
        MutationRequest::All { folder } => {
            session.select(mailbox(&folder)?).map_err(failure)?;
            return session
                .uid_search("ALL")
                .map(|uids| MutationReply::Uids(uids.into_iter().collect()))
                .map_err(failure);
        }
        MutationRequest::Find { uids } => {
            return session
                .uid_search(format!("UID {}", uid_set(&uids)?))
                .map(|uids| MutationReply::Uids(uids.into_iter().collect()))
                .map_err(failure);
        }
        MutationRequest::Copy { target, uids } => {
            session.uid_copy(uid_set(&uids)?, mailbox(&target)?)
        }
        MutationRequest::Move { target, uids } => {
            session.uid_mv(uid_set(&uids)?, mailbox(&target)?)
        }
        MutationRequest::MarkDeleted { uids } => session
            .uid_store(uid_set(&uids)?, "+FLAGS.SILENT (\\Deleted)")
            .map(drop),
        MutationRequest::Expunge { uids } => session.uid_expunge(uid_set(&uids)?).map(drop),
    };
    result.map(|()| MutationReply::Applied).map_err(failure)
}
