use super::{
    Runtime,
    actions::{self, Reply, Request},
    cards::{self, MESSAGE_CHARS},
    config::Config,
    network::{self, Network},
    protocol::Fragments,
};
use crate::mobile::Core;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

pub struct Outbound {
    pub chat: String,
    pub kind: &'static str,
    pub content: Value,
    pub uuid: String,
    /// Terminal to keep refreshing in place after this card is delivered.
    pub follow: Option<String>,
}
impl Outbound {
    pub fn text(chat: String, text: String, key: &str) -> Self {
        Self {
            chat,
            kind: "text",
            content: json!({"text":text.chars().take(MESSAGE_CHARS).collect::<String>()}),
            uuid: actions::key(key)[..32].into(),
            follow: None,
        }
    }
    /// Cards are built within `cards::CARD_BYTES` by their builders.
    pub fn reply(chat: String, reply: Reply, key: &str) -> Self {
        match reply {
            Reply::Text(text) => Self::text(chat, text, key),
            Reply::Card(card) => Self {
                chat,
                kind: "interactive",
                content: card,
                uuid: actions::key(key)[..32].into(),
                follow: None,
            },
            Reply::Terminal { card, term } => Self {
                chat,
                kind: "interactive",
                content: card,
                uuid: actions::key(key)[..32].into(),
                follow: Some(term),
            },
        }
    }
}
/// Card buttons that update the card in place instead of posting a new
/// message. The callback must answer within three seconds, so this path only
/// reads broker state and never waits on the Agent.
fn inline_card(
    runtime: &Runtime,
    core: &Core,
    config: &Config,
    request: &Request,
) -> Option<Value> {
    // A card forwarded to another chat must never refresh terminal output;
    // the same private-chat rule as `show`/`file` applies to buttons.
    if !request.private_chat {
        return None;
    }
    let mut parts = request.command.splitn(2, ' ');
    let action = parts.next().unwrap_or("");
    let id = parts.next().unwrap_or("").trim();
    if action == "term-unfollow" && id.starts_with("term:") {
        runtime.unfollow(&request.chat, id);
        let (title, status, tail) = actions::terminal_snapshot(core, id).ok()?;
        return Some(cards::terminal(
            config,
            id,
            &title,
            &status,
            &tail,
            false,
            Some(&request.chat),
        ));
    }
    if action == "term-refresh" && id.starts_with("term:") {
        let (title, status, tail) = actions::terminal_snapshot(core, id).ok()?;
        return Some(cards::terminal(
            config,
            id,
            &title,
            &status,
            &tail,
            runtime.is_following(&request.chat, id),
            Some(&request.chat),
        ));
    }
    None
}
pub async fn run(
    runtime: Arc<Runtime>,
    core: Core,
    network: Network,
    cancel: CancellationToken,
    events: broadcast::Receiver<Value>,
) {
    let (input, receiver) = mpsc::channel(64);
    let (output, outbound) = mpsc::channel(128);
    tokio::select! {
        _ = cancel.cancelled() => {},
        _ = socket_loop(runtime.clone(), core.clone(), network.clone(), input) => {},
        _ = business(runtime.clone(), core.clone(), network.config.clone(), receiver, output, events) => {},
        _ = delivery(runtime, core, network, outbound) => {},
    }
}
async fn socket_loop(
    runtime: Arc<Runtime>,
    core: Core,
    network: Network,
    input: mpsc::Sender<Request>,
) {
    let mut attempts = 0usize;
    loop {
        runtime.state("connecting", None);
        let started = Instant::now();
        match connection(&runtime, &core, &network, &input).await {
            Ok(()) => {}
            Err(code) => runtime.state("reconnecting", Some(code)),
        }
        if started.elapsed() >= Duration::from_secs(60) {
            attempts = 0;
        }
        runtime
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconnects += 1;
        tokio::time::sleep(Duration::from_secs([1, 2, 5, 10, 30][attempts.min(4)])).await;
        attempts = (attempts + 1).min(4);
    }
}
async fn connection(
    runtime: &Runtime,
    core: &Core,
    network: &Network,
    input: &mpsc::Sender<Request>,
) -> Result<(), String> {
    let (mut socket, service, mut interval) = network.connect().await?;
    runtime.state("connected", None);
    let mut fragments = Fragments::default();
    let mut next_ping = Instant::now();
    let mut last_frame = Instant::now();
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(next_ping.into()) => {
                if last_frame.elapsed() > interval * 2 + Duration::from_secs(5) { return Err("feishu_heartbeat_timeout".into()); }
                network::write(&mut socket, super::protocol::Frame::ping(service)).await?;
                next_ping = Instant::now() + interval;
            }
            result = network::read(&mut socket) => {
                let frame = result?;
                last_frame = Instant::now();
                if frame.method == 0 {
                    if frame.header("type") == "pong" {
                        if let Some(config) = frame.payload.as_deref().and_then(|p| serde_json::from_slice::<Value>(p).ok()) {
                            if let Some(seconds) = config["PingInterval"].as_u64() { interval = Duration::from_secs(seconds.clamp(1,300)); }
                        }
                    }
                    continue;
                }
                if frame.method != 1 { continue; }
                let bytes = match fragments.accept(&frame) {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => continue,
                    Err(code) => {
                        runtime.error(&code);
                        runtime.status.lock().unwrap_or_else(|e| e.into_inner()).rejected += 1;
                        network::write(&mut socket, frame.response(false, None)).await?;
                        continue;
                    }
                };
                let value: Value = match serde_json::from_slice(&bytes) {
                    Ok(value) => value,
                    Err(_) => {
                        runtime.error("feishu_invalid_event");
                        runtime.status.lock().unwrap_or_else(|e| e.into_inner()).rejected += 1;
                        network::write(&mut socket, frame.response(false, None)).await?;
                        continue;
                    }
                };
                let card = value["header"]["event_type"] == "card.action.trigger";
                let mut toast = "已受理，请查看机器人回复";
                let mut refreshed = None;
                let accepted = match actions::authorize(&network.config, &value) {
                    Ok(Some(request)) => {
                        if let Some(card) = inline_card(&runtime, core, &network.config, &request) {
                            refreshed = Some(card);
                            true
                        } else {
                            match input.try_reserve() {
                                Ok(permit) => match actions::claim(core, &request.key) {
                                    Ok(true) => { permit.send(request); true },
                                    Ok(false) => { runtime.status.lock().unwrap_or_else(|e| e.into_inner()).duplicates += 1; true },
                                    Err(error) => { runtime.error(&error); false },
                                },
                                Err(_) => { runtime.error("feishu_inbound_queue_full"); false },
                            }
                        }
                    }
                    Ok(None) => true,
                    Err(_) => {
                        runtime.status.lock().unwrap_or_else(|e| e.into_inner()).rejected += 1;
                        log::warn!("Feishu event rejected: application, identity, format or freshness check failed");
                        toast = "无权限或回调已过期";
                        true
                    }
                };
                if !accepted { toast = "暂未受理，队列繁忙或存储不可用，请稍后重试"; }
                let mut data = card.then(|| json!({"toast":{"type":"info","content":toast}}));
                if let (Some(card), Some(data)) = (refreshed, data.as_mut()) {
                    data["card"] = json!({"type":"raw","data":card});
                }
                network::write(&mut socket, frame.response(accepted, data)).await?;
            }
        }
    }
}
async fn business(
    runtime: Arc<Runtime>,
    core: Core,
    config: Config,
    mut input: mpsc::Receiver<Request>,
    output: mpsc::Sender<Outbound>,
    mut events: broadcast::Receiver<Value>,
) {
    let mut commands = tokio::task::JoinSet::new();
    let mut notifications = super::notifications::Notifications::default();
    loop {
        tokio::select! {
            Some(request) = input.recv(), if commands.len() < 4 => {
                let core = core.clone();
                let config = config.clone();
                commands.spawn(async move {
                    let reply = actions::execute_request(&core, &config, &request).await;
                    Outbound::reply(request.chat, reply, &request.key)
                });
            }
            Some(result) = commands.join_next(), if !commands.is_empty() => match result {
                Ok(value) => enqueue(&runtime, &output, value),
                Err(_) => runtime.error("feishu_command_failed"),
            },
            result = events.recv() => {
                match result {
                    Ok(event) => notifications.deliver(&runtime, &core, &config, &output, &event),
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        runtime.error("feishu_event_gap_reconciled");
                        let snapshots: Vec<_> = core.state().mobile.task_summaries.lock()
                            .unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
                        for event in snapshots { notifications.deliver(&runtime, &core, &config, &output, &event); }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}

pub(super) fn enqueue(runtime: &Runtime, output: &mpsc::Sender<Outbound>, value: Outbound) {
    if output.try_send(value).is_err() {
        runtime
            .status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .failed_deliveries += 1;
        runtime.error("feishu_outbound_queue_full_query_snapshot");
    }
}
async fn delivery(
    runtime: Arc<Runtime>,
    core: Core,
    network: Network,
    mut output: mpsc::Receiver<Outbound>,
) {
    while let Some(message) = output.recv().await {
        for attempt in 0..5 {
            match network
                .send(&message.chat, message.kind, &message.content, &message.uuid)
                .await
            {
                Ok(message_id) => {
                    runtime
                        .status
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .delivered += 1;
                    if let Some(term) = message.follow.clone() {
                        runtime.start_follow(
                            core.clone(),
                            network.clone(),
                            message.chat.clone(),
                            term,
                            message_id,
                        );
                    }
                    break;
                }
                Err(error) => {
                    runtime.error(&error);
                    if attempt == 4 {
                        runtime
                            .status
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .failed_deliveries += 1;
                    } else {
                        tokio::time::sleep(Duration::from_secs([1, 2, 5, 10][attempt])).await;
                    }
                }
            }
        }
    }
}
