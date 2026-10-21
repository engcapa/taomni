use super::model::MailFilterRunResult;
use super::planning::MessagePlan;
use crate::mail::ImapSessionOpts;
use crate::mail::MailAccountConfig;
use crate::mail::MailMessageHeader;
use crate::mail::now_ts;
use crate::mail::resolve_config;
use crate::mail::with_imap_session;
use crate::state::AppState;
use std::collections::BTreeMap;
use tauri::State;

pub(super) async fn raw_bytes(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    folder: &str,
    uid: u32,
) -> Result<Vec<u8>, String> {
    if super::super::pop3::is_pop3(config) {
        return super::super::local_cmds::raw(state, &config.session_id, folder, uid);
    }
    let account = resolve_config(state, config.clone())?;
    let handle = tokio::runtime::Handle::current();
    let pool = std::sync::Arc::clone(&state.mail.mail_imap_pool);
    let folder = folder.to_string();
    tokio::task::spawn_blocking(move || {
        with_imap_session(
            &pool,
            &account,
            &handle,
            ImapSessionOpts::default(),
            |imap| imap.fetch_raw(&folder, uid),
        )
    })
    .await
    .map_err(|e| format!("forward: fetch task failed: {e}"))?
}

/// Forward as a `message/rfc822` attachment (keeps the original intact).
pub(super) async fn forward_message(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    header: &MailMessageHeader,
    to: &str,
) -> Result<(), String> {
    let raw = raw_bytes(state, config, &header.folder, header.uid).await?;
    let path = std::env::temp_dir().join(format!(
        "taomni-filter-forward-{}-{}-{}.eml",
        std::process::id(),
        header.uid,
        now_ts()
    ));
    std::fs::write(&path, &raw).map_err(|e| format!("forward: cannot stage message: {e}"))?;
    let subject = if header.subject.trim().is_empty() {
        "Fwd: (no subject)".to_string()
    } else {
        format!("Fwd: {}", header.subject)
    };
    let request: super::super::MailSendRequest = serde_json::from_value(serde_json::json!({
        "to": [to],
        "subject": subject,
        "textBody": "Forwarded by a Taomni mail filter.\n",
        "attachments": [{
            "path": path.to_string_lossy(),
            "name": "forwarded-message.eml",
            "contentType": "message/rfc822",
        }],
    }))
    .map_err(|e| format!("forward: {e}"))?;
    let sent = super::super::send_message(config.clone(), request, None, state.clone()).await;
    let _ = std::fs::remove_file(&path);
    sent.map(|_| ())
}

pub(super) fn group(
    entries: impl IntoIterator<Item = (String, u32)>,
) -> BTreeMap<String, Vec<u32>> {
    let mut map: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for (key, uid) in entries {
        map.entry(key).or_default().push(uid);
    }
    map
}

pub(super) async fn execute_plans(
    state: &State<'_, AppState>,
    config: &MailAccountConfig,
    folder: &str,
    trash_folder: Option<&str>,
    plans: &[(&MailMessageHeader, MessagePlan)],
    result: &mut MailFilterRunResult,
) {
    let uids_where = |test: &dyn Fn(&MessagePlan) -> bool| -> Vec<u32> {
        plans
            .iter()
            .filter(|(_, p)| test(p))
            .map(|(h, _)| h.uid)
            .collect()
    };
    let mut flag_ops: Vec<(Vec<u32>, Vec<String>, Vec<String>, &str)> = vec![
        (
            uids_where(&|p| p.mark_read),
            vec![r"\Seen".into()],
            vec![],
            "mark read",
        ),
        (
            uids_where(&|p| p.mark_unread),
            vec![],
            vec![r"\Seen".into()],
            "mark unread",
        ),
        (
            uids_where(&|p| p.star),
            vec![r"\Flagged".into()],
            vec![],
            "star",
        ),
    ];
    let tags = group(
        plans
            .iter()
            .flat_map(|(h, p)| p.tags.iter().map(move |t| (t.clone(), h.uid))),
    );
    for (tag, uids) in &tags {
        flag_ops.push((uids.clone(), vec![tag.clone()], vec![], "tag"));
    }
    for (uids, add, remove, label) in flag_ops {
        if uids.is_empty() {
            continue;
        }
        if let Err(e) = super::super::mail_set_flags(
            config.clone(),
            folder.to_string(),
            uids,
            Some(add),
            Some(remove),
            state.clone(),
        )
        .await
        {
            result.errors.push(format!("{label}: {e}"));
        }
    }

    let copies = group(
        plans
            .iter()
            .flat_map(|(h, p)| p.copies.iter().map(move |f| (f.clone(), h.uid))),
    );
    for (target, uids) in copies {
        match super::super::mail_copy_messages(
            config.clone(),
            folder.to_string(),
            uids,
            target.clone(),
            None,
            state.clone(),
        )
        .await
        {
            Ok(outcome) => {
                if let Some(error) = outcome.mutation.and_then(|m| m.error) {
                    result.errors.push(format!("copy to {target}: {error}"));
                }
            }
            Err(e) => result.errors.push(format!("copy to {target}: {e}")),
        }
    }

    for (header, plan) in plans {
        for to in &plan.forwards {
            if let Err(e) = forward_message(state, config, header, to).await {
                result.errors.push(format!("forward to {to}: {e}"));
            }
        }
    }

    // Moves last, so the other actions ran on the source copy.
    let trash = trash_folder
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != folder);
    let moves = group(plans.iter().filter_map(|(h, p)| {
        p.move_to
            .clone()
            .or_else(|| (p.delete).then(|| trash.map(str::to_string)).flatten())
            .map(|target| (target, h.uid))
    }));
    for (target, uids) in moves {
        match super::super::mail_move_messages(
            config.clone(),
            folder.to_string(),
            uids,
            target.clone(),
            None,
            state.clone(),
        )
        .await
        {
            Ok(outcome) => {
                result.moved += outcome.count;
                if let Some(error) = outcome.mutation.and_then(|m| m.error) {
                    result.errors.push(format!("move to {target}: {error}"));
                }
            }
            Err(e) => result.errors.push(format!("move to {target}: {e}")),
        }
    }
    if trash.is_none() {
        let purge = uids_where(&|p| p.delete && p.move_to.is_none());
        if !purge.is_empty() {
            match super::super::mail_delete_messages(
                config.clone(),
                folder.to_string(),
                Some(purge),
                Some(false),
                None,
                state.clone(),
            )
            .await
            {
                Ok(outcome) => {
                    result.moved += outcome.deleted;
                    if let Some(error) = outcome.mutation.and_then(|m| m.error) {
                        result.errors.push(format!("delete: {error}"));
                    }
                }
                Err(e) => result.errors.push(format!("delete: {e}")),
            }
        }
    }
    if !result.errors.is_empty() {
        tracing::warn!(folder = %folder, errors = ?result.errors, "mail filter actions failed");
    }
}
