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
    database::mail_db_file_stem,
    parse_body_message,
};
use taomni_plugin_api::{
    HandshakeRequest, HandshakeResponse, RpcMessage, RpcRequest,
    services::{HOST_PROFILE_ENV, HostProfileContext, ProfileGeneration},
};

const ACCOUNT: &str = "existing-mail";
const WAIT: Duration = Duration::from_secs(15);

struct MailHost {
    child: Child,
    replies: Receiver<RpcMessage>,
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
        Self { child, replies }
    }

    fn call(&mut self, method: &str, params: Value) -> Value {
        let request = RpcRequest::new(method, method, Some(params));
        let input = self.child.stdin.as_mut().unwrap();
        serde_json::to_writer(&mut *input, &RpcMessage::Request(request.clone())).unwrap();
        input.write_all(b"\n").unwrap();
        input.flush().unwrap();
        let RpcMessage::Response(response) = self.replies.recv_timeout(WAIT).unwrap() else {
            panic!("expected a response to {method}");
        };
        assert_eq!(response.id.as_ref(), Some(&request.id));
        assert!(response.error.is_none(), "{method}: {:?}", response.error);
        response.result.unwrap()
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
            ]
            .map(String::from)
            .to_vec(),
            vec!["fs.dataDir".into()],
        );
        request.profile = Some(context.clone());
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
fn reads_retained_cache_and_releases_profile_ownership_on_exit() {
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
    fs::create_dir_all(&root).unwrap();
    let path = root.join(format!("{}.db", mail_db_file_stem(ACCOUNT)));
    {
        let db = Connection::open(&path).unwrap();
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
    }
    let before = fs::read(&path).unwrap();
    let mut host = MailHost::spawn(&profile, &context);
    host.handshake(&context);
    let folders = host.call("mail_list_cached_folders", json!({"accountId":ACCOUNT}));
    assert_eq!(folders[0]["name"], "INBOX");
    assert_eq!(folders[0]["cachedCount"], 1);
    let page = json!({"accountId":ACCOUNT,"folder":"INBOX","limit":1});
    let messages = host.call("mail_list_cached_messages", page);
    assert_eq!(messages[0]["subject"], "Original");

    let mut competing = MailHost::spawn(&profile, &context);
    assert_eq!(competing.exit_code(), Some(1));
    let params = json!({"accountId":ACCOUNT,"folder":"INBOX","uid":9});
    let body = host.call("mail_get_cached_body", params.clone());
    assert!(
        body["text"]
            .as_str()
            .unwrap()
            .contains("Profile retains mail")
    );
    drop(host.child.stdin.take());
    assert_eq!(host.exit_code(), Some(0));

    let mut reopened = MailHost::spawn(&profile, &context);
    reopened.handshake(&context);
    assert_eq!(reopened.call("mail_get_cached_body", params), body);
    drop(reopened.child.stdin.take());
    assert_eq!(reopened.exit_code(), Some(0));
    assert_eq!(fs::read(path).unwrap(), before);
}
