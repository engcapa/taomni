//! Real child-process probes protect coalescing, invalidation and failed retries.
use super::manager::SdkManager;
use super::model::{SaveWorkspaceSdkBindingRequest, SdkBindingMode, SdkKind, SdkRole};
use super::resolve::{ResolvedSdkSource, ResolvedSdkStatus};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct ProbeProject {
    _directory: tempfile::TempDir,
    root: String,
    release: PathBuf,
    starts: PathBuf,
    failed: PathBuf,
    manager: Arc<SdkManager>,
}

fn quote(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

impl ProbeProject {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path().join("project");
        let sdk = directory.path().join("sdk");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(sdk.join("bin")).unwrap();
        let release = directory.path().join("release");
        let starts = directory.path().join("starts");
        let failed = directory.path().join("fail");
        let script = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" >> {}\ni=0\nwhile [ ! -f {} ] && [ \"$i\" -lt 300 ]; do sleep .01; i=$((i+1)); done\nif [ -f {} ]; then echo 'SDK executable failure' >&2; exit 1; fi\necho 'openjdk version \"21.0.7\"' >&2\n",
            quote(&starts),
            quote(&release),
            quote(&failed),
        );
        for (name, body) in [("java", script.as_str()), ("javac", "#!/bin/sh\nexit 0\n")] {
            let executable = sdk.join("bin").join(name);
            std::fs::write(&executable, body).unwrap();
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(project.join("build.gradle"), "plugins { id 'java' }\n").unwrap();
        std::fs::write(
            project.join("gradle.properties"),
            format!("org.gradle.java.home={}\n", sdk.display()),
        )
        .unwrap();
        let manager = Arc::new(SdkManager::load(directory.path().join("registry.json")));
        Self {
            root: project.to_string_lossy().into_owned(),
            _directory: directory,
            release,
            starts,
            failed,
            manager,
        }
    }

    fn resolve(
        &self,
    ) -> tokio::task::JoinHandle<Result<super::resolve::WorkspaceSdkResolution, String>> {
        let manager = Arc::clone(&self.manager);
        let root = self.root.clone();
        tokio::spawn(async move { manager.resolve_workspace(&root).await })
    }

    async fn wait_for_probe(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !self.starts.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the real SDK process must start before release");
    }

    fn release(&self) {
        std::fs::write(&self.release, "release").unwrap();
    }

    fn probes(&self) -> usize {
        std::fs::read_to_string(&self.starts)
            .unwrap()
            .lines()
            .count()
    }
}

impl Drop for ProbeProject {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.release, "release");
    }
}

#[tokio::test]
async fn concurrent_callers_share_the_real_sdk_probe() {
    let project = ProbeProject::new();
    let requests: Vec<_> = (0..4).map(|_| project.resolve()).collect();
    project.wait_for_probe().await;
    // Keep the native boundary pending while the independent callers arrive.
    tokio::time::sleep(Duration::from_millis(75)).await;
    assert_eq!(project.probes(), 1);
    project.release();
    let mut resolutions = Vec::new();
    for request in requests {
        resolutions.push(request.await.unwrap().unwrap());
    }
    assert!(resolutions.windows(2).all(|pair| pair[0] == pair[1]));
    assert!(
        resolutions[0]
            .resolved
            .iter()
            .any(|sdk| sdk.role == SdkRole::Launcher && sdk.status == ResolvedSdkStatus::Resolved)
    );
    assert_eq!(project.probes(), 1);
}

#[tokio::test]
async fn another_root_does_not_wait_for_a_pending_sdk() {
    let slow = ProbeProject::new();
    let fast = ProbeProject::new();
    let manager = Arc::clone(&slow.manager);
    let pending = slow.resolve();
    slow.wait_for_probe().await;
    fast.release();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        manager.resolve_workspace(&fast.root),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.analysis.workspace_root, fast.root);
    assert!(!pending.is_finished());
    slow.release();
    pending.await.unwrap().unwrap();
}

#[tokio::test]
async fn registry_change_during_a_probe_is_resolved_before_publishing() {
    let project = ProbeProject::new();
    let missing = project
        .manager
        .save_installation(super::model::SaveSdkInstallationRequest {
            id: None,
            kind: SdkKind::Java,
            name: Some("Missing override".into()),
            location: format!("{}/missing", project.root),
            origin: None,
        })
        .await
        .unwrap();
    let pending = project.resolve();
    project.wait_for_probe().await;
    project
        .manager
        .save_binding(SaveWorkspaceSdkBindingRequest {
            scope_path: project.root.clone(),
            kind: SdkKind::Java,
            role: SdkRole::Launcher,
            mode: SdkBindingMode::Manual,
            sdk_id: Some(missing.id.clone()),
        })
        .await
        .unwrap();
    project.release();
    let resolution = pending.await.unwrap().unwrap();
    let launcher = resolution
        .resolved
        .iter()
        .find(|sdk| sdk.role == SdkRole::Launcher)
        .unwrap();
    assert_eq!(launcher.source, ResolvedSdkSource::ManualBinding);
    assert_eq!(launcher.status, ResolvedSdkStatus::Missing);
    assert_eq!(launcher.installation.as_ref().unwrap().id, missing.id);
    assert_eq!(
        project
            .manager
            .resolve_workspace(&project.root)
            .await
            .unwrap(),
        resolution
    );
}

#[tokio::test]
async fn failed_probe_keeps_its_reason_and_retries_after_the_existing_ttl() {
    let project = ProbeProject::new();
    std::fs::write(&project.failed, "fail").unwrap();
    project.release();
    let failed = project
        .manager
        .resolve_workspace(&project.root)
        .await
        .unwrap();
    let launcher = failed
        .resolved
        .iter()
        .find(|sdk| sdk.role == SdkRole::Launcher)
        .unwrap();
    assert_eq!(launcher.status, ResolvedSdkStatus::Invalid);
    assert!(
        launcher
            .installation
            .as_ref()
            .unwrap()
            .last_error
            .as_ref()
            .unwrap()
            .contains("SDK executable failure")
    );
    std::fs::remove_file(&project.failed).unwrap();
    assert_eq!(
        project
            .manager
            .resolve_workspace(&project.root)
            .await
            .unwrap(),
        failed
    );
    assert_eq!(project.probes(), 1);
    for cache in project.manager.resolution_cache.lock().await.values_mut() {
        cache.resolved_at = Instant::now() - Duration::from_secs(6);
    }
    let recovered = project
        .manager
        .resolve_workspace(&project.root)
        .await
        .unwrap();
    assert!(
        recovered
            .resolved
            .iter()
            .any(|sdk| sdk.role == SdkRole::Launcher && sdk.status == ResolvedSdkStatus::Resolved)
    );
    assert_eq!(project.probes(), 2);
}

#[tokio::test]
async fn cancelled_resolution_releases_the_root_for_the_next_caller() {
    let project = ProbeProject::new();
    let pending = project.resolve();
    project.wait_for_probe().await;
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    project.release();
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        project.manager.resolve_workspace(&project.root),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        result
            .resolved
            .iter()
            .any(|sdk| sdk.role == SdkRole::Launcher && sdk.status == ResolvedSdkStatus::Resolved)
    );
}
