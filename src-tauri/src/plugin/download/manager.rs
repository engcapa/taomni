//! Application-owned tasks: reservations live until every worker operation ends.

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures::FutureExt;
use tokio::sync::{Notify, OnceCell};

use super::*;

#[derive(Default)]
struct ManagerState {
    shutting_down: bool,
    tasks: HashMap<String, Arc<Mutex<DownloadTask>>>,
    requests: HashMap<String, DownloadRequest>,
    recovery_errors: Vec<String>,
    cancellations: HashMap<String, CancellationToken>,
    paths: HashMap<PathBuf, String>,
    artifacts: HashMap<String, String>,
}

impl ManagerState {
    fn reserve(
        &mut self,
        request: &DownloadRequest,
    ) -> Result<(Arc<Mutex<DownloadTask>>, CancellationToken), DownloadError> {
        if self.shutting_down {
            return Err(DownloadError::ShuttingDown);
        }
        if self.cancellations.contains_key(&request.id) {
            return Err(DownloadError::AlreadyActive(request.id.clone()));
        }
        let paths = [&request.partial_path, &request.completed_path]
            .map(|path| paths::reservation_key(path));
        let artifacts = artifact_keys(request)?;
        for owner in paths
            .iter()
            .filter_map(|path| self.paths.get(path))
            .chain(artifacts.iter().filter_map(|key| self.artifacts.get(key)))
        {
            return Err(DownloadError::AlreadyActive(owner.clone()));
        }
        for path in paths {
            self.paths.insert(path, request.id.clone());
        }
        for key in artifacts {
            self.artifacts.insert(key, request.id.clone());
        }
        let task = Arc::new(Mutex::new(DownloadTask::new(
            &request.id,
            request.expected_total,
        )));
        let token = CancellationToken::new();
        self.tasks.insert(request.id.clone(), task.clone());
        self.requests.insert(request.id.clone(), request.clone());
        self.cancellations.insert(request.id.clone(), token.clone());
        Ok((task, token))
    }

    fn release(&mut self, id: &str) {
        self.cancellations.remove(id);
        self.paths.retain(|_, owner| owner != id);
        self.artifacts.retain(|_, owner| owner != id);
    }
}

pub(super) fn artifact_keys(request: &DownloadRequest) -> Result<Vec<String>, DownloadError> {
    let url = reqwest::Url::parse(&request.url)
        .map_err(|error| DownloadError::InvalidUrl(error.to_string()))?;
    let mut keys = vec![format!("url:{url}")];
    if let Some(hash) = &request.expected_sha256 {
        keys.push(format!("sha256:{}", hash.to_ascii_lowercase()));
    }
    Ok(keys)
}

/// Closing a view or dropping a handle does not cancel its worker. Completed
/// states remain available until forgotten. Only cancellation or completion of
/// the worker releases path/content reservations, including after a panic.
#[derive(Clone)]
pub struct DownloadManager {
    service: HttpDownloadService,
    state: Arc<Mutex<ManagerState>>,
    workers_changed: Arc<Notify>,
    journal: Option<Arc<journal::DownloadJournal>>,
    recovered: Arc<OnceCell<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub id: String,
    pub completed_path: PathBuf,
    pub progress: DownloadProgress,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadListing {
    pub tasks: Vec<DownloadInfo>,
    pub recovery_errors: Vec<String>,
}

impl DownloadManager {
    pub fn new(service: HttpDownloadService) -> Self {
        Self {
            service,
            state: Arc::new(Mutex::new(ManagerState::default())),
            workers_changed: Arc::new(Notify::new()),
            journal: None,
            recovered: Arc::new(OnceCell::new()),
        }
    }

    pub fn persistent(service: HttpDownloadService, root: PathBuf) -> Self {
        Self {
            journal: Some(Arc::new(journal::DownloadJournal::new(root))),
            ..Self::new(service)
        }
    }

