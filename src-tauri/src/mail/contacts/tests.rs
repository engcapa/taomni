use super::dav_protocol::card_file_name;
use super::dav_sync::sync_collection;
use super::entries::delete_entry;
use super::entries::export_cards;
use super::entries::import_cards;
use super::entries::save_entry;
use super::model::MailAddressBookEntry;
use super::storage::apply_changes;
use super::storage::load_cards;
use super::suggestions::address_book_suggestions;
use super::suggestions::merge_suggestions;
use crate::mail::MailContactSuggestion;
use crate::mail::webdav::CARDDAV;
use crate::mail::webdav::DavAuth;
use crate::mail::webdav::DavClient;
use crate::mail::webdav::has_type;
use crate::mail::webdav::parse_multistatus;
use reqwest::Url;
use rusqlite::Connection;
use std::collections::HashMap;

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct FakeDav {
    cards: BTreeMap<String, (String, String)>,
    next_etag: u32,
    log: Vec<String>,
}

const BOOK: &str = "/dav/books/u/contacts/";

fn card_text(uid: &str, name: &str, email: &str) -> String {
    format!(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{uid}\r\nFN:{name}\r\nEMAIL:{email}\r\nX-CUSTOM:keep\r\nEND:VCARD\r\n"
    )
}

fn multistatus(responses: &[String]) -> String {
    format!(
        r#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">{}</d:multistatus>"#,
        responses.concat()
    )
}

fn response(href: &str, props: &str) -> String {
    format!(
        "<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:displayname/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>"
    )
}

fn handle(
    dav: &Mutex<FakeDav>,
    method: &str,
    path: &str,
    headers: &HashMap<String, String>,
    body: &str,
) -> (u16, Vec<(String, String)>, String) {
    let mut dav = dav.lock().unwrap();
    dav.log.push(format!("{method} {path}"));
    if headers.get("authorization").map(String::as_str) != Some("Basic dTpw") {
        return (401, vec![], String::new());
    }
    let depth = headers.get("depth").cloned().unwrap_or_default();
    match (method, path) {
        ("PROPFIND", "/.well-known/carddav") => (
            301,
            vec![("Location".into(), "/dav/".into())],
            String::new(),
        ),
        ("PROPFIND", "/dav/") => (
            207,
            vec![],
            multistatus(&[response(
                "/dav/",
                "<d:resourcetype><d:collection/></d:resourcetype><d:current-user-principal><d:href>/dav/principals/u/</d:href></d:current-user-principal>",
            )]),
        ),
        ("PROPFIND", "/dav/principals/u/") => (
            207,
            vec![],
            multistatus(&[response(
                "/dav/principals/u/",
                "<d:resourcetype><d:principal/></d:resourcetype><card:addressbook-home-set><d:href>/dav/books/u/</d:href></card:addressbook-home-set>",
            )]),
        ),
        ("PROPFIND", "/dav/books/u/") => (
            207,
            vec![],
            multistatus(&[
                response(
                    "/dav/books/u/",
                    "<d:resourcetype><d:collection/></d:resourcetype>",
                ),
                response(
                    BOOK,
                    "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>",
                ),
            ]),
        ),
        ("PROPFIND", BOOK) => {
            let mut items = vec![response(
                BOOK,
                "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>",
            )];
            if depth == "1" {
                for (href, (etag, _)) in &dav.cards {
                    items.push(response(
                        href,
                        &format!("<d:resourcetype/><d:getetag>&quot;{etag}&quot;</d:getetag>"),
                    ));
                }
            }
            (207, vec![], multistatus(&items))
        }
        ("REPORT", BOOK) => {
            let items: Vec<String> = body
                    .split("<d:href>")
                    .skip(1)
                    .filter_map(|part| part.split("</d:href>").next())
                    .filter_map(|href| {
                        let (etag, text) = dav.cards.get(href)?;
                        Some(response(href, &format!("<d:getetag>\"{etag}\"</d:getetag><card:address-data>{text}</card:address-data>")))
                    })
                    .collect();
            (207, vec![], multistatus(&items))
        }
        ("PUT", _) => {
            let current = dav.cards.get(path).map(|(etag, _)| format!("\"{etag}\""));
            let if_match = headers.get("if-match");
            let if_none = headers.get("if-none-match");
            let conflict = (if_none.is_some() && current.is_some())
                || if_match.is_some_and(|want| want != "*" && Some(want) != current.as_ref())
                || (if_match.is_some() && current.is_none());
            if conflict {
                return (412, vec![], String::new());
            }
            dav.next_etag += 1;
            let etag = format!("e{}", dav.next_etag);
            dav.cards
                .insert(path.to_string(), (etag.clone(), body.to_string()));
            (
                201,
                vec![("ETag".into(), format!("\"{etag}\""))],
                String::new(),
            )
        }
        ("DELETE", _) => {
            let current = dav.cards.get(path).map(|(etag, _)| format!("\"{etag}\""));
            if headers
                .get("if-match")
                .is_some_and(|want| Some(want) != current.as_ref())
            {
                return (412, vec![], String::new());
            }
            dav.cards.remove(path);
            (204, vec![], String::new())
        }
        _ => (404, vec![], String::new()),
    }
}

