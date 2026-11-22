use super::*;
use crate::redirector_bridge::{parse_options, process_start_micros};
use taomni_redirector::bridge_protocol::encode_line;
use taomni_redirector::ipc::{InterceptConf, read_optional_frame};
use tokio::io::{AsyncBufReadExt, BufReader, duplex};
use tokio::process::Command;

#[tokio::test]
async fn module_exit_after_apply_resets_scope_before_sending_stopped() {
    let mut owner = Command::new("/bin/sleep")
        .arg("30")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = owner.id().unwrap();
    let birth = process_start_micros(pid).unwrap();
    let core = std::process::id();
    let flow_path = format!("/tmp/taomni-redirector-flow-unit-{core}.sock");
    let provider_path = format!("/tmp/taomni-redirector-provider-unit-{core}.sock");
    let listener = UnixListener::bind(&provider_path).unwrap();
    let _cleanup = crate::redirector_bridge::SocketCleanup(provider_path.clone().into());
    let options = parse_options(
        [
            "--parent-pid",
            &core.to_string(),
            "--module-host",
            &format!("{pid}:{birth}"),
            "--provider-socket",
            &provider_path,
            "--flow-socket",
            &flow_path,
            "--redirector",
            "/bin/sleep",
        ]
        .into_iter()
        .map(str::to_owned),
        true,
    )
    .unwrap();
    let (control, mut provider) = UnixStream::pair().unwrap();
    let (command_input, mut commands) = duplex(4096);
    let (event_output, events) = duplex(4096);
    let mut launcher = Command::new("/bin/sleep")
        .arg("30")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut signals = ShutdownSignals::new().unwrap();
    let bridge = manage(
        &options,
        &listener,
        &mut launcher,
        &mut signals,
        (control, core),
        BufReader::new(command_input),
        event_output,
    );
    let observe = async {
        let mut lines = BufReader::new(events).lines();
        let event = |line: String| decode_line::<BridgeEvent>(&line).unwrap();
        assert!(matches!(
            event(lines.next_line().await.unwrap().unwrap()),
            BridgeEvent::ControlReady { .. }
        ));
        let actions = vec!["/Applications/QA Fixture.app/".to_string()];
        let apply = BridgeCommand::Apply {
            version: BRIDGE_PROTOCOL_VERSION,
            request_id: 1,
            session_id: "qa-scope".into(),
            generation: 1,
            actions: actions.clone(),
        };
        commands
            .write_all(encode_line(&apply).unwrap().as_bytes())
            .await
            .unwrap();
        let applied: InterceptConf = read_optional_frame(&mut provider).await.unwrap().unwrap();
        assert_eq!(applied.actions, actions);
        assert!(matches!(
            event(lines.next_line().await.unwrap().unwrap()),
            BridgeEvent::Applied { request_id: 1, .. }
        ));
        owner.kill().await.unwrap();
        let inert: InterceptConf = read_optional_frame(&mut provider).await.unwrap().unwrap();
        assert_eq!(inert.actions.len(), 1);
        assert!(inert.actions[0].starts_with("/__taomni_no_process__/"));
        assert!(matches!(event(lines.next_line().await.unwrap().unwrap()),
            BridgeEvent::Stopped { request_id: 0, generation: 1, session_id, .. } if session_id == "qa-scope"));
        assert!(
            read_optional_frame::<_, InterceptConf>(&mut provider)
                .await
                .unwrap()
                .is_none()
        );
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(7), async {
        tokio::join!(bridge, observe)
    })
    .await
    .unwrap();
    result.unwrap();
    launcher.kill().await.unwrap();
}
