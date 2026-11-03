use reqwest::{Client, StatusCode};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::super::{InvocationProtocol, http_failure, invoke_stream};
use super::request;

fn client() -> Client {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .unwrap()
}

#[test]
fn chat_request_has_correct_tokens_messages_and_no_optional_sampling() {
    let req = request(InvocationProtocol::OpenaiChat);
    let built = super::super::request::build(&client(), &req).unwrap();
    let value: Value = serde_json::from_slice(built.body().unwrap().as_bytes().unwrap()).unwrap();
    assert_eq!(built.method(), reqwest::Method::POST);
    assert_eq!(
        built.url().as_str(),
        "https://example.test/v1/chat/completions"
    );
    assert_eq!(
        built.headers()["authorization"],
        "Bearer secret-never-print"
    );
    assert_eq!(built.headers()["accept"], "text/event-stream");
    assert_eq!(value["max_completion_tokens"], 4096);
    assert_eq!(value["messages"][0]["role"], "system");
    assert_eq!(value["messages"][1]["content"], "User input");
    assert_eq!(value["stream"], true);
    assert_eq!(value["stream_options"]["include_usage"], true);
    assert_eq!(value["store"], false);
    assert!(value.get("max_tokens").is_none());
    assert!(value.get("temperature").is_none());
    assert!(value.get("tools").is_none());
}

#[test]
fn responses_request_is_independent_and_disables_storage() {
    let req = request(InvocationProtocol::OpenaiResponses);
    let built = super::super::request::build(&client(), &req).unwrap();
    let value: Value = serde_json::from_slice(built.body().unwrap().as_bytes().unwrap()).unwrap();
    assert_eq!(built.url().path(), "/v1/responses");
    assert_eq!(value["input"], "User input");
    assert_eq!(value["instructions"], "Trusted instructions");
    assert_eq!(value["max_output_tokens"], 4096);
    assert_eq!(value["store"], false);
    assert!(value.get("max_completion_tokens").is_none());
    assert!(value.get("messages").is_none());
    assert!(value.get("temperature").is_none());
}

#[test]
fn messages_request_has_pinned_version_and_correct_auth_and_system() {
    let req = request(InvocationProtocol::AnthropicMessages);
    let built = super::super::request::build(&client(), &req).unwrap();
    let value: Value = serde_json::from_slice(built.body().unwrap().as_bytes().unwrap()).unwrap();
    assert_eq!(built.url().path(), "/v1/messages");
    assert_eq!(built.headers()["anthropic-version"], "2023-06-01");
    assert_eq!(built.headers()["x-api-key"], "secret-never-print");
    assert!(built.headers()["x-api-key"].is_sensitive());
    assert!(!format!("{:?}", built.headers()).contains("secret-never-print"));
    assert!(built.headers().get("authorization").is_none());
    assert_eq!(value["system"], "Trusted instructions");
    assert_eq!(value["messages"].as_array().unwrap().len(), 1);
    assert_eq!(value["max_tokens"], 4096);
    assert!(value.get("temperature").is_none());
}

#[test]
fn base_paths_are_preserved_without_duplicate_versions_or_endpoint_suffixes() {
    let client = client();
    for protocol in [
        InvocationProtocol::OpenaiChat,
        InvocationProtocol::OpenaiResponses,
        InvocationProtocol::AnthropicMessages,
    ] {
        let mut req = request(protocol);
        let leaf = match protocol {
            InvocationProtocol::OpenaiChat => "chat/completions",
            InvocationProtocol::OpenaiResponses => "responses",
            InvocationProtocol::AnthropicMessages => "messages",
        };
        for (base, expected) in [
            ("https://example.test".to_owned(), format!("/v1/{leaf}")),
            ("https://example.test/v1/".to_owned(), format!("/v1/{leaf}")),
            (
                "https://example.test/gateway/api/".to_owned(),
                format!("/gateway/api/{leaf}"),
            ),
            (
                format!("https://example.test/custom/{leaf}/"),
                format!("/custom/{leaf}"),
            ),
        ] {
            req.base_url = base;
            assert_eq!(
                super::super::request::build(&client, &req)
                    .unwrap()
                    .url()
                    .path(),
                expected
            );
        }
    }
}

#[test]
fn empty_system_and_key_are_omitted_without_leaking_credentials() {
    let client = client();
    for protocol in [
        InvocationProtocol::OpenaiChat,
        InvocationProtocol::OpenaiResponses,
        InvocationProtocol::AnthropicMessages,
    ] {
        let mut req = request(protocol);
        req.system.clear();
        req.api_key.clear();
        let built = super::super::request::build(&client, &req).unwrap();
        let value: Value =
            serde_json::from_slice(built.body().unwrap().as_bytes().unwrap()).unwrap();
        assert!(built.headers().get("authorization").is_none());
        assert!(built.headers().get("x-api-key").is_none());
        assert!(value.get("system").is_none());
        assert!(value.get("instructions").is_none());
        if protocol == InvocationProtocol::OpenaiChat {
            assert_eq!(value["messages"].as_array().unwrap().len(), 1);
        }
    }
}

#[test]
fn invalid_configuration_errors_do_not_echo_secrets_or_destinations() {
    let client = client();
    for base in [
        "not a URL secret-never-print",
        "ftp://example.test/secret-never-print",
        "https://secret-never-print@example.test",
        "https://example.test?key=secret-never-print",
        "https://example.test#secret-never-print",
    ] {
        let mut req = request(InvocationProtocol::OpenaiChat);
        req.base_url = base.into();
        let error = super::super::request::build(&client, &req).unwrap_err();
        assert!(!error.contains("secret-never-print"));
        assert!(!error.contains("example.test"));
    }
    let mut req = request(InvocationProtocol::AnthropicMessages);
    req.api_key = "secret-never-print\ninvalid-header".into();
    assert!(
        !super::super::request::build(&client, &req)
            .unwrap_err()
            .contains("secret-never-print")
    );
    req.max_output_tokens = 0;
    assert!(super::super::request::build(&client, &req).is_err());
    req.max_output_tokens = 10;
    req.model = "  ".into();
    assert!(super::super::request::build(&client, &req).is_err());
}

#[test]
fn http_errors_are_actionable_status_only() {
    assert_eq!(
        http_failure(StatusCode::UNAUTHORIZED),
        "Invocation HTTP failure (401)"
    );
    assert_eq!(
        http_failure(StatusCode::TOO_MANY_REQUESTS),
        "Invocation HTTP failure (429)"
    );
}

#[tokio::test]
async fn pre_cancelled_invocation_makes_no_network_request() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let mut req = request(InvocationProtocol::OpenaiChat);
    req.base_url = "invalid URL would fail if built".into();
    let mut emitted = false;
    let result = invoke_stream(client(), req, cancel, |_| emitted = true).await;
    assert_eq!(result.unwrap_err(), "Invocation cancelled");
    assert!(!emitted);
}
