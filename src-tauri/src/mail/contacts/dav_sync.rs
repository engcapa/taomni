use super::dav_protocol::card_file_name;
use super::dav_protocol::multiget_body;
use super::model::CardChange;
use super::model::MailCardDavSyncResult;
use super::model::StoredCard;
use crate::mail::now_ts;
use crate::mail::vcard::parse_vcards;
use crate::mail::vcard::serialize_vcard;
use crate::mail::webdav::DavClient;
use crate::mail::webdav::PROPFIND_ETAGS;
use crate::mail::webdav::XML;
use crate::mail::webdav::etag_of;
use crate::mail::webdav::has_type;
use crate::mail::webdav::href_path;
use crate::mail::webdav::parse_multistatus;
use reqwest::Url;
use std::collections::HashMap;

/// Upload local changes, then pull the server state.
pub(super) async fn sync_collection(
    client: &DavClient,
    collection: &Url,
    cards: Vec<StoredCard>,
) -> (MailCardDavSyncResult, Vec<CardChange>) {
    let mut result = MailCardDavSyncResult {
        collection: collection.to_string(),
        ..MailCardDavSyncResult::default()
    };
    let mut changes = Vec::new();
    let mut known: HashMap<String, StoredCard> = HashMap::new();
    let now = now_ts();

    for mut stored in cards.into_iter().filter(|s| s.book == "carddav") {
        if stored.dirty {
            if stored.deleted {
                match &stored.href {
                    Some(href) => {
                        let url = match collection.join(href) {
                            Ok(url) => url,
                            Err(e) => {
                                result.errors.push(e.to_string());
                                continue;
                            }
                        };
                        let headers: Vec<(&str, String)> = stored
                            .etag
                            .iter()
                            .map(|e| ("If-Match", e.clone()))
                            .collect();
                        match client.send("DELETE", &url, None, None, &headers).await {
                            Ok(r) if (200..300).contains(&r.status) || r.status == 404 => {
                                result.pushed += 1;
                                changes.push(CardChange::Remove(stored.card.uid.clone()));
                                continue;
                            }
                            Ok(r) if r.status == 412 => {
                                result.conflicts += 1;
                                stored.deleted = false;
                                stored.dirty = false;
                                stored.etag = None;
                            }
                            Ok(r) => {
                                result.errors.push(format!(
                                    "delete {}: HTTP {}",
                                    stored.card.display_name, r.status
                                ));
                                continue;
                            }
                            Err(e) => {
                                result.errors.push(e);
                                continue;
                            }
                        }
                    }
                    None => {
                        changes.push(CardChange::Remove(stored.card.uid.clone()));
                        continue;
                    }
                }
            } else {
                let href = stored
                    .href
                    .clone()
                    .unwrap_or_else(|| href_path(collection, &card_file_name(&stored.card.uid)));
                let url = match collection.join(&href) {
                    Ok(url) => url,
                    Err(e) => {
                        result.errors.push(e.to_string());
                        continue;
                    }
                };
                let condition = match (&stored.href, &stored.etag) {
                    (Some(_), Some(etag)) => ("If-Match", etag.clone()),
                    (Some(_), None) => ("If-Match", "*".to_string()),
                    (None, _) => ("If-None-Match", "*".to_string()),
                };
                let body = serialize_vcard(&stored.card, now);
                let reply = client
                    .send(
                        "PUT",
                        &url,
                        None,
                        Some((body.clone(), "text/vcard; charset=utf-8")),
                        &[condition],
                    )
                    .await;
                match reply {
                    Ok(r) if (200..300).contains(&r.status) => {
                        result.pushed += 1;
                        stored.etag = etag_of(&r.headers);
                        stored.href = Some(href);
                        stored.dirty = false;
                        stored.card.raw = Some(body);
                    }
                    Ok(r) if r.status == 412 => {
                        // Someone else changed it: take the server copy.
                        result.conflicts += 1;
                        stored.dirty = false;
                        stored.etag = None;
                        stored.href = Some(href);
                    }
                    Ok(r) => result.errors.push(format!(
                        "upload {}: HTTP {}",
                        stored.card.display_name, r.status
                    )),
                    Err(e) => result
                        .errors
                        .push(format!("upload {}: {e}", stored.card.display_name)),
                }
            }
            changes.push(CardChange::Store(stored.clone()));
        }
        if let Some(href) = &stored.href {
            known.insert(href_path(collection, href), stored);
        }
    }

    // Pull: ETags of every card in the collection.
    let listing = match client.propfind(collection, "1", PROPFIND_ETAGS).await {
        Ok(listing) => listing,
        Err(e) => {
            result.errors.push(e);
            return (result, changes);
        }
    };
    let own_path = collection.path().to_string();
    let mut server: HashMap<String, String> = HashMap::new();
    for response in listing {
        let path = href_path(collection, &response.href);
        if path == own_path
            || path.trim_end_matches('/') == own_path.trim_end_matches('/')
            || has_type(&response, "collection")
        {
            continue;
        }
        server.insert(
            path,
            response.props.get("getetag").cloned().unwrap_or_default(),
        );
    }
    for (path, stored) in &known {
        if !server.contains_key(path) && !stored.dirty {
            result.removed += 1;
            changes.push(CardChange::Remove(stored.card.uid.clone()));
        }
    }
    let wanted: Vec<String> = server
        .iter()
        .filter(|(path, etag)| {
            known.get(*path).is_none_or(|s| {
                !s.dirty && (s.etag.as_deref() != Some(etag.as_str()) || etag.is_empty())
            })
        })
        .map(|(path, _)| path.clone())
        .collect();
    for chunk in wanted.chunks(50) {
        let fetched = fetch_cards(client, collection, chunk).await;
        match fetched {
            Ok(items) => {
                for (path, etag, text) in items {
                    for mut card in parse_vcards(&text) {
                        if card.uid.trim().is_empty() {
                            card.uid = path.clone();
                        }
                        let previous = known.get(&path);
                        if let Some(prev) = previous.filter(|p| p.card.uid != card.uid) {
                            changes.push(CardChange::Remove(prev.card.uid.clone()));
                        }
                        result.pulled += 1;
                        changes.push(CardChange::Store(StoredCard {
                            card,
                            book: "carddav".into(),
                            href: Some(path.clone()),
                            etag: Some(etag.clone()).filter(|e| !e.is_empty()),
                            dirty: false,
                            deleted: false,
                        }));
                    }
                }
            }
            Err(e) => result.errors.push(e),
        }
    }
    (result, changes)
}

pub(super) async fn fetch_cards(
    client: &DavClient,
    collection: &Url,
    paths: &[String],
) -> Result<Vec<(String, String, String)>, String> {
    let reply = client
        .send(
            "REPORT",
            collection,
            Some("1"),
            Some((multiget_body(paths), XML)),
            &[],
        )
        .await?;
    if reply.status == 207 {
        let items: Vec<_> = parse_multistatus(&reply.body)
            .into_iter()
            .filter_map(|r| {
                let data = r.props.get("address-data")?.clone();
                Some((
                    href_path(collection, &r.href),
                    r.props.get("getetag").cloned().unwrap_or_default(),
                    data,
                ))
            })
            .collect();
        if !items.is_empty() || paths.is_empty() {
            return Ok(items);
        }
    }
    // Servers without addressbook-multiget: fetch one by one.
    let mut items = Vec::new();
    for path in paths {
        let url = collection.join(path).map_err(|e| e.to_string())?;
        let reply = client.send("GET", &url, None, None, &[]).await?;
        if (200..300).contains(&reply.status) {
            items.push((
                path.clone(),
                etag_of(&reply.headers).unwrap_or_default(),
                reply.body,
            ));
        }
    }
    Ok(items)
}
