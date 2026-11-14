//! Real-PTY regressions for viewing terminals, sending input and key presses.
use super::{
    actions::{self, Reply},
    tests::config,
};
use crate::mobile::{Core, service_tests::Fixture};
use std::{io::Read, sync::Mutex, time::Duration};

struct TestTerminal {
    id: &'static str,
    reader: Option<std::thread::JoinHandle<()>>,
}

impl TestTerminal {
    async fn start(f: &Fixture, id: &'static str) -> Self {
        use crate::terminal::{ActiveTerminal, pty};
        let program = if cfg!(windows) { "cmd.exe" } else { "/bin/sh" };
        let args = if cfg!(windows) {
            vec!["/Q".into()]
        } else {
            vec![]
        };
        let (pty, mut reader) = pty::create_command_pty(80, 24, program, &args).unwrap();
        f.state.mobile.broker.register(id);
        f.state.terminal.terminals.write().await.insert(
            id.into(),
            ActiveTerminal::Local {
                _route: crate::database::forward::ForwardGuard(None),
                writer: Mutex::new(pty.writer),
                master: Mutex::new(pty.master),
                child: Mutex::new(pty.child),
            },
        );
        let broker = f.state.mobile.broker.clone();
        let reader = std::thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(n) = reader.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                broker.output(id, &bytes[..n]);
            }
            broker.exit(id);
        });
        // Wait for the shell prompt before typing: input sent while the shell
        // is still preparing its terminal can be flushed by job-control setup.
        wait_for("shell prompt", || !Self::tail(f).is_empty()).await;
        Self {
            id,
            reader: Some(reader),
        }
    }
    fn tail(f: &Fixture) -> String {
        f.state.mobile.broker.terminals.lock().unwrap()["feishu-term"].tail(50, 4000)
    }
    async fn stop(mut self, f: &Fixture) {
        let _ = crate::terminal::send_terminal_signal_inner(&f.state, self.id, "SIGKILL").await;
        if let Some(reader) = self.reader.take() {
            let _ = tokio::task::spawn_blocking(move || reader.join()).await;
        }
    }
}

async fn wait_for(label: &str, mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {label}"));
}

#[tokio::test]
async fn terminal_card_follows_real_output_and_input_reaches_the_pty() {
    let _pty = crate::terminal::pty::test_lock();
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    let terminal = TestTerminal::start(&f, "feishu-term").await;
    let id = "term:feishu-term";
    let view = actions::execute(&core, &config(), &format!("term {id}")).await;
    assert!(matches!(&view, Reply::Terminal { .. }));
    let card = view.text();
    assert!(card.contains("Taomni 终端"), "{card}");
    assert!(card.contains("\"update_multi\":true"), "{card}");
    let input = actions::execute_request(
        &core,
        &config(),
        &actions::request(&format!("input {id} echo FEISHU_INPUT"), true),
    )
    .await;
    assert!(!input.text().contains("操作失败"), "{}", input.text());
    wait_for("FEISHU_INPUT", || {
        TestTerminal::tail(&f).contains("FEISHU_INPUT")
    })
    .await;
    let after = actions::execute_request(
        &core,
        &config(),
        &actions::request(&format!("show {id}"), true),
    )
    .await;
    assert!(after.text().contains("FEISHU_INPUT"), "{}", after.text());
    terminal.stop(&f).await;
    f.finish().await;
}

#[tokio::test]
async fn focused_input_and_key_presses_need_no_repeated_id() {
    let _pty = crate::terminal::pty::test_lock();
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    let terminal = TestTerminal::start(&f, "feishu-term").await;
    let id = "term:feishu-term";
    let request = actions::request(&format!("term {id}"), true);
    actions::execute_request(&core, &config(), &request).await;
    let input = actions::request("input echo FOCUSED_TEXT", true);
    let reply = actions::execute_request(&core, &config(), &input).await;
    assert!(reply.text().contains("Taomni 终端"));
    wait_for("FOCUSED_TEXT", || {
        TestTerminal::tail(&f).contains("FOCUSED_TEXT")
    })
    .await;
    // A key press uses the same focused terminal.
    let key = actions::request("key enter", true);
    actions::execute_request(&core, &config(), &key).await;
    terminal.stop(&f).await;
    f.finish().await;
}

#[tokio::test]
async fn terminal_content_and_input_are_private_chat_only() {
    let _pty = crate::terminal::pty::test_lock();
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    let terminal = TestTerminal::start(&f, "feishu-term").await;
    for command in [
        "term term:feishu-term",
        "input term:feishu-term echo nope",
        "saved",
        "open missing",
        "new",
    ] {
        let reply =
            actions::execute_request(&core, &config(), &actions::request(command, false)).await;
        assert!(
            reply.text().contains("仅允许已绑定的私聊"),
            "{command}: {}",
            reply.text()
        );
    }
    assert!(!TestTerminal::tail(&f).contains("nope"));
    terminal.stop(&f).await;
    f.finish().await;
}

#[tokio::test]
async fn input_without_a_terminal_id_or_focus_is_actionable() {
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    let request = actions::request("input hello", true);
    let reply = actions::execute_request(&core, &config(), &request).await;
    assert!(reply.text().contains("未指定终端"), "{}", reply.text());
    let unknown = actions::request("key nonsense", true);
    let reply = actions::execute_request(&core, &config(), &unknown).await;
    assert!(reply.text().contains("未指定终端"), "{}", reply.text());
    f.finish().await;
}

#[tokio::test]
async fn sending_terminal_input_auto_refreshes_the_returned_card_output() {
    let _pty = crate::terminal::pty::test_lock();
    let f = Fixture::new().await;
    let core = Core::Headless(f.state.clone());
    let terminal = TestTerminal::start(&f, "feishu-term").await;
    let id = "term:feishu-term";
    let reply = actions::execute_request(
        &core,
        &config(),
        &actions::request(&format!("input {id} echo IMMEDIATE_FEISHU_AUTO"), true),
    )
    .await;
    assert!(
        reply.text().contains("IMMEDIATE_FEISHU_AUTO"),
        "expected immediate input reply card to include fresh stdout without calling show: {}",
        reply.text()
    );
    terminal.stop(&f).await;
    f.finish().await;
}
