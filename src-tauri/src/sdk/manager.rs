use super::model::SaveSdkInstallationRequest;
use super::model::SaveWorkspaceSdkBindingRequest;
use super::model::SdkBindingMode;
use super::model::SdkDefault;
use super::model::SdkInstallation;
use super::model::SdkKind;
use super::model::SdkOrigin;
use super::model::SdkRegistry;
use super::model::SdkRole;
use super::model::SetSdkDefaultRequest;
use super::model::WorkspaceSdkBinding;
use super::persistence::load_registry;
use super::persistence::persist_registry;
use super::registry_policy::default_installation_name;
use super::registry_policy::normalize_scope_path;
use super::registry_policy::paths_equal;
use super::registry_policy::require_installation;
use super::registry_policy::sort_registry;
use super::resolution_cache::CachedWorkspaceResolution;
use crate::sdk::probe;
use chrono::Utc;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use tokio::sync::Mutex;
use tokio::sync::RwLock;

pub struct SdkManager {
    pub(super) path: PathBuf,
    pub(super) registry: RwLock<SdkRegistry>,
    pub(super) revision: AtomicU64,
    pub(super) resolution_cache: Mutex<HashMap<String, CachedWorkspaceResolution>>,
    pub(super) resolution_guards: Mutex<HashMap<String, Weak<Mutex<()>>>>,
}

impl SdkManager {
    pub fn load(path: PathBuf) -> Self {
        let registry = load_registry(&path).unwrap_or_else(|error| {
            log::warn!("failed to load SDK registry {}: {error}", path.display());
            SdkRegistry::default()
        });
        Self {
            path,
            registry: RwLock::new(registry),
            revision: AtomicU64::new(1),
            resolution_cache: Mutex::new(HashMap::new()),
            resolution_guards: Mutex::new(HashMap::new()),
        }
    }

    pub async fn snapshot(&self) -> SdkRegistry {
        self.registry.read().await.clone()
    }

    pub(super) fn registry_changed(&self) {
        self.revision.fetch_add(1, Ordering::SeqCst);
    }

    pub async fn save_installation(
        &self,
        request: SaveSdkInstallationRequest,
    ) -> Result<SdkInstallation, String> {
        let probe = probe::probe_sdk(request.kind, &request.location).await;
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        let requested_id = request
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let existing_index = requested_id
            .map(|id| {
                next.installations
                    .iter()
                    .position(|installation| installation.id == id)
                    .ok_or_else(|| format!("SDK installation {id} was not found"))
            })
            .transpose()?;

        if next
            .installations
            .iter()
            .enumerate()
            .any(|(index, installation)| {
                Some(index) != existing_index
                    && installation.kind == request.kind
                    && paths_equal(&installation.location, &probe.location)
            })
        {
            return Err(format!(
                "A {} installation is already registered at {}",
                request.kind.label(),
                probe.location
            ));
        }

        let id = requested_id
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let name = request
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_installation_name(request.kind, probe.version.as_deref()));
        let installation = SdkInstallation {
            id,
            kind: request.kind,
            name,
            location: probe.location,
            executables: probe.executables,
            version: probe.version,
            vendor: probe.vendor,
            architecture: probe.architecture,
            origin: request.origin.unwrap_or(SdkOrigin::Manual),
            status: probe.status,
            last_error: probe.error,
            last_probed_at: Some(Utc::now().to_rfc3339()),
        };
        if let Some(index) = existing_index {
            next.installations[index] = installation.clone();
        } else {
            next.installations.push(installation.clone());
        }
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(installation)
    }

    pub async fn remove_installation(&self, id: &str) -> Result<(), String> {
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        let original_len = next.installations.len();
        next.installations
            .retain(|installation| installation.id != id);
        if next.installations.len() == original_len {
            return Err(format!("SDK installation {id} was not found"));
        }
        next.defaults.retain(|default| default.sdk_id != id);
        next.bindings
            .retain(|binding| binding.sdk_id.as_deref() != Some(id));
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(())
    }

    pub async fn set_default(&self, request: SetSdkDefaultRequest) -> Result<(), String> {
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        next.defaults.retain(|entry| entry.kind != request.kind);
        if let Some(sdk_id) = request
            .sdk_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            require_installation(&next, sdk_id, request.kind)?;
            next.defaults.push(SdkDefault {
                kind: request.kind,
                sdk_id: sdk_id.to_string(),
            });
        }
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(())
    }

    pub async fn save_binding(
        &self,
        request: SaveWorkspaceSdkBindingRequest,
    ) -> Result<WorkspaceSdkBinding, String> {
        let scope_path = normalize_scope_path(&request.scope_path)?;
        let sdk_id = request
            .sdk_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        if request.mode == SdkBindingMode::Manual && sdk_id.is_none() {
            return Err("A manual SDK binding requires an SDK installation".to_string());
        }

        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        if let Some(id) = sdk_id.as_deref() {
            require_installation(&next, id, request.kind)?;
        }
        next.bindings.retain(|binding| {
            !(paths_equal(&binding.scope_path, &scope_path)
                && binding.kind == request.kind
                && binding.role == request.role)
        });
        let binding = WorkspaceSdkBinding {
            scope_path,
            kind: request.kind,
            role: request.role,
            mode: request.mode,
            sdk_id,
            updated_at: Utc::now().to_rfc3339(),
        };
        next.bindings.push(binding.clone());
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(binding)
    }

    pub async fn remove_binding(
        &self,
        scope_path: &str,
        kind: SdkKind,
        role: SdkRole,
    ) -> Result<(), String> {
        let scope_path = normalize_scope_path(scope_path)?;
        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        next.bindings.retain(|binding| {
            !(paths_equal(&binding.scope_path, &scope_path)
                && binding.kind == kind
                && binding.role == role)
        });
        persist_registry(&self.path, &next)?;
        *registry = next;
        self.registry_changed();
        Ok(())
    }

    pub async fn refresh_installations(
        &self,
        id: Option<&str>,
    ) -> Result<Vec<SdkInstallation>, String> {
        let snapshot = self.snapshot().await;
        let selected: Vec<_> = snapshot
            .installations
            .iter()
            .filter(|installation| id.is_none_or(|id| installation.id == id))
            .cloned()
            .collect();
        if id.is_some() && selected.is_empty() {
            return Err(format!(
                "SDK installation {} was not found",
                id.unwrap_or_default()
            ));
        }
        let mut probes = Vec::with_capacity(selected.len());
        for installation in &selected {
            probes.push((
                installation.id.clone(),
                probe::probe_sdk(installation.kind, &installation.location).await,
            ));
        }

        let mut registry = self.registry.write().await;
        let mut next = registry.clone();
        let now = Utc::now().to_rfc3339();
        for (id, probe) in probes {
            if let Some(installation) = next.installations.iter_mut().find(|item| item.id == id) {
                installation.location = probe.location;
                installation.executables = probe.executables;
                installation.version = probe.version;
                installation.vendor = probe.vendor;
                installation.architecture = probe.architecture;
                installation.status = probe.status;
                installation.last_error = probe.error;
                installation.last_probed_at = Some(now.clone());
            }
        }
        sort_registry(&mut next);
        persist_registry(&self.path, &next)?;
        let refreshed = next
            .installations
            .iter()
            .filter(|installation| selected.iter().any(|item| item.id == installation.id))
            .cloned()
            .collect();
        *registry = next;
        self.registry_changed();
        Ok(refreshed)
    }
}