    async fn recover(&self) {
        self.recovered
            .get_or_init(|| async {
                if let Some(journal) = &self.journal {
                    let (downloads, errors) = journal.recover().await;
                    let mut state = self.state.lock().await;
                    state.recovery_errors = errors;
                    for download in downloads {
                        let id = download.request.id.clone();
                        let mut task = DownloadTask::new(&id, download.request.expected_total);
                        task.progress = download.progress;
                        state.requests.insert(id.clone(), download.request);
                        state.tasks.insert(id, Arc::new(Mutex::new(task)));
                    }
                }
            })
            .await;
    }

    pub async fn start(&self, request: DownloadRequest) -> Result<DownloadHandle, DownloadError> {
        self.start_with_service(request, self.service.clone()).await
    }

    pub async fn start_with_route(
        &self,
        request: DownloadRequest,
        route: ProxyRoute,
    ) -> Result<DownloadHandle, DownloadError> {
        let service = HttpDownloadService::new(&route)?;
        self.start_with_service(request, service).await
    }

    pub async fn start_with_service(
        &self,
        mut request: DownloadRequest,
        service: HttpDownloadService,
    ) -> Result<DownloadHandle, DownloadError> {
        self.recover().await;
        integrity::validate_request(&request)?;
        request.partial_path = paths::canonical_candidate(&request.partial_path)?;
        request.completed_path = paths::canonical_candidate(&request.completed_path)?;
        validate_download_paths(&request.partial_path, &request.completed_path)?;
        let mut state = self.state.lock().await;
        if state.shutting_down {
            return Err(DownloadError::ShuttingDown);
        }
        if state.cancellations.contains_key(&request.id) {
            return Err(DownloadError::AlreadyActive(request.id.clone()));
        }
        let resource_locks = self
            .journal
            .as_ref()
            .map(|journal| journal.reserve(&request))
            .transpose()?;
        // Persist before starting network activity. If persistence fails, the
        // worker does not start and the previous task remains visible.
        if let Some(journal) = &self.journal {
            journal.save(&request, None)?;
        }
        let (task, token) = state.reserve(&request)?;
        drop(state);
        let task_for_worker = task.clone();
        let token_for_worker = token.clone();
        let manager = self.clone();
        let id = request.id.clone();
        let join = tokio::spawn(async move {
            let _resource_locks = resource_locks;
            let transfer = service.download(request, task_for_worker.clone(), token_for_worker);
            manager.run_worker(&id, &task_for_worker, transfer).await
        });
        let id = task.lock().await.id.clone();
        Ok(DownloadHandle {
            id,
            task,
            cancellation: token,
            join,
        })
    }

    async fn run_worker<F>(
        &self,
        id: &str,
        task: &Arc<Mutex<DownloadTask>>,
        transfer: F,
    ) -> Result<DownloadResult, DownloadError>
    where
        F: Future<Output = Result<DownloadResult, DownloadError>>,
    {
        let result = AssertUnwindSafe(transfer)
            .catch_unwind()
            .await
            .unwrap_or_else(|_| Err(DownloadError::Http("download worker panicked".into())));
        if let Err(error) = &result {
            if matches!(error, DownloadError::Cancelled) {
                cancel_task(task).await;
            } else {
                let downloaded = task.lock().await.snapshot().downloaded;
                fail_task(task, downloaded, error).await;
            }
        }
        let progress = task.lock().await.snapshot().clone();
        let mut state = self.state.lock().await;
        if let Some(journal) = &self.journal {
            if let Some(request) = state.requests.get(id) {
                if let Err(error) = journal.save(request, Some(progress)) {
                    state
                        .recovery_errors
                        .push(format!("save module download {id}: {error}"));
                }
            }
        }
        state.release(id);
        drop(state);
        self.workers_changed.notify_waiters();
        result
    }

    /// Stop accepting work and wait until every worker has stopped its network
    /// and file operations. Partial data remains on disk for a future runtime.
    /// Call before releasing the profile lock or closing its owning runtime.
    pub async fn shutdown_and_wait(&self) {
        let tasks = {
            let mut state = self.state.lock().await;
            state.shutting_down = true;
            for token in state.cancellations.values() {
                token.cancel();
            }
            state
                .cancellations
                .keys()
                .filter_map(|id| state.tasks.get(id).cloned())
                .collect::<Vec<_>>()
        };
        for task in tasks {
            task.lock().await.cancel();
        }
        loop {
            // Register before checking state to avoid missing the final worker
            // notification, and support concurrent shutdown callers.
            let changed = self.workers_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().await.cancellations.is_empty() {
                return;
            }
            changed.await;
        }
    }

