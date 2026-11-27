//! Per-profile enrollment and notification history, outside backup restore mappings.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use taomni_profile_locks::{ProfileRoot, ProfileStateLease, WaitControl};

use super::{CORE_API_VERSION, download::ModuleCatalog, install::ModuleInstaller, verify};

const FILE: &str = ".module-release.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ProfileOrigin {
    New,
    Legacy,
    Modular,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    format_version: u16,
    origin: ProfileOrigin,
    // None means a legacy profile is still waiting for a verified release roster.
    // Some(empty) records completion even if every module is later uninstalled.
    legacy_pending: Option<BTreeSet<String>>,
    sequence: Option<u64>,
    seen: BTreeSet<String>,
    new_modules: BTreeSet<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleasePlan {
    pub(crate) legacy_waiting: bool,
    pub(crate) legacy_pending: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub(crate) legacy_restart_required: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeSet::is_empty")]
    pub(crate) legacy_import_failed: BTreeSet<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub(crate) legacy_import_errors: BTreeMap<String, String>,
    pub(crate) updates: BTreeSet<String>,
    pub(crate) new_modules: BTreeSet<String>,
}

/// Run before the modular generation marker and the core SQLite files are opened.
pub(crate) fn initialize(data: &Path) -> Result<(), String> {
    access(data, |_| Ok(()))
}

pub(crate) fn plan(
    data: &Path,
    catalog: &ModuleCatalog,
    platform: &str,
) -> Result<ReleasePlan, String> {
    let installer = ModuleInstaller::new(&data.join("plugins"));
    access(data, |state| {
        let mut available = BTreeSet::new();
        let mut handled = BTreeSet::new();
        let mut updates = BTreeSet::new();
        for plugin in catalog.plugins.values() {
            if !plugin.platforms.contains_key(platform)
                || plugin.core_api_version != CORE_API_VERSION
            {
                continue;
            }
            available.insert(plugin.id.clone());
            let pointer = installer
                .active_pointer(&plugin.slug)
                .map_err(|error| error.to_string())?;
            if let Some(active) = pointer.active_version.as_deref() {
                if verify::compare_versions(&plugin.version, active)
                    .map_err(|error| error.to_string())?
                    .is_gt()
                {
                    updates.insert(plugin.id.clone());
                }
            }
            if pointer.active_version.is_some() || pointer.was_uninstalled() {
                handled.insert(plugin.id.clone());
            }
        }
        let legacy = state.origin == ProfileOrigin::Legacy;
        let first_legacy_roster = catalog
            .legacy_upgrade
            .as_ref()
            .filter(|_| legacy && state.legacy_pending.is_none());
        if let Some(roster) = first_legacy_roster {
            state.legacy_pending = Some(roster.intersection(&available).cloned().collect());
        }
        if let Some(pending) = &mut state.legacy_pending {
            pending.retain(|id| !handled.contains(id));
        }
        let legacy_waiting = legacy && state.legacy_pending.is_none();
        if !legacy_waiting && state.sequence.is_none_or(|last| catalog.sequence > last) {
            // The frozen roster is already a baseline for a profile that skips
            // directly from the monolith to a later modular release.
            if state.sequence.is_some() || first_legacy_roster.is_some() {
                state.new_modules.extend(
                    available
                        .difference(&state.seen)
                        .filter(|id| {
                            catalog
                                .plugins
                                .get(*id)
                                .is_some_and(|entry| !entry.description.trim().is_empty())
                                && !catalog
                                    .legacy_upgrade
                                    .as_ref()
                                    .is_some_and(|roster| roster.contains(*id))
                        })
                        .cloned(),
                );
            }
            state.seen.extend(available.iter().cloned());
            state.sequence = Some(catalog.sequence);
        }
        state.new_modules.retain(|id| !handled.contains(id));
        let legacy_pending = state.legacy_pending.clone().unwrap_or_default();
        let mut legacy_restart_required = BTreeSet::new();
        let mut legacy_import_failed = BTreeSet::new();
        let mut legacy_import_errors = BTreeMap::new();
        let mail_id = super::migration_mail_provision::MAIL_ID;
        if legacy_pending.contains(mail_id) {
            match super::migration_mail_provision::queued_status(data) {
                Ok(Some(status)) if !status.failed => {
                    legacy_restart_required.insert(mail_id.to_owned());
                }
                Ok(Some(status)) => {
                    legacy_import_failed.insert(mail_id.to_owned());
                    if let Some(detail) = status.error {
                        legacy_import_errors.insert(mail_id.to_owned(), detail);
                    }
                }
                Ok(None) => (),
                Err(error) => tracing::warn!(%error, "Could not read pending Mail upgrade"),
            }
        }
        Ok(ReleasePlan {
            legacy_waiting,
            legacy_pending,
            legacy_restart_required,
            legacy_import_failed,
            legacy_import_errors,
            updates,
            new_modules: state
                .new_modules
                .intersection(&available)
                .cloned()
                .collect(),
        })
    })
}

pub(crate) fn is_pending(data: &Path, id: &str) -> Result<bool, String> {
    access(data, |state| {
        Ok(state
            .legacy_pending
            .as_ref()
            .is_some_and(|ids| ids.contains(id)))
    })
}

pub(crate) fn complete(data: &Path, id: &str) -> Result<(), String> {
    access(data, |state| {
        if let Some(ids) = &mut state.legacy_pending {
            ids.remove(id);
        }
        Ok(())
    })
}

pub(crate) fn dismiss(data: &Path, ids: &[String]) -> Result<(), String> {
    access(data, |state| {
        for id in ids {
            state.new_modules.remove(id);
        }
        Ok(())
    })
}

fn access<T>(
    data: &Path,
    access: impl FnOnce(&mut State) -> Result<T, String>,
) -> Result<T, String> {
    let root = ProfileRoot::prepare(data).map_err(|error| error.to_string())?;
    let wait = WaitControl::new(Instant::now() + Duration::from_secs(5), &|| false);
    let _lease = ProfileStateLease::acquire(&root, &wait).map_err(|error| error.to_string())?;
    let path = root.path().join(FILE);
    let previous = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || super::data_contract::is_link(&metadata)
                || metadata.len() > 1024 * 1024
            {
                return Err("Invalid module release state file".into());
            }
            let state: State =
                serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
                    .map_err(|error| format!("Invalid module release state: {error}"))?;
            if state.format_version != 1 {
                return Err("Unsupported module release state version".into());
            }
            Some(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let mut current = match &previous {
        Some(state) => state.clone(),
        None => initial(root.path())?,
    };
    let output = access(&mut current)?;
    if previous.as_ref() != Some(&current) {
        crate::backup::control::write_json(&path, &current)?;
        #[cfg(unix)]
        fs::File::open(root.path())
            .and_then(|dir| dir.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}

fn exists(path: &Path) -> Result<bool, String> {
    path.try_exists().map_err(|error| error.to_string())
}

fn initial(data: &Path) -> Result<State, String> {
    let origin = if exists(&data.join(".profile-state.json"))? || exists(&data.join("plugins"))? {
        ProfileOrigin::Modular
    } else if exists(&data.join("taomni.db"))?
        || exists(&data.join(crate::migrate::LEGACY_DB_NAME))?
        || exists(&data.join("vault.db"))?
    {
        ProfileOrigin::Legacy
    } else {
        ProfileOrigin::New
    };
    Ok(State {
        format_version: 1,
        origin,
        legacy_pending: None,
        sequence: None,
        seen: BTreeSet::new(),
        new_modules: BTreeSet::new(),
    })
}

#[cfg(test)]
mod tests;
