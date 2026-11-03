use super::{model::*, settings, store::Store};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokio_util::sync::CancellationToken;

pub struct OrchestrationRuntime {
    inner: Mutex<Option<Inner>>,
}
pub struct Inner {
    pub store: Store,
    pub root: PathBuf,
    pub owner: String,
    pub(crate) active: HashMap<String, CancellationToken>,
    pub(crate) closing: bool,
    _lock: File,
}
impl Default for OrchestrationRuntime {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}
impl OrchestrationRuntime {
    pub fn with<T>(
        &self,
        app: &tauri::AppHandle,
        f: impl FnOnce(&mut Inner) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.inner.lock().map_err(|_| "ORCHESTRATION_UNAVAILABLE")?;
        if guard.is_none() {
            let root = crate::resolved_app_data_dir(app)?.join("orchestration");
            *guard = Some(Inner::open(root)?);
        }
        f(guard.as_mut().ok_or("ORCHESTRATION_UNAVAILABLE")?)
    }
    pub fn resume_after_failed_exit(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(inner) = guard.as_mut() {
                inner.closing = false;
            }
        }
    }
    pub async fn prepare_for_exit(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.with(app, |inner| {
            inner.closing = true;
            let ids: Vec<_> = inner.active.keys().cloned().collect();
            for id in ids {
                if inner.store.get(&id)?.status != "interrupted" {
                    inner.request_cancel(&id)?;
                }
            }
            Ok(())
        })?;
        let wait = async {
            loop {
                if self.with(app, |inner| Ok(inner.active.is_empty()))? {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(15), wait)
            .await
            .unwrap_or_else(|_| Err("WORKER_STOP_UNKNOWN: application exit is blocked until task ownership is reconciled".into()));
        if result.is_err() {
            self.with(app, |inner| {
                inner.closing = false;
                Ok(())
            })?;
        }
        result
    }
}
impl Inner {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(".owner.lock"))
            .map_err(|e| e.to_string())?;
        lock.try_lock()
            .map_err(|_| "ORCHESTRATION_BUSY: another application owns this task database")?;
        let mut store = Store::open(&root.join("state.sqlite3"))?;
        store.recover_interrupted()?;
        Ok(Self {
            store,
            root,
            owner: uuid::Uuid::new_v4().to_string(),
            active: HashMap::new(),
            closing: false,
            _lock: lock,
        })
    }
    pub fn settings(&self) -> Result<AgentSettings, String> {
        settings::load(&self.root.join("profiles.json"))
    }
    pub fn save_settings(
        &self,
        value: &AgentSettings,
        expected: u64,
    ) -> Result<AgentSettings, String> {
        settings::save(&self.root.join("profiles.json"), value, expected)
    }
    pub fn create(&mut self, input: AgentSubmission) -> Result<AgentRun, String> {
        if input.command_id.is_empty()
            || input.command_id.len() > 128
            || input.goal.trim().is_empty()
            || input.goal.len() > 64 * 1024
        {
            return Err("INVALID_TASK: a bounded goal and command ID are required".into());
        }
        if let Some(existing) = self.store.by_command(&input.command_id)? {
            return Ok(existing);
        }
        let settings = self.settings()?;
        if settings.revision != input.expected_settings_revision {
            return Err("STALE_SETTINGS: confirm the current shared configuration".into());
        }
        let resource = settings.resource(&input.intent)?;
        if input.intent == AgentIntent::Develop && resource.kind != "worker" {
            return Err("INVALID_RESOURCE: development requires an explicit worker".into());
        }
        let context =
            crate::orchestration::context::compile(&input.project_path, &input.source_paths)?;
        let project =
            std::fs::canonicalize(&input.project_path).map_err(|_| "PROJECT_UNAVAILABLE")?;
        let tasks = match input.intent {
            AgentIntent::Plan => vec![
                ("design", "Architecture and lifecycle"),
                ("contract", "Interface and compatibility"),
                ("tests", "Acceptance and test plan"),
            ],
            AgentIntent::Review => vec![("review", "Review findings and evidence")],
            AgentIntent::Develop => vec![("implementation", "Implementation candidate")],
        }
        .into_iter()
        .map(|(id, title)| AgentTask {
            id: id.into(),
            title: title.into(),
            status: "pending".into(),
            dependencies: Vec::new(),
        })
        .collect();
        let run = AgentRun {
            id: uuid::Uuid::new_v4().to_string(),
            revision: 1,
            project_path: project.to_string_lossy().into_owned(),
            title: input.goal.chars().take(60).collect(),
            goal: input.goal.trim().into(),
            intent: input.intent.clone(),
            status: "planned".into(),
            settings_snapshot: settings,
            tasks,
            sources: context.sources,
            artifacts: Vec::new(),
            events: Vec::new(),
            request_count: 0,
            recovery_count: 0,
            error: None,
            worktree_path: None,
            source_revision: if input.intent == AgentIntent::Develop {
                Some(crate::orchestration::execution::worktree::freeze_revision(
                    &project,
                )?)
            } else {
                None
            },
            created_at: now(),
        };
        self.store.insert(&input.command_id, &run)?;
        Ok(run)
    }
    pub fn mutate(
        &mut self,
        id: &str,
        kind: &str,
        message: &str,
        f: impl FnOnce(&mut AgentRun) -> Result<(), String>,
    ) -> Result<AgentRun, String> {
        let mut run = self.store.get(id)?;
        let previous = run.revision;
        f(&mut run)?;
        run.revision = run.revision.checked_add(1).ok_or("REVISION_OVERFLOW")?;
        run.events.push(AgentEvent {
            sequence: run.events.last().map_or(1, |e| e.sequence + 1),
            kind: kind.into(),
            message: message.into(),
            created_at: now(),
        });
        self.store.update(&run, previous)?;
        Ok(run)
    }
    pub fn save_candidate(
        &mut self,
        id: &str,
        artifact: AgentArtifact,
    ) -> Result<AgentRun, String> {
        if uuid::Uuid::parse_str(&artifact.id).is_err()
            || artifact.hash != digest(artifact.content.as_bytes())
            || artifact.status != "candidate"
        {
            return Err("INVALID_ARTIFACT".into());
        }
        let run = self.store.get(id)?;
        if matches!(
            run.status.as_str(),
            "stopping" | "cancelled" | "interrupted" | "failed"
        ) {
            return Err("CANCELLED: late artifact quarantined".into());
        }
        if run.artifacts.iter().any(|a| a.item_id == artifact.item_id)
            || !run.tasks.iter().any(|t| t.id == artifact.item_id)
        {
            return Err("INVALID_ARTIFACT_OWNERSHIP".into());
        }
        self.publish_file(&artifact)?;
        self.mutate(
            id,
            "candidate_saved",
            "A complete item was retained; verification and acceptance remain separate",
            |run| {
                if run.status == "stopping" || run.status == "cancelled" {
                    return Err("CANCELLED: late artifact quarantined".into());
                }
                if run.artifacts.iter().any(|a| a.item_id == artifact.item_id) {
                    return Err("DUPLICATE_ITEM".into());
                }
                for task in &mut run.tasks {
                    if task.id == artifact.item_id {
                        task.status = "candidate".into();
                    }
                }
                run.artifacts.push(artifact);
                Ok(())
            },
        )
    }
    fn publish_file(&self, artifact: &AgentArtifact) -> Result<(), String> {
        let folder = self.root.join("artifacts");
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let target = folder.join(&artifact.id);
        let mut tmp = tempfile::NamedTempFile::new_in(&folder).map_err(|e| e.to_string())?;
        use std::io::Write;
        tmp.write_all(artifact.content.as_bytes())
            .map_err(|e| e.to_string())?;
        tmp.as_file().sync_all().map_err(|e| e.to_string())?;
        tmp.persist(target).map_err(|e| e.to_string())?;
        Ok(())
    }
}

pub fn assert_revision(run: &AgentRun, expected: u64) -> Result<(), String> {
    if run.revision == expected {
        Ok(())
    } else {
        Err("STALE_REVISION: reload task state".into())
    }
}
pub fn is_loopback(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
}
pub fn ensure_policy(
    config: &crate::ai::config::AiConfig,
    resource: &AgentResource,
) -> Result<(), String> {
    if config.fully_disabled {
        return Err("AI_DISABLED".into());
    }
    if config.full_local_mode && !is_loopback(&resource.base_url) {
        return Err("FULL_LOCAL_MODE: remote execution is disabled".into());
    }
    Ok(())
}
pub fn config_dir() -> Result<PathBuf, String> {
    crate::resolved_config_dir().ok_or_else(|| "CONFIG_UNAVAILABLE".into())
}
pub fn project_marker(root: &Path) -> PathBuf {
    root.join(".taomni-orchestration-owner")
}