    pub async fn snapshot(&self, id: &str) -> Option<DownloadProgress> {
        self.recover().await;
        let task = self.state.lock().await.tasks.get(id).cloned()?;
        Some(task.lock().await.snapshot().clone())
    }

    /// Observe a transfer that was already started, including across renderer reloads.
    pub(crate) async fn wait_for_finished(&self, id: &str) -> Option<DownloadProgress> {
        loop {
            let finished = self.workers_changed.notified();
            tokio::pin!(finished);
            finished.as_mut().enable();
            let progress = self.snapshot(id).await?;
            if matches!(
                progress.phase,
                DownloadPhase::Completed | DownloadPhase::Cancelled | DownloadPhase::Failed
            ) {
                return Some(progress);
            }
            finished.await;
        }
    }

    pub async fn forget(&self, id: &str) -> Result<(), DownloadError> {
        self.recover().await;
        let mut state = self.state.lock().await;
        if !state.cancellations.contains_key(id) {
            if let Some(journal) = &self.journal {
                let _locks = state
                    .requests
                    .get(id)
                    .map(|request| journal.reserve(request))
                    .transpose()?;
                journal.remove(id)?;
            }
            state.tasks.remove(id);
            state.requests.remove(id);
        }
        Ok(())
    }

    pub async fn list(&self) -> DownloadListing {
        self.recover().await;
        let state = self.state.lock().await;
        let mut tasks = Vec::new();
        for (id, request) in &state.requests {
            if let Some(task) = state.tasks.get(id) {
                tasks.push(DownloadInfo {
                    id: id.clone(),
                    completed_path: request.completed_path.clone(),
                    progress: task.lock().await.snapshot().clone(),
                });
            }
        }
        tasks.sort_by(|left, right| left.id.cmp(&right.id));
        DownloadListing {
            tasks,
            recovery_errors: state.recovery_errors.clone(),
        }
    }

    /// Resume only after the caller resolves the selected current proxy. Saved
    /// descriptions never persist credentials or make a connection by loading.
    pub async fn resume_with_service(
        &self,
        id: &str,
        service: HttpDownloadService,
    ) -> Result<DownloadHandle, DownloadError> {
        self.recover().await;
        let request = self
            .state
            .lock()
            .await
            .requests
            .get(id)
            .cloned()
            .ok_or_else(|| DownloadError::InvalidPath(format!("unknown download task: {id}")))?;
        if self
            .snapshot(id)
            .await
            .is_some_and(|progress| progress.phase == DownloadPhase::Completed)
        {
            return Err(DownloadError::AlreadyComplete);
        }
        self.start_with_service(request, service).await
    }

    pub async fn cancel(&self, id: &str) -> Result<DownloadProgress, DownloadError> {
        self.recover().await;
        let state = self.state.lock().await;
        let task =
            state.tasks.get(id).cloned().ok_or_else(|| {
                DownloadError::InvalidPath(format!("unknown download task: {id}"))
            })?;
        if let Some(token) = state.cancellations.get(id) {
            token.cancel();
        }
        drop(state);
        let mut task = task.lock().await;
        task.cancel();
        Ok(task.snapshot().clone())
    }
}

pub struct DownloadHandle {
    pub id: String,
    task: Arc<Mutex<DownloadTask>>,
    cancellation: CancellationToken,
    join: JoinHandle<Result<DownloadResult, DownloadError>>,
}

impl DownloadHandle {
    pub async fn snapshot(&self) -> DownloadProgress {
        self.task.lock().await.snapshot().clone()
    }

    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub async fn wait(self) -> Result<DownloadResult, DownloadError> {
        self.join
            .await
            .map_err(|error| DownloadError::Http(format!("download task join failed: {error}")))?
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
