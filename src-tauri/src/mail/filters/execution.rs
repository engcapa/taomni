use super::actions::execute_plans;
use super::imap_search::body_needles;
use super::store;
#[cfg(any(test, feature = "legacy-mail-imap"))]
use crate::mail::ImapSessionOpts;
use crate::mail::MailAccountConfig;
use crate::mail::MailMessageHeader;
use crate::mail::module_host;
use crate::mail::now_ts;
use crate::mail::pop3_store;
use crate::mail::resolve_config;
#[cfg(any(test, feature = "legacy-mail-imap"))]
use crate::mail::with_imap_session;
use crate::state::AppState;
use std::collections::HashMap;
use std::collections::HashSet;
use taomni_mail_api::pop3_store::LocalMailboxAction;
use taomni_mail_api::{filter_cache::FilterCacheAction, imap_exchange::FilterBodyQuery};
use taomni_mail_engine::filters::rules::FilterRulesAction;
use taomni_mail_engine::filters::{
    CandidateSelection, FilterMessage, MailFilter, MailFilterRunResult, MessagePlan,
    ensure_filter_mark, filter_mark, load_candidates, plan_message, set_filter_mark,
};
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
    let wanted: Option<HashSet<&String>> = filter_ids.as_ref().map(|ids| ids.iter().collect());
    let filters: Vec<MailFilter> = store::run(&state, &account_id, FilterRulesAction::List)
        .await?
        .into_iter()
        .filter(|f| f.enabled && (!incoming || f.on_incoming))
        .filter(|f| wanted.as_ref().is_none_or(|ids| ids.contains(&f.id)))
        .collect();
    let (candidates, watermark) = if !super::super::pop3::is_pop3(&config)
        && module_host::owns_imap_filter_cache(&state.plugins)
    {
        let snapshot = module_host::imap_filter_cache(
            &state,
            &account_id,
            FilterCacheAction::Candidates {
                folder: folder.clone(),
                incoming,
                uids,
            },
        )
        .await?
        .ok_or("Missing Mail filter candidates")?;
        (snapshot.messages, Some(snapshot.uid_validity))
    } else {
        let action = LocalMailboxAction::FilterCandidates {
            folder: folder.clone(),
            incoming,
            uids: uids.clone(),
        };
        let candidate_folder = folder.clone();
        let candidates = pop3_store::run(&state, &account_id, action, move |db, account| {
            let selection = if incoming {
                match filter_mark(db, account, &candidate_folder)? {
                    Some(mark) => CandidateSelection::Above(mark),
                    None => {
                        ensure_filter_mark(db, account, &candidate_folder)?;
                        return Ok(Vec::new());
                    }
                }
            } else {
                match &uids {
                    Some(uids) => CandidateSelection::Uids(uids.clone()),
                    None => CandidateSelection::All,
                }
            };
            load_candidates(db, account, &candidate_folder, &selection)
        })
        .await?;
        (candidates, None)
    };
    let new_high = incoming
        .then(|| candidates.iter().map(|(header, _)| header.uid).max())
        .flatten();
    result.examined = candidates.len();
    if filters.is_empty() || candidates.is_empty() {
        finish_mark(&state, &account_id, &folder, new_high, watermark).await?;
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
                    super::super::local_cmds::get_body(&state, &account_id, &folder, *uid).await
                {
                    local_bodies.insert(*uid, body.text.or(body.html).unwrap_or_default());
                }
            }
        } else {
            let account = resolve_config(&state, config.clone())?;
            let lookup = if module_host::filters_imap_bodies(&state.plugins) {
                module_host::filter_imap_bodies(
                    state.plugins.clone(),
                    &account,
                    &FilterBodyQuery {
                        folder: folder.clone(),
                        uids: uncached,
                        needles,
                    },
                )
                .await
            } else {
                legacy_imap!({
                    let pool = std::sync::Arc::clone(&state.legacy.mail.mail_imap_pool);
                    let handle = tokio::runtime::Handle::current();
                    let folder_for_task = folder.clone();
                    tokio::task::spawn_blocking(move || {
                        with_imap_session(
                            &pool,
                            &account,
                            &handle,
                            ImapSessionOpts::default(),
                            |imap| imap.filter_body_hits(&folder_for_task, &uncached, &needles),
                        )
                    })
                    .await
                    .map_err(|e| format!("filter body search failed: {e}"))?
                })
            };
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
    finish_mark(&state, &account_id, &folder, new_high, watermark).await?;
    Ok(result)
}

async fn finish_mark(
    state: &AppState,
    account: &str,
    folder: &str,
    high: Option<u32>,
    hosted_validity: Option<Option<u32>>,
) -> Result<(), String> {
    let Some(uid) = high else {
        return Ok(());
    };
    let folder = folder.to_owned();
    if let Some(uid_validity) = hosted_validity {
        module_host::imap_filter_cache(
            state,
            account,
            FilterCacheAction::Advance {
                folder,
                uid,
                uid_validity,
            },
        )
        .await?;
        return Ok(());
    }
    let action = LocalMailboxAction::AdvanceFilterMark {
        folder: folder.clone(),
        uid,
    };
    pop3_store::run(state, account, action, move |db, account| {
        set_filter_mark(db, account, &folder, uid)
    })
    .await
}
