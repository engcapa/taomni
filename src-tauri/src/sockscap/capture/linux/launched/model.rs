use crate::sockscap::config::AppLaunchPreparation;
use serde::Deserialize;
use serde::Serialize;
use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchedAppInfo {
    pub pid: u32,
    pub profile_id: String,
    pub path: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "AppLaunchPreparation::is_empty")]
    pub launch_preparation: AppLaunchPreparation,
    #[serde(default)]
    pub phase: LaunchedAppPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch_error: Option<String>,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LaunchedAppPhase {
    Preparing,
    #[default]
    Running,
    Exited,
    Failed,
}

pub(super) struct LaunchedProcess {
    pub(super) info: LaunchedAppInfo,
    pub(super) process_group: libc::pid_t,
    pub(super) terminal_running: Option<Arc<AtomicBool>>,
}

pub(super) struct TerminalActivityReader {
    pub(super) inner: Box<dyn Read + Send>,
    pub(super) running: Arc<AtomicBool>,
}

impl Read for TerminalActivityReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let result = self.inner.read(buffer);
        if !matches!(result, Ok(count) if count > 0) {
            self.running.store(false, Ordering::Release);
        }
        result
    }
}

impl Drop for TerminalActivityReader {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
    }
}
