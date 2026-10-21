use super::capture::parse_reduce_op;
use super::model::Flavor;
use super::model::TokenMap;
use super::model::TokenScope;
use super::model::TrustLevel;
use super::parameters::PermissionParams;
use super::parameters::ReadCaptureParams;
use super::permissions::allow_json;
use super::permissions::deny_json;
use super::scope::enforce_session_scope;
use super::scope::fill_session_id;
use super::scope::normalize_tool_name;
use super::scope::tool_uses_bound_session_scope;
use super::server::auth_mw;
use axum::extract::Request;
use axum::middleware::Next;
use serde_json::json;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

fn scope(thread: &str, allowed: Option<&str>) -> TokenScope {
    TokenScope {
        thread_id: thread.into(),
        allowed_session_id: allowed.map(|s| s.to_string()),
        allowed_config_id: None,
        trust: TrustLevel::Strict,
        flavor: Flavor::Shell,
        confirm_readonly: false,
        inline_permission: false,
        session_approved: Arc::new(Mutex::new(HashSet::new())),
    }
}

/// Variant carrying a bound `SessionConfig.id` (the id the identity card
/// advertises), so we can exercise config-id acceptance / normalization.
fn scope_with_config(thread: &str, tab: &str, config: &str) -> TokenScope {
    TokenScope {
        thread_id: thread.into(),
        allowed_session_id: Some(tab.to_string()),
        allowed_config_id: Some(config.to_string()),
        trust: TrustLevel::Strict,
        flavor: Flavor::Shell,
        confirm_readonly: false,
        inline_permission: false,
        session_approved: Arc::new(Mutex::new(HashSet::new())),
    }
}

#[test]
fn no_session_id_always_in_scope() {
    let s = scope("t1", Some("sess-a"));
    assert!(enforce_session_scope(&s, &json!({ "command": "ls" })).is_ok());
}

#[test]
fn matching_session_id_allowed() {
    let s = scope("t1", Some("sess-a"));
    assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-a" })).is_ok());
}

#[test]
fn foreign_session_id_rejected() {
    let s = scope("t1", Some("sess-a"));
    assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-b" })).is_err());
}

#[test]
fn local_token_cannot_name_any_session() {
    // A thread bound to no session (local working dir) must not touch one.
    let s = scope("t1", None);
    assert!(enforce_session_scope(&s, &json!({ "session_id": "sess-a" })).is_err());
}

#[test]
fn allow_result_carries_updated_input() {
    let input = json!({ "command": "ls -la" });
    let parsed: serde_json::Value = serde_json::from_str(&allow_json(&input)).unwrap();
    assert_eq!(parsed["behavior"], "allow");
    assert_eq!(parsed["updatedInput"]["command"], "ls -la");
}

#[test]
fn deny_result_carries_message() {
    let parsed: serde_json::Value = serde_json::from_str(&deny_json("blocked: rm -rf /")).unwrap();
    assert_eq!(parsed["behavior"], "deny");
    assert_eq!(parsed["message"], "blocked: rm -rf /");
}

#[test]
fn normalize_strips_mcp_prefix() {
    // CC sends our tools prefixed; grading must see the bare name so
    // `requires_confirmation` recognizes the write tool and fires a card.
    assert_eq!(
        normalize_tool_name("mcp__taomni__run_in_terminal"),
        "run_in_terminal"
    );
    assert!(crate::agent::safety::requires_confirmation(
        normalize_tool_name("mcp__taomni__run_in_terminal")
    ));
}

#[test]
fn normalize_leaves_builtin_tools_untouched() {
    assert_eq!(normalize_tool_name("Bash"), "Bash");
    assert_eq!(normalize_tool_name("Edit"), "Edit");
}

#[test]
fn control_tools_do_not_use_bound_terminal_scope() {
    assert!(!tool_uses_bound_session_scope("session_open"));
    assert!(!tool_uses_bound_session_scope(
        "mcp__taomni_control__session_open"
    ));
    assert!(!tool_uses_bound_session_scope("session_get"));
    assert!(!tool_uses_bound_session_scope("tab_duplicate"));
    assert!(!tool_uses_bound_session_scope("switch_tab"));

    assert!(tool_uses_bound_session_scope("run_in_terminal"));
    assert!(tool_uses_bound_session_scope(
        "mcp__taomni__run_in_terminal"
    ));
    assert!(tool_uses_bound_session_scope("run_sql"));
    assert!(tool_uses_bound_session_scope("redis_exec"));
}

