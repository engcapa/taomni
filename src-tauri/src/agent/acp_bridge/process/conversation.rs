use super::lifetime::AcpProcess;
use super::model::AcpRuntimeError;
use super::permissions::lock_unpoisoned;
use crate::agent::acp_bridge::protocol::ACP_PROTOCOL_VERSION;
use crate::agent::acp_bridge::protocol::AcpAgentInfo;
use crate::agent::acp_bridge::protocol::AcpPromptResult;
use crate::agent::acp_bridge::protocol::AcpResourceLink;
use crate::agent::acp_bridge::protocol::authenticate_request;
use crate::agent::acp_bridge::protocol::cancel_notification;
use crate::agent::acp_bridge::protocol::initialize_request;
use crate::agent::acp_bridge::protocol::load_session_request;
use crate::agent::acp_bridge::protocol::new_session_request;
use crate::agent::acp_bridge::protocol::parse_initialize_result;
use crate::agent::acp_bridge::protocol::parse_prompt_result;
use crate::agent::acp_bridge::protocol::prompt_request;
use crate::agent::acp_bridge::protocol::prompt_with_resource_links_request;
use crate::agent::acp_bridge::protocol::session_id_from_response;
use serde_json::Value;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Instant;

impl AcpProcess {
    pub async fn initialize(&self) -> Result<AcpAgentInfo, AcpRuntimeError> {
        let request = initialize_request(self.allocate_id(), "taomni", env!("CARGO_PKG_VERSION"));
        let result = self.send_request(request).await?;
        let info = parse_initialize_result(&result)
            .map_err(|error| AcpRuntimeError::Protocol(error.to_string()))?;
        if info.protocol_version != ACP_PROTOCOL_VERSION {
            return Err(AcpRuntimeError::UnsupportedProtocolVersion(
                info.protocol_version,
            ));
        }
        Ok(info)
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<(), AcpRuntimeError> {
        let request = authenticate_request(self.allocate_id(), method_id);
        self.send_request(request).await.map(|_| ())
    }

    pub async fn new_session(
        &self,
        cwd: &str,
        mcp_servers: Vec<Value>,
    ) -> Result<String, AcpRuntimeError> {
        let request = new_session_request(self.allocate_id(), cwd, mcp_servers);
        let result = self.send_request(request).await?;
        session_id_from_response(&result)
            .map_err(|error| AcpRuntimeError::Protocol(error.to_string()))
    }

    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<Value>,
    ) -> Result<(), AcpRuntimeError> {
        let request = load_session_request(self.allocate_id(), session_id, cwd, mcp_servers);
        self.send_request(request).await.map(|_| ())
    }

    pub async fn prompt(
        &self,
        session_id: &str,
        text: &str,
    ) -> Result<AcpPromptResult, AcpRuntimeError> {
        let _turn = self.begin_turn()?;
        self.open_permission_session(session_id).await;
        let request = prompt_request(self.allocate_id(), session_id, text);
        let result = self.send_request(request).await;
        // A late native-tool request must never survive beyond its turn. This
        // also makes an agent-side prompt error fail closed instead of leaving
        // a stale approval card in the next chat turn.
        self.cancel_permissions_for_session(session_id).await;
        let result = result?;
        parse_prompt_result(&result).map_err(|error| AcpRuntimeError::Protocol(error.to_string()))
    }

    /// Submit a prompt with standard ACP resource links. Resource links are
    /// intentionally distinct from inline image blocks so callers can support
    /// local-file attachments without claiming an unadvertised image capability.
    pub async fn prompt_with_resource_links(
        &self,
        session_id: &str,
        text: &str,
        resource_links: &[AcpResourceLink],
    ) -> Result<AcpPromptResult, AcpRuntimeError> {
        let _turn = self.begin_turn()?;
        self.open_permission_session(session_id).await;
        let request = prompt_with_resource_links_request(
            self.allocate_id(),
            session_id,
            text,
            resource_links,
        );
        let result = self.send_request(request).await;
        self.cancel_permissions_for_session(session_id).await;
        let result = result?;
        parse_prompt_result(&result).map_err(|error| AcpRuntimeError::Protocol(error.to_string()))
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), AcpRuntimeError> {
        self.cancel_permissions_for_session(session_id).await;
        self.send_notification(cancel_notification(session_id))
            .await
    }

    pub(super) fn begin_turn(&self) -> Result<TurnGuard<'_>, AcpRuntimeError> {
        self.turn_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| AcpRuntimeError::TurnAlreadyActive)?;
        self.touch();
        Ok(TurnGuard {
            active: &self.turn_active,
            last_active_at: &self.last_active_at,
        })
    }
}

pub(super) struct TurnGuard<'a> {
    pub(super) active: &'a AtomicBool,
    pub(super) last_active_at: &'a StdMutex<Instant>,
}

impl Drop for TurnGuard<'_> {
    fn drop(&mut self) {
        self.active.store(false, Ordering::SeqCst);
        *lock_unpoisoned(self.last_active_at) = Instant::now();
    }
}
