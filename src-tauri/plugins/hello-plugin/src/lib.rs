//! Minimal out-of-process plugin used by the M0 host gates.
//!
//! The fixture deliberately has no Tauri or application dependency.  It
//! exercises the same JSON-RPC handshake and lifecycle shape that a real
//! plugin host uses, while keeping crash and timeout behavior deterministic
//! for unit and cross-platform runner tests.

use std::time::Duration;
mod profiled;
pub use profiled::{commands, serve_profiled};

use serde_json::{Value, json};
use taomni_plugin_api::{
    ErrorCode, HandshakeRequest, HandshakeResponse, RpcError, RpcRequest, validate_token,
    validate_versions,
};

pub const PLUGIN_ID: &str = "taomni-plugin-hello-plugin";
pub const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const HANDSHAKE_METHOD: &str = "plugin/handshake";
pub const ENABLE_METHOD: &str = "plugin/enable";
pub const DISABLE_METHOD: &str = "plugin/disable";
pub const PING_METHOD: &str = "hello/ping";
pub const CRASH_METHOD: &str = "hello/crash";
pub const HANG_METHOD: &str = "hello/hang";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginFailure {
    Crash,
    Timeout,
    Rpc(ErrorCode),
}

#[derive(Debug, Clone, PartialEq)]
pub enum DispatchOutcome {
    Response(Value),
    Failure(PluginFailure),
}

#[derive(Debug, Default)]
pub struct HelloPlugin {
    handshaken: bool,
    enabled: bool,
}

impl HelloPlugin {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn handshaken(&self) -> bool {
        self.handshaken
    }

    /// Validate the core handshake and return the response that is sent over
    /// the JSON-RPC control channel.
    pub fn accept_handshake(
        &mut self,
        request: &HandshakeRequest,
        expected_token: &str,
    ) -> Result<HandshakeResponse, RpcError> {
        if request.plugin_id != PLUGIN_ID {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "plugin id does not match hello-plugin",
            ));
        }
        validate_versions(request.api_version, request.protocol_version)?;
        validate_token(expected_token, &request.token)?;
        if request.plugin_version != PLUGIN_VERSION {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "hello-plugin version does not match the fixture",
            ));
        }
        self.handshaken = true;
        Ok(HandshakeResponse::accepted(500))
    }

    /// Dispatch one command after the handshake.  Crash and timeout outcomes
    /// are explicit so a host test can assert cleanup without relying on a
    /// platform-specific process signal.
    pub fn dispatch(&mut self, request: &RpcRequest) -> DispatchOutcome {
        if !self.handshaken {
            return DispatchOutcome::Failure(PluginFailure::Rpc(ErrorCode::InvalidState));
        }
        match request.method.as_str() {
            ENABLE_METHOD => {
                self.enabled = true;
                DispatchOutcome::Response(json!({ "enabled": true }))
            }
            DISABLE_METHOD => {
                self.enabled = false;
                DispatchOutcome::Response(json!({ "enabled": false }))
            }
            PING_METHOD => DispatchOutcome::Response(json!({
                "pluginId": PLUGIN_ID,
                "version": PLUGIN_VERSION,
                "enabled": self.enabled,
            })),
            CRASH_METHOD => DispatchOutcome::Failure(PluginFailure::Crash),
            HANG_METHOD => DispatchOutcome::Failure(PluginFailure::Timeout),
            _ => DispatchOutcome::Failure(PluginFailure::Rpc(ErrorCode::MethodNotFound)),
        }
    }

    /// Duration used by the executable when emulating a hung command.  The
    /// environment override keeps the process test fast while the default is
    /// long enough for a real supervisor timeout to observe it.
    pub fn hang_duration() -> Duration {
        let millis = std::env::var("TAOMNI_HELLO_HANG_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(60_000);
        Duration::from_millis(millis)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_plugin_api::{HandshakeRequest, RequestId};

    fn handshake(plugin: &mut HelloPlugin) {
        let request = HandshakeRequest::new(
            PLUGIN_ID,
            PLUGIN_VERSION,
            "secret",
            vec![
                PING_METHOD.into(),
                ENABLE_METHOD.into(),
                DISABLE_METHOD.into(),
            ],
            vec![],
        );
        assert!(
            plugin
                .accept_handshake(&request, "secret")
                .unwrap()
                .accepted
        );
    }

    #[test]
    fn handshake_and_enable_disable_are_stateful() {
        let mut plugin = HelloPlugin::new();
        handshake(&mut plugin);
        assert!(!plugin.enabled());
        let enable = RpcRequest::new(RequestId::from("enable"), ENABLE_METHOD, None);
        assert_eq!(
            plugin.dispatch(&enable),
            DispatchOutcome::Response(json!({ "enabled": true }))
        );
        assert!(plugin.enabled());
        let disable = RpcRequest::new(RequestId::from("disable"), DISABLE_METHOD, None);
        assert_eq!(
            plugin.dispatch(&disable),
            DispatchOutcome::Response(json!({ "enabled": false }))
        );
        assert!(!plugin.enabled());
    }

    #[test]
    fn handshake_rejects_wrong_token_or_version() {
        let mut plugin = HelloPlugin::new();
        let mut request = HandshakeRequest::new(PLUGIN_ID, PLUGIN_VERSION, "bad", vec![], vec![]);
        assert_eq!(
            plugin
                .accept_handshake(&request, "secret")
                .unwrap_err()
                .code,
            ErrorCode::TokenMismatch.as_i32()
        );
        request.token = "secret".into();
        request.api_version += 1;
        assert_eq!(
            plugin
                .accept_handshake(&request, "secret")
                .unwrap_err()
                .code,
            ErrorCode::ApiVersionMismatch.as_i32()
        );
    }

    #[test]
    fn crash_and_timeout_are_explicit_host_outcomes() {
        let mut plugin = HelloPlugin::new();
        handshake(&mut plugin);
        let crash = RpcRequest::new(RequestId::from("crash"), CRASH_METHOD, None);
        assert_eq!(
            plugin.dispatch(&crash),
            DispatchOutcome::Failure(PluginFailure::Crash)
        );
        let hang = RpcRequest::new(RequestId::from("hang"), HANG_METHOD, None);
        assert_eq!(
            plugin.dispatch(&hang),
            DispatchOutcome::Failure(PluginFailure::Timeout)
        );
    }

    #[test]
    fn command_before_handshake_is_rejected() {
        let mut plugin = HelloPlugin::new();
        let ping = RpcRequest::new(RequestId::from("ping"), PING_METHOD, None);
        assert_eq!(
            plugin.dispatch(&ping),
            DispatchOutcome::Failure(PluginFailure::Rpc(ErrorCode::InvalidState))
        );
    }
}