#[test]
fn control_session_ids_are_not_execution_scope_ids() {
    let s = scope("t1", Some("current-tab"));
    let args = json!({ "session_id": "pi-1" });

    assert!(enforce_session_scope(&s, &args).is_err());
    assert!(!tool_uses_bound_session_scope("session_open"));
    assert!(tool_uses_bound_session_scope("run_in_terminal"));
}

#[test]
fn flavor_for_session_type_maps_db_engines() {
    use crate::session::models::SessionType;
    let sql = [
        SessionType::MySQL,
        SessionType::PostgreSQL,
        SessionType::PanWeiDB,
        SessionType::Oracle,
        SessionType::SQLServer,
        SessionType::StarRocks,
        SessionType::ClickHouse,
        SessionType::Presto,
    ];
    for t in sql {
        assert_eq!(
            Flavor::for_session_type(Some(&t)),
            Flavor::Sql,
            "{t:?} → Sql"
        );
    }
    assert_eq!(
        Flavor::for_session_type(Some(&SessionType::Redis)),
        Flavor::Redis
    );
    // Terminal / object-storage / unbound all fall back to Shell.
    assert_eq!(
        Flavor::for_session_type(Some(&SessionType::SSH)),
        Flavor::Shell
    );
    assert_eq!(
        Flavor::for_session_type(Some(&SessionType::HBaseShell)),
        Flavor::Shell
    );
    assert_eq!(Flavor::for_session_type(None), Flavor::Shell);
}

#[test]
fn flavor_paths_and_servers_are_distinct() {
    // Each flavor mounts a distinct path + names a distinct server, so a
    // thread's .mcp.json (one server) can't accidentally expose another
    // flavor's tools.
    for f in [Flavor::Shell, Flavor::Sql, Flavor::Redis, Flavor::Control] {
        assert!(f.permission_prompt_tool().contains(f.server_name()));
    }
    assert_ne!(Flavor::Sql.path(), Flavor::Redis.path());
    assert_ne!(Flavor::Sql.path(), Flavor::Shell.path());
    assert_ne!(Flavor::Control.path(), Flavor::Shell.path());
    assert_ne!(Flavor::Sql.server_name(), Flavor::Shell.server_name());
    assert_eq!(Flavor::Control.server_name(), "taomni_control");
}

#[test]
fn parse_reduce_op_maps_each_op() {
    use crate::agent::capture::reduce::ReduceOp;
    let base = |op: &str| ReadCaptureParams {
        capture_id: "c".into(),
        op: op.into(),
        n: None,
        start: None,
        end: None,
        pattern: None,
        context: None,
        filter: None,
    };
    assert_eq!(
        parse_reduce_op(&ReadCaptureParams {
            n: Some(10),
            ..base("head")
        })
        .unwrap(),
        ReduceOp::Head { n: 10 }
    );
    assert_eq!(
        parse_reduce_op(&base("tail")).unwrap(),
        ReduceOp::Tail { n: 50 } // default
    );
    assert_eq!(
        parse_reduce_op(&ReadCaptureParams {
            start: Some(2),
            end: Some(5),
            ..base("range")
        })
        .unwrap(),
        ReduceOp::Range { start: 2, end: 5 }
    );
    assert_eq!(
        parse_reduce_op(&ReadCaptureParams {
            pattern: Some("ERR".into()),
            context: Some(2),
            ..base("grep")
        })
        .unwrap(),
        ReduceOp::Grep {
            pattern: "ERR".into(),
            context: 2
        }
    );
    assert_eq!(
        parse_reduce_op(&ReadCaptureParams {
            filter: Some(".a".into()),
            ..base("jq")
        })
        .unwrap(),
        ReduceOp::Jq {
            filter: ".a".into()
        }
    );
    assert_eq!(parse_reduce_op(&base("stats")).unwrap(), ReduceOp::Stats);
}

#[test]
fn parse_reduce_op_requires_op_fields() {
    let p = ReadCaptureParams {
        capture_id: "c".into(),
        op: "range".into(),
        n: None,
        start: None,
        end: None,
        pattern: None,
        context: None,
        filter: None,
    };
    assert!(
        parse_reduce_op(&p).is_err(),
        "range without start/end must error"
    );
    let p2 = ReadCaptureParams {
        op: "grep".into(),
        ..p.clone()
    };
    assert!(
        parse_reduce_op(&p2).is_err(),
        "grep without pattern must error"
    );
    let p3 = ReadCaptureParams {
        op: "bogus".into(),
        ..p
    };
    assert!(parse_reduce_op(&p3).is_err(), "unknown op must error");
}

