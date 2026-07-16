use super::{
    AcpAgentInfo, AcpProcess, AcpProcessConfig, AcpPromptResult, AcpResourceLink, AcpRuntimeError,
    AcpRuntimeEvent,
};
use serde_json::Value;
use std::sync::{Mutex as StdMutex, MutexGuard as StdMutexGuard};
use std::time::Instant;
use tokio::sync::{Mutex, broadcast};

/// One ACP process bound to one Taomni chat thread and one ACP profile.
///
/// The wrapper owns the scoped MCP token and revokes it on every stop/drop
/// path. Session IDs remain separate from the legacy CC/Codex session column.
pub struct AcpThreadProcess {
    profile_id: String,
    process: AcpProcess,
    agent_info: AcpAgentInfo,
    session_id: Mutex<Option<String>>,
    mcp_token: StdMutex<Option<String>>,
}

impl AcpThreadProcess {
    pub async fn spawn(
        profile_id: impl Into<String>,
        config: AcpProcessConfig,
        auth_method_id: Option<&str>,
        mcp_token: String,
    ) -> Result<Self, AcpRuntimeError> {
        let process = match AcpProcess::spawn(config).await {
            Ok(process) => process,
            Err(error) => {
                crate::agent::mcp_bridge::revoke_token(&mcp_token);
                return Err(error);
            }
        };
        let agent_info = match process.initialize().await {
            Ok(info) => info,
            Err(error) => {
                process.stop().await;
                crate::agent::mcp_bridge::revoke_token(&mcp_token);
                return Err(error);
            }
        };

        if let Some(method_id) = auth_method_id {
            if !agent_info
                .auth_methods
                .iter()
                .any(|method| method.id == method_id)
            {
                process.stop().await;
                crate::agent::mcp_bridge::revoke_token(&mcp_token);
                return Err(AcpRuntimeError::Protocol(
                    "configured ACP authentication method was not advertised".into(),
                ));
            }
            if let Err(error) = process.authenticate(method_id).await {
                process.stop().await;
                crate::agent::mcp_bridge::revoke_token(&mcp_token);
                return Err(error);
            }
        }

        Ok(Self {
            profile_id: profile_id.into(),
            process,
            agent_info,
            session_id: Mutex::new(None),
            mcp_token: StdMutex::new(Some(mcp_token)),
        })
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn agent_info(&self) -> &AcpAgentInfo {
        &self.agent_info
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AcpRuntimeEvent> {
        self.process.subscribe()
    }

    /// Opaque identity for routing this process's native permission cards.
    pub fn permission_owner_id(&self) -> &str {
        self.process.permission_owner_id()
    }

    pub async fn ensure_session(
        &self,
        resume_session_id: Option<&str>,
        cwd: &str,
        mcp_servers: Vec<Value>,
    ) -> Result<String, AcpRuntimeError> {
        let mut session_id = self.session_id.lock().await;
        if let Some(current) = session_id.as_ref() {
            return Ok(current.clone());
        }
        if !mcp_servers.is_empty() && !self.agent_info.supports_mcp_http {
            return Err(AcpRuntimeError::Protocol(
                "ACP agent does not advertise HTTP MCP support".into(),
            ));
        }

        let resolved = match resume_session_id
            .map(str::trim)
            .filter(|session_id| !session_id.is_empty())
        {
            Some(resume) if self.agent_info.supports_session_load => {
                self.process.load_session(resume, cwd, mcp_servers).await?;
                resume.to_string()
            }
            _ => self.process.new_session(cwd, mcp_servers).await?,
        };
        *session_id = Some(resolved.clone());
        Ok(resolved)
    }

    pub async fn prompt(&self, text: &str) -> Result<AcpPromptResult, AcpRuntimeError> {
        let session_id =
            self.session_id.lock().await.clone().ok_or_else(|| {
                AcpRuntimeError::Protocol("ACP session is not initialized".into())
            })?;
        self.process.prompt(&session_id, text).await
    }

    pub async fn prompt_with_resource_links(
        &self,
        text: &str,
        resource_links: &[AcpResourceLink],
    ) -> Result<AcpPromptResult, AcpRuntimeError> {
        let session_id =
            self.session_id.lock().await.clone().ok_or_else(|| {
                AcpRuntimeError::Protocol("ACP session is not initialized".into())
            })?;
        self.process
            .prompt_with_resource_links(&session_id, text, resource_links)
            .await
    }

    pub async fn cancel(&self) -> Result<(), AcpRuntimeError> {
        if let Some(session_id) = self.session_id.lock().await.clone() {
            self.process.cancel(&session_id).await?;
        }
        Ok(())
    }

    /// Return the human-selected option for a pending ACP native-tool
    /// permission prompt. The wrapped process validates that both ids still
    /// belong together before writing the response to the local agent.
    pub async fn resolve_permission(
        &self,
        call_id: &str,
        option_id: &str,
    ) -> Result<(), AcpRuntimeError> {
        self.process.resolve_permission(call_id, option_id).await
    }

    /// Cancel a single ACP native-tool permission without selecting one of the
    /// agent-provided options.
    pub async fn cancel_permission(&self, call_id: &str) -> Result<(), AcpRuntimeError> {
        self.process.cancel_permission(call_id).await
    }

    pub async fn stop(&self) {
        // Give the local CLI an explicit `cancelled` permission outcome and a
        // session cancellation before closing its stdio transport.
        let _ = self.cancel().await;
        revoke_owned_token(&self.mcp_token);
        self.process.stop().await;
    }

    pub fn is_stopped(&self) -> bool {
        self.process.is_stopped()
    }

    pub fn is_turn_active(&self) -> bool {
        self.process.is_turn_active()
    }

    pub fn last_active_at(&self) -> Instant {
        *lock_unpoisoned(&self.process.last_active_at)
    }

    pub async fn stderr(&self) -> String {
        self.process.stderr().await
    }
}

impl Drop for AcpThreadProcess {
    fn drop(&mut self) {
        revoke_owned_token(&self.mcp_token);
    }
}

fn revoke_owned_token(token: &StdMutex<Option<String>>) {
    if let Some(token) = lock_unpoisoned(token).take() {
        crate::agent::mcp_bridge::revoke_token(&token);
    }
}

fn lock_unpoisoned<T>(mutex: &StdMutex<T>) -> StdMutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
