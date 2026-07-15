//! Provider-neutral access to Taomni's scoped MCP server.
//!
//! The implementation remains in the legacy Claude bridge for now. This
//! additive facade lets ACP use the same audited token scopes and tool surfaces
//! without moving or changing the Claude Code/Codex integrations.

use serde_json::{Value, json};
use tauri::AppHandle;

pub use crate::agent::cc_bridge::mcp_http::Flavor;

pub async fn provision_for_thread(
    app: &AppHandle,
    thread_id: &str,
    linked_session_id: Option<String>,
    linked_config_id: Option<String>,
    flavor: Flavor,
    confirm_readonly: bool,
) -> Result<(String, String), String> {
    crate::agent::cc_bridge::mcp_http::provision_for_thread_with_inline_permission(
        app,
        thread_id,
        linked_session_id,
        linked_config_id,
        flavor,
        confirm_readonly,
        true,
    )
    .await
}

pub fn control_server_url() -> Result<String, String> {
    crate::agent::cc_bridge::mcp_http::control_server_url()
}

pub fn revoke_token(token: &str) {
    crate::agent::cc_bridge::mcp_http::revoke_token(token);
}

/// Build ACP v1 HTTP MCP records for the scoped domain and control surfaces.
/// ACP represents headers as name/value arrays rather than the maps used by
/// the existing Claude and Codex bridges.
pub fn acp_http_servers(
    flavor: Flavor,
    server_url: &str,
    control_server_url: &str,
    token: &str,
) -> Vec<Value> {
    vec![
        acp_http_server(flavor.server_name(), server_url, token),
        acp_http_server("taomni_control", control_server_url, token),
    ]
}

fn acp_http_server(name: &str, url: &str, token: &str) -> Value {
    json!({
        "type": "http",
        "name": name,
        "url": url,
        "headers": [{
            "name": "Authorization",
            "value": format!("Bearer {token}"),
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_mcp_records_follow_v1_http_shape() {
        let servers = acp_http_servers(
            Flavor::Sql,
            "http://127.0.0.1:4000/mcp/sql",
            "http://127.0.0.1:4000/mcp/control",
            "scoped-token",
        );
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0]["type"], "http");
        assert_eq!(servers[0]["name"], "taomni_sql");
        assert_eq!(servers[0]["headers"][0]["name"], "Authorization");
        assert_eq!(servers[0]["headers"][0]["value"], "Bearer scoped-token");
        assert_eq!(servers[1]["name"], "taomni_control");
    }
}