#[test]
fn permission_params_reads_cc_input_field() {
    // CC's permission-prompt protocol sends the requested tool's args under
    // `input`. If we only accept `tool_input` the field defaults to Null and
    // we emit `args: null` (crashing the UI card) + hand CC `updatedInput: null`.
    let p: PermissionParams = serde_json::from_value(json!({
        "tool_name": "mcp__taomni__run_in_terminal",
        "input": { "command": "uname -a" }
    }))
    .unwrap();
    assert_eq!(p.tool_input["command"], "uname -a");
}

#[test]
fn permission_params_still_reads_tool_input_alias() {
    let p: PermissionParams = serde_json::from_value(json!({
        "tool_name": "Bash",
        "tool_input": { "command": "ls" }
    }))
    .unwrap();
    assert_eq!(p.tool_input["command"], "ls");
}

#[test]
fn fill_session_id_uses_bound_session_when_omitted() {
    let s = scope("t1", Some("sess-a"));
    let mut args = json!({ "command": "uname -a" });
    fill_session_id(&mut args, &s);
    assert_eq!(args["session_id"], "sess-a");
    // And the scope check now passes for the injected id.
    assert!(enforce_session_scope(&s, &args).is_ok());
}

#[test]
fn fill_session_id_replaces_null_session_id() {
    let s = scope("t1", Some("sess-a"));
    let mut args = json!({
        "session_id": null,
        "local_path": "d:\\temp\\a.txt",
        "remote_path": "/tmp"
    });
    fill_session_id(&mut args, &s);
    assert_eq!(args["session_id"], "sess-a");
    assert!(enforce_session_scope(&s, &args).is_ok());
}

#[test]
fn fill_session_id_respects_explicit_arg() {
    let s = scope("t1", Some("sess-a"));
    let mut args = json!({ "session_id": "sess-a", "command": "ls" });
    fill_session_id(&mut args, &s);
    assert_eq!(args["session_id"], "sess-a");
}

#[test]
fn fill_session_id_noop_for_global_thread() {
    let s = scope("t1", None);
    let mut args = json!({ "command": "ls" });
    fill_session_id(&mut args, &s);
    assert!(args.get("session_id").is_none());
}

#[test]
fn config_id_is_in_scope_and_normalized_to_tab_id() {
    // The identity card hands CC the SessionConfig.id; CC then names it as
    // session_id. It must be accepted (scope) and rewritten to the tab id
    // (fill) so downstream registry / state.terminal.terminals lookups resolve.
    let s = scope_with_config("t1", "ssh-cfg-123", "cfg-uuid");
    let mut args = json!({ "session_id": "cfg-uuid", "command": "free -h" });
    assert!(enforce_session_scope(&s, &args).is_ok());
    fill_session_id(&mut args, &s);
    assert_eq!(args["session_id"], "ssh-cfg-123");
    assert!(enforce_session_scope(&s, &args).is_ok());
}

#[test]
fn tab_id_stays_canonical_with_config_bound() {
    let s = scope_with_config("t1", "ssh-cfg-123", "cfg-uuid");
    let mut args = json!({ "session_id": "ssh-cfg-123", "command": "ls" });
    fill_session_id(&mut args, &s);
    assert_eq!(args["session_id"], "ssh-cfg-123");
}

#[test]
fn foreign_session_id_rejected_even_with_config_bound() {
    let s = scope_with_config("t1", "ssh-cfg-123", "cfg-uuid");
    assert!(enforce_session_scope(&s, &json!({ "session_id": "ssh-other-999" })).is_err());
}

// Exercises the Bearer auth boundary over a real loopback HTTP round-trip,
// using the same `auth_mw` the server mounts — without needing CC or a
// Tauri AppState. Covers the "401 when no/invalid token" requirement.
#[tokio::test]
async fn auth_middleware_gates_on_bearer() {
    use axum::routing::get;

    let tokens: TokenMap = Arc::new(Mutex::new(HashMap::new()));
    tokens
        .lock()
        .unwrap()
        .insert("good-token".to_string(), scope("t1", None));

    let mw_tokens = tokens.clone();
    let app = axum::Router::new()
        .route("/x", get(|| async { "ok" }))
        .layer(axum::middleware::from_fn(
            move |req: Request, next: Next| {
                let toks = mw_tokens.clone();
                async move { auth_mw(toks, req, next).await }
            },
        ));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let base = format!("http://{addr}/x");
    let client = reqwest::Client::new();

    let no_token = client.get(&base).send().await.unwrap();
    assert_eq!(no_token.status(), 401, "missing token must be 401");

    let bad = client
        .get(&base)
        .header("Authorization", "Bearer wrong")
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 401, "unknown token must be 401");

    let good = client
        .get(&base)
        .header("Authorization", "Bearer good-token")
        .send()
        .await
        .unwrap();
    assert_eq!(good.status(), 200, "valid token must pass");
}
