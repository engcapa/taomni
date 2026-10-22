mod detect;

mod probe;

mod resolve;

mod runtime;

pub use runtime::{JavaRuntimeConfiguration, WorkspaceSdkEnvironment};

use crate::state::AppState;

use chrono::Utc;

use serde::{Deserialize, Serialize};

use std::collections::{BTreeMap, HashMap};

use std::fs::OpenOptions;

use std::io::Write;

use std::path::{Path, PathBuf};

use std::sync::atomic::{AtomicU64, Ordering};

use std::time::{Duration, Instant};

use tauri::State;

use tokio::sync::{Mutex, RwLock};

mod model;

mod manager;

mod persistence;

mod commands;

mod registry_policy;

#[cfg(test)]
mod tests;

pub use model::{
    SaveSdkInstallationRequest, SaveWorkspaceSdkBindingRequest, SdkBindingMode, SdkDefault,
    SdkInstallation, SdkKind, SdkOrigin, SdkProbe, SdkRegistry, SdkRole, SdkStatus,
    SetSdkDefaultRequest, WorkspaceSdkBinding,
};

use model::SDK_REGISTRY_SCHEMA_VERSION;

pub use manager::SdkManager;

use manager::{CachedWorkspaceResolution, WORKSPACE_RESOLUTION_CACHE_TTL};

pub use persistence::default_sdk_registry_path;

pub(crate) use persistence::strip_verbatim_prefix;

use persistence::{
    backup_path, load_registry, normalize_registry_paths, persist_registry, read_registry,
};

pub use commands::{
    sdk_analyze_workspace, sdk_discover_installations, sdk_get_registry, sdk_probe_installation,
    sdk_refresh_installations, sdk_remove_installation, sdk_remove_workspace_binding,
    sdk_resolve_workspace, sdk_save_installation, sdk_save_workspace_binding, sdk_set_default,
};

pub(crate) use commands::{
    __cmd__sdk_analyze_workspace, __cmd__sdk_discover_installations, __cmd__sdk_get_registry,
    __cmd__sdk_probe_installation, __cmd__sdk_refresh_installations,
    __cmd__sdk_remove_installation, __cmd__sdk_remove_workspace_binding,
    __cmd__sdk_resolve_workspace, __cmd__sdk_save_installation, __cmd__sdk_save_workspace_binding,
    __cmd__sdk_set_default, __tauri_command_name_sdk_analyze_workspace,
    __tauri_command_name_sdk_discover_installations, __tauri_command_name_sdk_get_registry,
    __tauri_command_name_sdk_probe_installation, __tauri_command_name_sdk_refresh_installations,
    __tauri_command_name_sdk_remove_installation,
    __tauri_command_name_sdk_remove_workspace_binding, __tauri_command_name_sdk_resolve_workspace,
    __tauri_command_name_sdk_save_installation, __tauri_command_name_sdk_save_workspace_binding,
    __tauri_command_name_sdk_set_default,
};

use registry_policy::{
    default_installation_name, normalize_scope_path, paths_equal, require_installation,
    sort_registry,
};
