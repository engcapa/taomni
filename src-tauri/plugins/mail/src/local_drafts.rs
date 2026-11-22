use super::store::{Store, unavailable};
use taomni_mail_engine::drafts::{
    DraftAction, DraftRequest, delete_mail_draft, draft_search_index, get_mail_draft,
    list_mail_drafts, replace_remote_location, save_mail_draft,
};
use taomni_plugin_api::RpcError;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn scheduled_and_large_drafts_survive_reopen_and_only_index_opted_in_fields() {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().canonicalize().unwrap();
        let run = |action| {
            let request = DraftRequest {
                account_id: "qa".into(),
                action,
            };
            let bytes = execute(&Store::new(&profile), request, &|| Ok(())).unwrap();
            serde_json::from_slice::<Value>(&bytes).unwrap()
        };
        let body = "m".repeat(4 * 1024 * 1024 + 1);
        let draft = serde_json::from_value(json!({
            "id":"scheduled","to":["receiver@example.com"],"subject":"Keep schedule","textBody":body,
            "replyContext":{"outbox":{"sendAt":12345,"queuedAt":1,"attempts":0}}
        })).unwrap();
        assert_eq!(run(DraftAction::Save { draft })["textBody"], body);
        let saved = run(DraftAction::Get {
            id: "scheduled".into(),
        });
        assert_eq!(saved["replyContext"]["outbox"]["sendAt"], 12345);
        assert_eq!(run(DraftAction::List), json!([saved]));
        let index = run(DraftAction::SearchIndex);
        assert_eq!(index[0]["text"], body);
        assert!(index[0].get("to").is_none());
        run(DraftAction::Delete {
            id: "scheduled".into(),
        });
        assert_eq!(run(DraftAction::List), json!([]));
        assert!(!profile.join("mail-cache").exists());
    }
}

pub(super) fn execute(
    store: &Store,
    input: DraftRequest,
    check: &dyn Fn() -> Result<(), RpcError>,
) -> Result<Vec<u8>, RpcError> {
    let account = input.account_id.as_str();
    let result = match input.action {
        DraftAction::List => {
            serde_json::to_vec(&store.query(account, |db| list_mail_drafts(db, account))?)
        }
        DraftAction::SearchIndex => {
            serde_json::to_vec(&store.query(account, |db| draft_search_index(db, account))?)
        }
        DraftAction::Get { id } => {
            serde_json::to_vec(&store.query(account, |db| get_mail_draft(db, account, &id))?)
        }
        DraftAction::Save { draft } => {
            let saved = store
                .mutate(account, true, check, |db| {
                    save_mail_draft(db, account, draft)
                        .map(Some)
                        .map_err(|_| unavailable())
                })?
                .ok_or_else(unavailable)?;
            serde_json::to_vec(&saved)
        }
        DraftAction::Delete { id } => {
            store.mutate(account, false, check, |db| {
                delete_mail_draft(db, account, &id).map_err(|_| unavailable())
            })?;
            serde_json::to_vec(&())
        }
        DraftAction::SetLocation { id, previous, next } => {
            let draft = store.mutate(account, false, check, |db| {
                replace_remote_location(db, account, &id, previous.as_ref(), next.as_ref())
                    .map_err(|_| unavailable())
            })?;
            serde_json::to_vec(&draft)
        }
    };
    result.map_err(|_| unavailable())
}
