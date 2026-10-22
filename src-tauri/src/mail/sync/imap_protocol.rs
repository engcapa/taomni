use super::limits::FLAG_FETCH_CHUNK;
use crate::mail::MailMessageCached;
use crate::mail::fetch_flag_strings;
use crate::mail::uid_set_string;
use std::io::Read;
use std::io::Write;

// ---------------------------------------------------------------------------
// IMAP helpers
// ---------------------------------------------------------------------------

pub(in crate::mail) struct RemoteMailbox {
    pub exists: u32,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub flags: Vec<String>,
    pub highest_modseq: Option<u64>,
}

/// Quote a mailbox name for a raw IMAP command.
pub(in crate::mail) fn quote_imap_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        if ch != '\r' && ch != '\n' {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

/// Parse the untagged data of an `EXAMINE ... (CONDSTORE)` response.
pub(in crate::mail) fn parse_examine_response(raw: &str) -> RemoteMailbox {
    let mut mailbox = RemoteMailbox {
        exists: 0,
        uid_validity: None,
        uid_next: None,
        flags: Vec::new(),
        highest_modseq: None,
    };
    for line in raw.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("* ") else {
            continue;
        };
        let upper = rest.to_ascii_uppercase();
        if let Some(count) = upper.strip_suffix(" EXISTS") {
            mailbox.exists = count.trim().parse().unwrap_or(mailbox.exists);
        } else if upper.starts_with("FLAGS (") {
            if let (Some(open), Some(close)) = (rest.find('('), rest.rfind(')')) {
                mailbox.flags = rest[open + 1..close]
                    .split_whitespace()
                    .map(ToOwned::to_owned)
                    .collect();
            }
        } else if upper.starts_with("OK [") {
            let code = &rest[4..rest.find(']').unwrap_or(rest.len())];
            let mut parts = code.split_whitespace();
            let key = parts.next().unwrap_or("").to_ascii_uppercase();
            let value = parts.next().unwrap_or("");
            match key.as_str() {
                "UIDVALIDITY" => mailbox.uid_validity = value.parse().ok(),
                "UIDNEXT" => mailbox.uid_next = value.parse().ok(),
                "HIGHESTMODSEQ" => mailbox.highest_modseq = value.parse().ok(),
                _ => {}
            }
        }
    }
    mailbox
}

pub(in crate::mail) fn imap_has_capability<T: Read + Write>(
    session: &mut imap::Session<T>,
    name: &str,
) -> bool {
    session
        .capabilities()
        .map(|caps| caps.has_str(name))
        .unwrap_or(false)
}

/// EXAMINE the folder. With CONDSTORE the raw form is used so HIGHESTMODSEQ
/// (which the `imap` 2.4 Mailbox type drops) is available.
pub(super) fn imap_examine<T: Read + Write>(
    session: &mut imap::Session<T>,
    folder: &str,
    condstore: bool,
) -> Result<RemoteMailbox, String> {
    if condstore {
        let command = format!("EXAMINE {} (CONDSTORE)", quote_imap_string(folder));
        let raw = session
            .run_command_and_read_response(&command)
            .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
        return Ok(parse_examine_response(&String::from_utf8_lossy(&raw)));
    }
    let mailbox = session
        .examine(folder)
        .map_err(|e| format!("IMAP EXAMINE {folder} failed: {e}"))?;
    Ok(RemoteMailbox {
        exists: mailbox.exists,
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        flags: mailbox.flags.iter().map(|flag| flag.to_string()).collect(),
        highest_modseq: None,
    })
}

/// `UID SEARCH UID lo:hi` (hi None = `*`), sorted and clamped to the range —
/// `n:*` matches the highest UID even when it is below `n`.
pub(super) fn imap_search_uid_range<T: Read + Write>(
    session: &mut imap::Session<T>,
    lo: u32,
    hi: Option<u32>,
) -> Result<Vec<u32>, String> {
    let lo = lo.max(1);
    if hi.is_some_and(|hi| hi < lo) {
        return Ok(Vec::new());
    }
    let query = match hi {
        Some(hi) => format!("UID {lo}:{hi}"),
        None => format!("UID {lo}:*"),
    };
    let mut uids: Vec<u32> = session
        .uid_search(&query)
        .map_err(|e| format!("IMAP UID SEARCH {query} failed: {e}"))?
        .into_iter()
        .filter(|uid| *uid >= lo && hi.is_none_or(|hi| *uid <= hi))
        .collect();
    uids.sort_unstable();
    uids.dedup();
    Ok(uids)
}

/// Server UIDs just below `below`, widening a window until at least `need`
/// are found or UID 1 is reached.
pub(super) fn imap_search_older<T: Read + Write>(
    session: &mut imap::Session<T>,
    below: u32,
    need: usize,
) -> Result<(Vec<u32>, bool), String> {
    if below <= 1 {
        return Ok((Vec::new(), true));
    }
    let top = below - 1;
    let mut window = (need.saturating_mul(4).max(need + 64).min(50_000) as u32).max(1);
    loop {
        let start = top.saturating_sub(window - 1).max(1);
        let uids = imap_search_uid_range(session, start, Some(top))?;
        if uids.len() >= need || start == 1 {
            return Ok((uids, start == 1));
        }
        window = window.saturating_mul(4);
    }
}

pub(super) fn imap_fetch_flags<T: Read + Write>(
    session: &mut imap::Session<T>,
    uid_set: &str,
    changed_since: Option<u64>,
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let query = match changed_since {
        Some(modseq) => format!("(UID FLAGS) (CHANGEDSINCE {modseq})"),
        None => "(UID FLAGS)".to_string(),
    };
    let fetches = session
        .uid_fetch(uid_set, &query)
        .map_err(|e| format!("IMAP UID FETCH FLAGS failed: {e}"))?;
    Ok(fetches
        .iter()
        .filter_map(|fetch| fetch.uid.map(|uid| (uid, fetch_flag_strings(fetch))))
        .collect())
}

pub(super) fn imap_fetch_flags_for_uids<T: Read + Write>(
    session: &mut imap::Session<T>,
    uids: &[u32],
) -> Result<Vec<(u32, Vec<String>)>, String> {
    let mut updates = Vec::new();
    for chunk in uids.chunks(FLAG_FETCH_CHUNK) {
        updates.extend(imap_fetch_flags(session, &uid_set_string(chunk), None)?);
    }
    Ok(updates)
}

pub(super) fn fetch_desc(mut messages: Vec<MailMessageCached>) -> Vec<MailMessageCached> {
    messages.sort_by(|a, b| b.header.uid.cmp(&a.header.uid));
    messages
}
