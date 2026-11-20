use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

use rusqlite::Connection;
use serde_json::{Value, json};
use taomni_mail_engine::{
    MailFolder,
    cache::{init_mail_tables, upsert_folder, upsert_message},
    contacts::{MailAddressBookEntry, save_entry},
    database::mail_db_file_stem,
    drafts::{list_mail_drafts, save_mail_draft},
    migration::{LegacyMailbox, StagedMailData},
    parse_body_message,
    pop3::local_store::migrate_local_tables,
    storage,
};
use taomni_plugin_api::{
    HandshakeRequest, HandshakeResponse, RpcMessage, RpcRequest, RpcResponse,
    services::{
        HOST_PROFILE_ENV, HostInstanceId, HostProfileContext, ProfileGeneration, SNAPSHOT_METHOD,
        SNAPSHOT_PREPARE_METHOD, SNAPSHOT_RELEASE_METHOD, SnapshotResult,
    },
};
use taomni_sqlite_snapshot::SnapshotControl;

const ACCOUNT: &str = "existing-mail";
const WAIT: Duration = Duration::from_secs(15);
const HOST: &str = "b1234567-1234-1234-1234-123456789abc";
const JOB: &str = "c1234567-1234-1234-1234-123456789abc";
const STAGING: &str = "d1234567-1234-1234-1234-123456789abc";

struct MailHost {
    child: Child,
    replies: Receiver<RpcMessage>,
    next_request_id: i64,
}

