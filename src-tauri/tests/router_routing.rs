//! Tests for the LlmRouter — verifies fallback, task routing, full-local
//! filtering. None of these tests touch the network.

mod support;

use newmob_lib::llm::router::{FallbackConfig, LlmRouter};
use newmob_lib::llm::{ChatRequest, TaskKind};
use std::sync::Arc;
use std::time::Duration;
use support::mock_provider::{MockEvent, MockLlm};

fn req() -> ChatRequest {
    ChatRequest::simple("test sys", "ping")
}

#[tokio::test]
async fn complete_returns_active_when_no_routing() {
    let mut r = LlmRouter::new("active-id");
    r.add_provider("active-id", Arc::new(MockLlm::new(vec![MockEvent::Token("OK".into())])));

    let resp = r.complete(req(), TaskKind::ChatDrawer).await.unwrap();
    assert_eq!(resp.content, "OK");
}

#[tokio::test]
async fn task_routing_overrides_active() {
    let mut r = LlmRouter::new("active-id");
    r.add_provider("active-id", Arc::new(MockLlm::new(vec![MockEvent::Token("FROM-ACTIVE".into())])));
    r.add_provider("local", Arc::new(MockLlm::new(vec![MockEvent::Token("FROM-LOCAL".into())])));
    r.set_task_route(TaskKind::TabCompletion, "local");

    let resp = r.complete(req(), TaskKind::TabCompletion).await.unwrap();
    assert_eq!(resp.content, "FROM-LOCAL");
}

#[tokio::test]
async fn fallback_kicks_in_on_timeout() {
    let mut r = LlmRouter::new("primary");
    r.add_provider("primary", Arc::new(MockLlm::new(vec![
        MockEvent::Wait(Duration::from_millis(800)),
        MockEvent::Token("TOO-SLOW".into()),
    ])));
    r.add_provider("secondary", Arc::new(MockLlm::new(vec![MockEvent::Token("FALLBACK".into())])));
    r.set_fallback(FallbackConfig {
        primary: "primary".into(),
        secondary: "secondary".into(),
        timeout_ms: 100,
    });

    let resp = r.complete(req(), TaskKind::ChatDrawer).await.unwrap();
    assert_eq!(resp.content, "FALLBACK");
}

#[tokio::test]
async fn fallback_kicks_in_on_provider_error() {
    let mut r = LlmRouter::new("primary");
    r.add_provider("primary", Arc::new(MockLlm::new(vec![MockEvent::Error("503".into())])));
    r.add_provider("secondary", Arc::new(MockLlm::new(vec![MockEvent::Token("FALLBACK".into())])));
    r.set_fallback(FallbackConfig {
        primary: "primary".into(),
        secondary: "secondary".into(),
        timeout_ms: 5_000,
    });

    let resp = r.complete(req(), TaskKind::ChatDrawer).await.unwrap();
    assert_eq!(resp.content, "FALLBACK");
}

#[tokio::test]
async fn provider_for_task_falls_back_to_active() {
    let r = LlmRouter::new("default-active");
    assert_eq!(r.provider_for_task(TaskKind::ChatDrawer), "default-active");
}
