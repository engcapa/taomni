use super::{
    Runtime,
    actions::{self, Request},
    config::Config,
    network::{self, Network},
    protocol::Fragments,
};
use crate::mobile::Core;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
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
}
impl Outbound {
    pub fn text(chat: String, text: String, key: &str) -> Self {
        Self {
            chat,
            kind: "text",
            content: json!({"text":text.chars().take(2000).collect::<String>()}),
            uuid: actions::key(key)[..32].into(),
        }
    }
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
        _ = business(runtime.clone(), core, network.config.clone(), receiver, output, events) => {},
        _ = delivery(runtime, network, outbound) => {},
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
        runtime.status.lock().unwrap().reconnects += 1;
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
                let Some(bytes) = fragments.accept(&frame)? else { continue; };
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| "feishu_invalid_event")?;
                let card = value["header"]["event_type"] == "card.action.trigger";
                let mut toast = "已受理，请查看机器人回复";
                let accepted = match actions::authorize(&network.config, &value) {
                    Ok(Some(request)) => {
                        match input.try_reserve() {
                            Ok(permit) => match actions::claim(core, &request.key) {
                                Ok(true) => { permit.send(request); true },
                                Ok(false) => { runtime.status.lock().unwrap().duplicates += 1; true },
                                Err(error) => { runtime.error(&error); false },
                            },
                            Err(_) => { runtime.error("feishu_inbound_queue_full"); false },
                        }
                    }
                    Ok(None) => true,
                    Err(_) => {
                        runtime.status.lock().unwrap().rejected += 1;
                        log::warn!("Feishu event rejected: application, identity, format or freshness check failed");
                        toast = "无权限或回调已过期";
                        true
                    }
                };
                if !accepted { toast = "暂未受理，队列繁忙或存储不可用，请稍后重试"; }
                let data = card.then(|| json!({"toast":{"type":"info","content":toast}}));
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
    loop {
        tokio::select! {
            Some(request) = input.recv() => {
                let text = actions::execute(&core, &config, &request.command).await;
                enqueue(&runtime, &output, Outbound::text(request.chat, text, &request.key));
            }
            result = events.recv() => {
                match result {
                    Ok(event) => {
                        if event["type"] != "task_status" { continue; }
                        let status = event["status"].as_str().unwrap_or("");
                        if status != "awaiting_confirmation" && status != "idle" { continue; }
                        let task = event["task_id"].as_str().unwrap_or("");
                        let summary = event["summary"].as_str().unwrap_or("");
                        if status == "idle" && !matches!(summary,"turn_finished"|"turn_failed"|"stopped") { continue; }
                        let confirmations = if status == "awaiting_confirmation" {
                            task.strip_prefix("thread:").map(|tid| crate::mobile::agent_view::confirmations(&core.state(),tid)).unwrap_or_default()
                        } else { vec![] };
                        let chats: HashSet<_> = config.bindings.iter().map(|b| b.chat_id.clone()).collect();
                        for chat in chats {
                            let id = format!("{}:{}:{}",runtime.instance,event["seq"],chat);
                            if confirmations.is_empty() {
                                enqueue(&runtime, &output, Outbound::text(chat,format!("{}{}",actions::bounded(&format!("Taomni {task} · {status}\n{summary}")),actions::link(&config)),&id));
                            } else {
                                for confirmation in &confirmations {
                                    enqueue(&runtime,&output,Outbound { chat:chat.clone(),kind:"interactive",content:actions::confirmation_card(&config,task,confirmation),
                                        uuid:actions::key(&format!("{id}:{}",confirmation["id"]))[..32].into() });
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => runtime.error("feishu_event_gap_query_list"),
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }
    }
}
fn enqueue(runtime: &Runtime, output: &mpsc::Sender<Outbound>, value: Outbound) {
    if output.try_send(value).is_err() {
        runtime.status.lock().unwrap().failed_deliveries += 1;
        runtime.error("feishu_outbound_queue_full_query_snapshot");
    }
}
async fn delivery(runtime: Arc<Runtime>, network: Network, mut output: mpsc::Receiver<Outbound>) {
    while let Some(message) = output.recv().await {
        for attempt in 0..5 {
            match network
                .send(&message.chat, message.kind, &message.content, &message.uuid)
                .await
            {
                Ok(()) => {
                    runtime.status.lock().unwrap().delivered += 1;
                    break;
                }
                Err(error) => {
                    runtime.error(&error);
                    if attempt == 4 {
                        runtime.status.lock().unwrap().failed_deliveries += 1;
                    } else {
                        tokio::time::sleep(Duration::from_secs([1, 2, 5, 10][attempt])).await;
                    }
                }
            }
        }
    }
}
