use super::detect;
use super::manager::SdkManager;
use super::registry_policy::normalize_scope_path;
use super::resolve::{self, WorkspaceSdkResolution};
use super::runtime::{self, WorkspaceSdkEnvironment};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub(super) struct CachedWorkspaceResolution {
    pub(super) revision: u64,
    pub(super) resolved_at: Instant,
    pub(super) resolution: WorkspaceSdkResolution,
}

const WORKSPACE_RESOLUTION_CACHE_TTL: Duration = Duration::from_secs(5);

impl SdkManager {
    pub async fn resolve_workspace(
        &self,
        workspace_root: &str,
    ) -> Result<WorkspaceSdkResolution, String> {
        let root = normalize_scope_path(workspace_root)?;
        // Only callers for this root wait together; another project can keep
        // resolving. Weak entries do not retain one lock per visited folder.
        let owner = {
            let mut guards = self.resolution_guards.lock().await;
            guards.retain(|_, guard| guard.strong_count() > 0);
            if let Some(owner) = guards.get(&root).and_then(std::sync::Weak::upgrade) {
                owner
            } else {
                let owner = Arc::new(Mutex::new(()));
                guards.insert(root.clone(), Arc::downgrade(&owner));
                owner
            }
        };
        let _guard = owner.lock().await;
        let revision = self.revision.load(Ordering::SeqCst);
        if let Some(cached) = self.resolution_cache.lock().await.get(&root)
            && cached.revision == revision
            && cached.resolved_at.elapsed() <= WORKSPACE_RESOLUTION_CACHE_TTL
        {
            return Ok(cached.resolution.clone());
        }

        let analysis_root = root.clone();
        let analysis =
            tokio::task::spawn_blocking(move || detect::analyze_workspace(&analysis_root))
                .await
                .map_err(|error| format!("SDK workspace analysis task failed: {error}"))??;
        loop {
            // Capture a registry and its revision under the same read lock.
            // Mutations increment the revision before releasing the write lock.
            let (registry, revision) = {
                let registry = self.registry.read().await;
                (registry.clone(), self.revision.load(Ordering::SeqCst))
            };
            let resolution = resolve::resolve_workspace(analysis.clone(), &registry).await;
            if self.revision.load(Ordering::SeqCst) != revision {
                continue;
            }
            self.resolution_cache.lock().await.insert(
                root,
                CachedWorkspaceResolution {
                    revision,
                    resolved_at: Instant::now(),
                    resolution: resolution.clone(),
                },
            );
            return Ok(resolution);
        }
    }

    pub async fn resolve_environment(
        &self,
        workspace_root: &Path,
        scope_path: &Path,
    ) -> Result<WorkspaceSdkEnvironment, String> {
        let resolution = self
            .resolve_workspace(&workspace_root.to_string_lossy())
            .await?;
        let registry = self.snapshot().await;
        Ok(runtime::build_workspace_environment(
            &resolution,
            &registry,
            scope_path,
        ))
    }
}
