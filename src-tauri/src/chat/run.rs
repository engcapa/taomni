use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::agent::acp_bridge::AcpThreadProcess;
use crate::agent::cc_bridge::process::CcProcess;

#[async_trait]
pub trait ChatBridgeRun: Send + Sync {
    async fn stop(&self);
}

#[async_trait]
impl ChatBridgeRun for CcProcess {
    async fn stop(&self) {
        CcProcess::stop(self).await;
    }
}

#[async_trait]
impl ChatBridgeRun for AcpThreadProcess {
    async fn stop(&self) {
        AcpThreadProcess::stop(self).await;
    }
}

/// A provider-agnostic handle for one in-flight chat turn.
///
/// The drawer lifecycle only ever needs to stop "the current turn for this
/// thread". Provider-specific details stay behind this enum, so future bridge
/// providers can add variants without changing frontend IPC semantics.
pub enum ChatRunHandle {
    DirectLlm {
        cancel: CancellationToken,
    },
    BridgeProcess {
        provider_id: String,
        run: Arc<dyn ChatBridgeRun>,
    },
}

impl ChatRunHandle {
    pub fn direct_llm(cancel: CancellationToken) -> Self {
        Self::DirectLlm { cancel }
    }

    pub fn bridge_process<T>(provider_id: impl Into<String>, run: Arc<T>) -> Self
    where
        T: ChatBridgeRun + 'static,
    {
        let run: Arc<dyn ChatBridgeRun> = run;
        Self::BridgeProcess {
            provider_id: provider_id.into(),
            run,
        }
    }

    pub async fn stop(self) {
        match self {
            Self::DirectLlm { cancel } => cancel.cancel(),
            Self::BridgeProcess {
                provider_id: _provider_id,
                run,
            } => run.stop().await,
        }
    }
}

pub type ChatRunRegistry = Mutex<HashMap<String, ChatRunHandle>>;