fn start(dav: Arc<Mutex<FakeDav>>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let dav = Arc::clone(&dav);
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    return;
                }
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let mut headers = HashMap::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
                    }
                }
                let length: usize = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                let _ = reader.read_exact(&mut body);
                let (status, extra, text) = handle(
                    &dav,
                    &method,
                    &path,
                    &headers,
                    &String::from_utf8_lossy(&body),
                );
                let mut reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    text.len()
                );
                for (name, value) in extra {
                    reply.push_str(&format!("{name}: {value}\r\n"));
                }
                reply.push_str("\r\n");
                reply.push_str(&text);
                let _ = stream.write_all(reply.as_bytes());
            });
        }
    });
    port
}

fn db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    crate::mail::init_mail_tables(&conn).unwrap();
    conn
}

#[test]
fn multistatus_keeps_only_successful_props() {
    let xml = multistatus(&[response(
        "/a/",
        "<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:getetag>&quot;x&amp;y&quot;</d:getetag>",
    )]);
    let parsed = parse_multistatus(&xml);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].href, "/a/");
    assert!(has_type(&parsed[0], "addressbook"));
    assert_eq!(
        parsed[0].props.get("getetag").map(String::as_str),
        Some("\"x&y\"")
    );
    assert!(
        !parsed[0].props.contains_key("displayname"),
        "404 propstat dropped"
    );
}

#[test]
fn local_entries_suggestions_and_files() {
    let conn = db();
    let saved = save_entry(
        &conn,
        "acct",
        MailAddressBookEntry {
            display_name: "Jane Doe".into(),
            emails: vec![" jane@example.com ".into()],
            ..Default::default()
        },
        "local",
    )
    .unwrap();
    assert!(!saved.uid.is_empty());
    assert_eq!(saved.book, "local");
    assert!(!saved.pending_sync);
    assert!(save_entry(&conn, "acct", MailAddressBookEntry::default(), "local").is_err());
    let bad = MailAddressBookEntry {
        display_name: "x".into(),
        emails: vec!["nope".into()],
        ..Default::default()
    };
    assert!(
        save_entry(&conn, "acct", bad, "local")
            .unwrap_err()
            .contains("not an email")
    );

    let hits = address_book_suggestions(&conn, "acct", "doe", 5).unwrap();
    assert_eq!(hits[0].email, "jane@example.com");
    assert_eq!(hits[0].source, "addressBook");
    let collected = vec![MailContactSuggestion {
        name: None,
        email: "JANE@example.com".into(),
        source: "history".into(),
        score: 10,
        last_seen_at: None,
    }];
    assert_eq!(
        merge_suggestions(hits, collected, 5).len(),
        1,
        "dedupe by email"
    );

    assert_eq!(
        import_cards(
            &conn,
            "acct",
            &card_text("imp-1", "Imported", "imp@example.com"),
            "local"
        )
        .unwrap(),
        1
    );
    let (text, count) = export_cards(&conn, "acct").unwrap();
    assert_eq!(count, 2);
    assert!(text.contains("UID:imp-1") && text.contains("X-CUSTOM:keep"));
    assert!(delete_entry(&conn, "acct", &saved.uid).unwrap());
    assert_eq!(load_cards(&conn, "acct").unwrap().len(), 1);
}

