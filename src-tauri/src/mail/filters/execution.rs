use super::actions::execute_plans;
use super::cache::CandidateSelection;
use super::cache::ensure_filter_mark;
use super::cache::filter_mark;
use super::cache::load_candidates;
use super::cache::load_filters;
use super::cache::set_filter_mark;
use super::imap_search::body_needles;
use super::model::FilterMessage;
use super::model::MailFilter;
use super::model::MailFilterRunResult;
use super::planning::MessagePlan;
use super::planning::plan_message;
use super::planning::validate_filter;
use crate::mail::ImapSessionOpts;
use crate::mail::MailAccountConfig;
use crate::mail::MailMessageHeader;
use crate::mail::now_ts;
use crate::mail::resolve_config;
use crate::mail::with_imap_session;
use crate::mail::with_mail_db;
use crate::state::AppState;
use std::collections::HashMap;
use std::collections::HashSet;
use tauri::State;

/// Run filters on a folder. `trigger = "incoming"` filters only mail newer
/// than the folder's filter mark (first run just sets the mark); `"manual"`
/// filters `uids` or every cached message of the folder.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mail_apply_filters(
    config: MailAccountConfig,
    folder: String,
    trigger: String,
    uids: Option<Vec<u32>>,
    filter_ids: Option<Vec<String>>,
    trash_folder: Option<String>,
    state: State<'_, AppState>,
) -> Result<MailFilterRunResult, String> {
    let folder = folder.trim().to_string();
    if folder.is_empty() {
        return Err("mail folder is required".into());
    }
    let incoming = trigger == "incoming";
    let account_id = config.session_id.clone();
    let mut result = MailFilterRunResult {
        folder: folder.clone(),
        ..MailFilterRunResult::default()
    };
    let (filters, candidates, new_high) = with_mail_db(&state, &account_id, |db| {
        let wanted: Option<HashSet<&String>> = filter_ids.as_ref().map(|ids| ids.iter().collect());
        let filters: Vec<MailFilter> = load_filters(db, &account_id)?
            .into_iter()
            .filter(|f| f.enabled && (!incoming || f.on_incoming))
            .filter(|f| wanted.as_ref().is_none_or(|ids| ids.contains(&f.id)))
            .collect();
        let selection = if incoming {
            match filter_mark(db, &account_id, &folder)? {
                Some(mark) => CandidateSelection::Above(mark),
                None => {
                    ensure_filter_mark(db, &account_id, &folder)?;
                    return Ok((Vec::new(), Vec::new(), None));
                }
            }
        } else {
            match &uids {
                Some(uids) => CandidateSelection::Uids(uids.clone()),
                None => CandidateSelection::All,
            }
        };
        let candidates = load_candidates(db, &account_id, &folder, &selection)?;
        let new_high = candidates.iter().map(|(h, _)| h.uid).max();
        Ok((filters, candidates, new_high))
    })?;
    result.examined = candidates.len();
    let finish_mark = |state: &State<'_, AppState>| -> Result<(), String> {
        if let (true, Some(high)) = (incoming, new_high) {
            with_mail_db(state, &account_id, |db| {
                set_filter_mark(db, &account_id, &folder, high)
            })?;
        }
        Ok(())
    };
    if filters.is_empty() || candidates.is_empty() {
        finish_mark(&state)?;
        return Ok(result);
    }
    let refs: Vec<&MailFilter> = filters.iter().collect();

    // Body conditions on mail whose body is not cached: ask the server (or
    // the local store for POP3).
    let needles = body_needles(&refs);
    let uncached: Vec<u32> = candidates
        .iter()
        .filter(|(_, body)| body.is_none())
        .map(|(h, _)| h.uid)
        .collect();
    let mut server_hits: HashMap<u32, HashSet<String>> = HashMap::new();
    let mut local_bodies: HashMap<u32, String> = HashMap::new();
    if !needles.is_empty() && !uncached.is_empty() {
        if super::super::pop3::is_pop3(&config) {
            for uid in &uncached {
                if let Ok(body) =
                    super::super::local_cmds::get_body(&state, &account_id, &folder, *uid)
                {
                    local_bodies.insert(*uid, body.text.or(body.html).unwrap_or_default());
                }
            }
        } else {
            let account = resolve_config(&state, config.clone())?;
            let pool = std::sync::Arc::clone(&state.mail.mail_imap_pool);
            let handle = tokio::runtime::Handle::current();
            let folder_for_task = folder.clone();
            let lookup = tokio::task::spawn_blocking(move || {
                with_imap_session(
                    &pool,
                    &account,
                    &handle,
                    ImapSessionOpts::default(),
                    |imap| imap.filter_body_hits(&folder_for_task, &uncached, &needles),
                )
            })
            .await
            .map_err(|e| format!("filter body search failed: {e}"))?;
            match lookup {
                Ok(hits) => server_hits = hits,
                Err(e) => result.errors.push(format!("body search: {e}")),
            }
        }
    }

    let now = now_ts();
    let empty = HashSet::new();
    let mut plans: Vec<(&MailMessageHeader, MessagePlan)> = Vec::new();
    for (header, body) in &candidates {
        let body = body
            .as_deref()
            .or(local_bodies.get(&header.uid).map(String::as_str));
        let message = FilterMessage {
            header,
            body,
            server_body: Some(server_hits.get(&header.uid).unwrap_or(&empty)),
            now,
        };
        let plan = plan_message(&refs, &message);
        if !plan.is_empty() {
            plans.push((header, plan));
        }
    }
    result.matched = plans.len();
    execute_plans(
        &state,
        &config,
        &folder,
        trash_folder.as_deref(),
        &plans,
        &mut result,
    )
    .await;
    finish_mark(&state)?;
    Ok(result)
}

pub(super) fn prepare_filters(mut filters: Vec<MailFilter>) -> Result<Vec<MailFilter>, String> {
    let mut seen = HashSet::new();
    let stamp = now_ts();
    for (index, filter) in filters.iter_mut().enumerate() {
        filter.name = filter.name.trim().to_string();
        validate_filter(filter)?;
        if filter.id.trim().is_empty() || !seen.insert(filter.id.clone()) {
            filter.id = format!("filter-{stamp}-{index}");
            seen.insert(filter.id.clone());
        }
    }
    Ok(filters)
}