impl MailHost {
    fn spawn(profile: &Path, context: &HostProfileContext) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_taomni-plugin-mail"))
            .env("TAOMNI_PLUGIN_TOKEN", "mail-profile-test-token")
            .env(
                HOST_PROFILE_ENV,
                json!({"root":profile,"context":context}).to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for text in BufReader::new(output).lines() {
                let frame = serde_json::from_str(&text.unwrap()).unwrap();
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            replies,
            next_request_id: 0,
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let response = self.send(method, params);
        assert!(response.error.is_none(), "{method}: {:?}", response.error);
        response.result.unwrap()
    }

    fn send(&mut self, method: &str, params: Value) -> RpcResponse {
        let request = RpcRequest::new(self.next_request_id, method, Some(params));
        self.next_request_id += 1;
        let input = self.child.stdin.as_mut().unwrap();
        serde_json::to_writer(&mut *input, &RpcMessage::Request(request.clone())).unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
        let RpcMessage::Response(response) = self.replies.recv_timeout(WAIT).unwrap() else {
            panic!("expected a response to {method}");
        };
        assert_eq!(response.id.as_ref(), Some(&request.id));
        response
    }

    fn handshake(&mut self, context: &HostProfileContext) {
        let mut request = HandshakeRequest::new(
            "taomni-plugin-mail",
            env!("CARGO_PKG_VERSION"),
            "mail-profile-test-token",
            [
                "mail_list_cached_folders",
                "mail_list_cached_messages",
                "mail_get_cached_body",
                "mail_list_drafts",
                "mail_save_draft",
                "mail_delete_draft",
                "mail_list_address_book",
                "mail_save_address_book_entry",
                "mail_delete_address_book_entry",
                "mail_search_contacts",
                SNAPSHOT_PREPARE_METHOD,
                SNAPSHOT_METHOD,
                SNAPSHOT_RELEASE_METHOD,
            ]
            .map(String::from)
            .to_vec(),
            vec!["fs.dataDir".into()],
        );
        request.profile = Some(context.clone());
        request.host_instance = Some(HostInstanceId::parse(HOST).unwrap());
        let data = self.call("plugin/handshake", serde_json::to_value(request).unwrap());
        let result: HandshakeResponse = serde_json::from_value(data).unwrap();
        assert!(result.accepted);
        assert_eq!(result.profile.as_ref(), Some(context));
    }

    fn exit_code(&mut self) -> Option<i32> {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("Mail host remained running");
    }
}

fn snapshot_cache(
    host: &mut MailHost,
    context: &HostProfileContext,
    profile: &Path,
    database: &str,
    attachment: &str,
) {
    let export = profile.join("backup-export");
    fs::create_dir(&export).unwrap();
    let prepared = host.call(
        SNAPSHOT_PREPARE_METHOD,
        json!({
            "job":JOB,
            "profileGeneration":context.generation,
            "destination":{
                "token":STAGING,"absoluteJobRoot":export,
                "allowedFiles":[database,attachment],"opaqueFiles":[attachment]
            },
        }),
    );
    let blocked = host.send(
        "mail_save_draft",
        json!({"accountId":ACCOUNT,"draft":{"id":"scheduled","subject":"blocked by backup"}}),
    );
    assert_eq!(blocked.error.unwrap().message, "PLUGIN_SNAPSHOT_BUSY");
    let snapshot = host.call(
        SNAPSHOT_METHOD,
        json!({
            "job":JOB,"staging":STAGING,"barrier":prepared["barrier"],
        }),
    );
    let snapshot: SnapshotResult = serde_json::from_value(snapshot).unwrap();
    assert_eq!(snapshot.files.len(), 2);
    assert_eq!(snapshot.host_instance.as_str(), HOST);
    let db = Connection::open_with_flags(
        export.join(database),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        list_mail_drafts(&db, ACCOUNT).unwrap()[0].subject,
        "Draft saved by the monolith"
    );
    let original = fs::read(profile.join("plugins/mail/data").join(attachment)).unwrap();
    assert!(original.starts_with(b"SQLite format 3\0"));
    assert_eq!(fs::read(export.join(attachment)).unwrap(), original);
    assert!(!export.join(format!("{database}-wal")).exists());
    assert!(!export.join(format!("{database}-shm")).exists());
    host.call(
        SNAPSHOT_RELEASE_METHOD,
        json!({"job":JOB,"barrier":prepared["barrier"]}),
    );
}

impl Drop for MailHost {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "requires an actual host process on a GitHub runner"]
fn reads_migrated_cache_and_releases_profile_ownership_on_exit() {
    let fixture = tempfile::tempdir().unwrap();
    let profile = fixture.path().canonicalize().unwrap();
    let context = HostProfileContext {
        owner: "mail".into(),
        generation: ProfileGeneration::parse("a1234567-1234-1234-1234-123456789abc").unwrap(),
    };
    fs::write(
        profile.join(".profile-state.json"),
        json!({"formatVersion":1,"generation":context.generation}).to_string(),
    )
    .unwrap();
    let root = profile.join("plugins/mail/data");
    let module = root.parent().unwrap();
    let old_storage = profile.join("external-mail-storage");
    fs::create_dir_all(module).unwrap();
    fs::create_dir(&old_storage).unwrap();
    let filename = format!("{}.db", mail_db_file_stem(ACCOUNT));
    let source = old_storage.join(&filename);
    let attachment = format!("attachments/{}/INBOX/9-1.bin", mail_db_file_stem(ACCOUNT));
    let attachment_path = old_storage.join(&attachment);
    fs::create_dir_all(attachment_path.parent().unwrap()).unwrap();
    {
        let attachment = Connection::open(&attachment_path).unwrap();
        attachment
            .execute_batch(
                "CREATE TABLE contents(value TEXT);
            INSERT INTO contents VALUES ('old attachment bytes');",
            )
            .unwrap();
    }
    let writer = {
        let db = Connection::open(&source).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        init_mail_tables(&db).unwrap();
        upsert_folder(
            &db,
            &MailFolder {
                account_id: ACCOUNT.into(),
                name: "INBOX".into(),
                ..MailFolder::default()
            },
        )
        .unwrap();
        let raw = b"Subject: Original\r\n\r\nProfile retains mail\r\n";
        upsert_message(
            &db,
            &parse_body_message(ACCOUNT, "INBOX", 9, None, raw, 1024),
        )
        .unwrap();
        let original = b"Subject: Original\r\n\r\nComplete migrated message\r\n";
        storage::store(&db, ACCOUNT, "INBOX", 9, 1, &original[..]).unwrap();
        migrate_local_tables(&db).unwrap();
        db.execute(
            "INSERT INTO mail_local_raw(account_id, folder, uid, raw) VALUES (?1, 'Sent', 3, ?2)",
            rusqlite::params![
                ACCOUNT,
                &b"Subject: Original sent mail\r\n\r\nSaved POP3 copy\r\n"[..]
            ],
        )
        .unwrap();
        let draft = serde_json::from_value(json!({
            "id":"scheduled",
            "subject":"Draft saved by the monolith",
            "to":["receiver@example.com"],
            "replyContext":{"outbox":{"sendAt":4102444800_i64,"queuedAt":1700000000_i64}}
        }))
        .unwrap();
        save_mail_draft(&db, ACCOUNT, draft).unwrap();
        save_entry(
            &db,
            ACCOUNT,
            MailAddressBookEntry {
                display_name: "Migrated Card".into(),
                emails: vec!["migrated@example.com".into()],
                ..Default::default()
            },
            "carddav",
        )
        .unwrap();
        db
    };
    let legacy_bytes = fs::read(&source).unwrap();
    let stage = StagedMailData::prepare(
        module,
        &[LegacyMailbox {
            account_id: ACCOUNT.into(),
            database: source.clone(),
        }],
        &SnapshotControl::with_timeout(WAIT),
    )
    .unwrap();
    assert_eq!(stage.mailbox_count(), 1);
    fs::rename(stage.data(), &root).unwrap();
    assert_eq!(fs::read(&source).unwrap(), legacy_bytes);
    drop(writer);
    let legacy_bytes = fs::read(&source).unwrap();
    let path = root.join(&filename);
    let before = fs::read(&path).unwrap();
    let mut host = MailHost::spawn(&profile, &context);
    host.handshake(&context);
    snapshot_cache(&mut host, &context, &profile, &filename, &attachment);
    let folders = host.call("mail_list_cached_folders", json!({"accountId":ACCOUNT}));
    assert_eq!(folders[0]["name"], "INBOX");
    assert_eq!(folders[0]["cachedCount"], 1);
    let page = json!({"accountId":ACCOUNT,"folder":"INBOX","limit":1});
    let messages = host.call("mail_list_cached_messages", page);
    assert_eq!(messages[0]["subject"], "Original");
    let drafts = host.call("mail_list_drafts", json!({"accountId":ACCOUNT,"limit":1}));
    assert_eq!(drafts[0]["subject"], "Draft saved by the monolith");
    assert_eq!(
        drafts[0]["replyContext"]["outbox"]["sendAt"],
        4102444800_i64
    );

    let mut competing = MailHost::spawn(&profile, &context);
    assert_eq!(competing.exit_code(), Some(1));
    let params = json!({"accountId":ACCOUNT,"folder":"INBOX","uid":9});
    let body = host.call("mail_get_cached_body", params.clone());
    assert!(
        body["text"]
            .as_str()
            .unwrap()
            .contains("Complete migrated message")
    );
    assert_eq!(body["source"], "archive");
    let sent_params = json!({"accountId":ACCOUNT,"folder":"Sent","uid":3});
    let sent = host.call("mail_get_cached_body", sent_params.clone());
    assert_eq!(sent["subject"], "Original sent mail");
    assert!(sent["text"].as_str().unwrap().contains("Saved POP3 copy"));
    assert_eq!(fs::read(&path).unwrap(), before);
    let listed = host.call(
        "mail_list_address_book",
        json!({"accountId":ACCOUNT,"limit":1}),
    );
    let contact = &listed[0];
    assert_eq!(contact["book"], "carddav");
    assert_eq!(contact["pendingSync"], true);
    let contact_uid = contact["uid"].as_str().unwrap();
    let search = json!({"accountId":ACCOUNT,"query":"migrated"});
    let original = host.call("mail_search_contacts", search.clone());
    assert_eq!(original[0]["name"], "Migrated Card");
    assert_eq!(original[0]["email"], "migrated@example.com");
    assert_eq!(original[0]["source"], "addressBook");
    let changed = host.call(
        "mail_save_address_book_entry",
        json!({"accountId":ACCOUNT,"entry":{
            "uid":contact_uid,"displayName":"Migrated Card Edited","emails":["migrated@example.com"]
        }}),
    );
    assert_eq!(changed["uid"], contact_uid);
    assert_eq!(changed["book"], "carddav");
    let saved = host.call(
        "mail_save_draft",
        json!({"accountId":ACCOUNT,"draft":{"id":"module-draft","subject":"Edited in the Mail host"}}),
    );
    assert_eq!(saved["id"], "module-draft");
    host.call(
        "mail_delete_draft",
        json!({"accountId":ACCOUNT,"draftId":"scheduled"}),
    );
    let after = fs::read(&path).unwrap();
    drop(host.child.stdin.take());
    assert_eq!(host.exit_code(), Some(0));

    let mut reopened = MailHost::spawn(&profile, &context);
    reopened.handshake(&context);
    assert_eq!(reopened.call("mail_get_cached_body", params), body);
    assert_eq!(reopened.call("mail_get_cached_body", sent_params), sent);
    let reopened_drafts = reopened.call("mail_list_drafts", json!({"accountId":ACCOUNT}));
    assert_eq!(reopened_drafts, json!([saved]));
    let suggestions = reopened.call("mail_search_contacts", search);
    assert_eq!(suggestions[0]["name"], "Migrated Card Edited");
    assert_eq!(suggestions[0]["email"], "migrated@example.com");
    drop(reopened.child.stdin.take());
    assert_eq!(reopened.exit_code(), Some(0));
    assert_eq!(fs::read(path).unwrap(), after);
    assert_eq!(fs::read(source).unwrap(), legacy_bytes);
}