#[tokio::test]
async fn carddav_discovers_pushes_pulls_and_resolves_conflicts() {
    let dav = Arc::new(Mutex::new(FakeDav::default()));
    dav.lock().unwrap().cards.insert(
        format!("{BOOK}a1.vcf"),
        ("s1".into(), card_text("a1", "Alice", "alice@example.com")),
    );
    let port = start(Arc::clone(&dav));
    let client = DavClient::new(CARDDAV, DavAuth::Basic("u".into(), "p".into()), false).unwrap();
    let start_url = Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap();
    let collection = client.discover(&start_url).await.unwrap();
    assert_eq!(collection.path(), BOOK);

    let conn = db();
    let local = save_entry(
        &conn,
        "acct",
        MailAddressBookEntry {
            display_name: "New Person".into(),
            emails: vec!["new@example.com".into()],
            ..Default::default()
        },
        "carddav",
    )
    .unwrap();
    assert!(local.pending_sync);

    let (result, changes) =
        sync_collection(&client, &collection, load_cards(&conn, "acct").unwrap()).await;
    apply_changes(&conn, "acct", &changes).unwrap();
    assert_eq!(
        (result.pushed, result.pulled, result.conflicts),
        (1, 1, 0),
        "{result:?}"
    );
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    let cards = load_cards(&conn, "acct").unwrap();
    assert_eq!(cards.len(), 2);
    assert!(cards.iter().all(|c| !c.dirty && c.href.is_some()));
    let pushed_path = format!("{BOOK}{}", card_file_name(&local.uid));
    assert!(
        dav.lock().unwrap().cards[&pushed_path]
            .1
            .contains("EMAIL;TYPE=INTERNET:new@example.com")
    );

    // Server edits Alice and deletes the new card; we edit Alice too.
    {
        let mut server = dav.lock().unwrap();
        server.cards.insert(
            format!("{BOOK}a1.vcf"),
            (
                "s9".into(),
                card_text("a1", "Alice Server", "alice@server.example"),
            ),
        );
        server.cards.remove(&pushed_path);
    }
    let alice = cards.iter().find(|c| c.card.uid == "a1").unwrap();
    save_entry(
        &conn,
        "acct",
        MailAddressBookEntry {
            uid: "a1".into(),
            display_name: "Alice Local".into(),
            emails: vec!["alice@local.example".into()],
            ..Default::default()
        },
        "carddav",
    )
    .unwrap();
    assert_eq!(alice.book, "carddav");
    let (result, changes) =
        sync_collection(&client, &collection, load_cards(&conn, "acct").unwrap()).await;
    apply_changes(&conn, "acct", &changes).unwrap();
    assert_eq!(
        (result.conflicts, result.removed, result.pulled),
        (1, 1, 1),
        "{result:?}"
    );
    let cards = load_cards(&conn, "acct").unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].card.display_name, "Alice Server", "server wins");

    // Deleting locally removes the server copy.
    delete_entry(&conn, "acct", "a1").unwrap();
    let (result, changes) =
        sync_collection(&client, &collection, load_cards(&conn, "acct").unwrap()).await;
    apply_changes(&conn, "acct", &changes).unwrap();
    assert_eq!(result.pushed, 1, "{result:?}");
    assert!(dav.lock().unwrap().cards.is_empty());
    assert!(load_cards(&conn, "acct").unwrap().is_empty());

    let bad = DavClient::new(CARDDAV, DavAuth::Basic("u".into(), "wrong".into()), false).unwrap();
    assert!(
        bad.discover(&start_url)
            .await
            .unwrap_err()
            .contains("login rejected")
    );
}
