//! Application-owned tasks: reservations live until every worker operation ends.

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures::FutureExt;

use super::*;

#[derive(Default)]
struct ManagerState {
    tasks: HashMap<String, Arc<Mutex<DownloadTask>>>,
    cancellations: HashMap<String, CancellationToken>,
    paths: HashMap<PathBuf, String>,
    artifacts: HashMap<String, String>,
}

impl ManagerState {
    fn reserve(
        &mut self,
        request: &DownloadRequest,
    ) -> Result<(Arc<Mutex<DownloadTask>>, CancellationToken), DownloadError> {
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
        self.cancellations.insert(request.id.clone(), token.clone());
        Ok((task, token))
    }

    fn release(&mut self, id: &str) {
        self.cancellations.remove(id);
        self.paths.retain(|_, owner| owner != id);
        self.artifacts.retain(|_, owner| owner != id);
    }
}

fn artifact_keys(request: &DownloadRequest) -> Result<Vec<String>, DownloadError> {
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
}

impl DownloadManager {
    pub fn new(service: HttpDownloadService) -> Self {
        Self {
            service,
            state: Arc::new(Mutex::new(ManagerState::default())),
        }
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

    async fn start_with_service(
        &self,
        mut request: DownloadRequest,
        service: HttpDownloadService,
    ) -> Result<DownloadHandle, DownloadError> {
        integrity::validate_request(&request)?;
        request.partial_path = paths::canonical_candidate(&request.partial_path)?;
        request.completed_path = paths::canonical_candidate(&request.completed_path)?;
        validate_download_paths(&request.partial_path, &request.completed_path)?;
        let (task, token) = self.state.lock().await.reserve(&request)?;
        let task_for_worker = task.clone();
        let token_for_worker = token.clone();
        let manager = self.clone();
        let id = request.id.clone();
        let join = tokio::spawn(async move {
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
            let downloaded = task.lock().await.snapshot().downloaded;
            fail_task(task, downloaded, error).await;
        }
        self.state.lock().await.release(id);
        result
    }

    pub async fn snapshot(&self, id: &str) -> Option<DownloadProgress> {
        let task = self.state.lock().await.tasks.get(id).cloned()?;
        Some(task.lock().await.snapshot().clone())
    }

    pub async fn forget(&self, id: &str) {
        let mut state = self.state.lock().await;
        if !state.cancellations.contains_key(id) {
            state.tasks.remove(id);
        }
    }

    pub async fn cancel(&self, id: &str) -> Result<DownloadProgress, DownloadError> {
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
