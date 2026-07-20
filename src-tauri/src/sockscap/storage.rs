//! Dedicated Sockscap persistence.
//!
//! `sockscap.db` deliberately contains only routing configuration, recovery
//! metadata, and bounded aggregate statistics. Proxy/SSH sessions remain in
//! `taomni.db`; credentials and host-key trust remain in Vault/known-hosts.

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::flow::stats::FlowOutcomeKind;
use super::policy::{
    GFWLIST_OFFICIAL_SOURCE_ID, RuleSourceKind, compile_custom_rules, validate_source_id,
};
use super::types::{
    CapturePlatform, HostnameSource, RouteAction, RoutingProfileDraft, StatsCollectionMode,
    detect_profile_conflicts, validate_profile_draft,
};

pub const SOCKSCAP_DB_FILE: &str = "sockscap.db";
pub const SOCKSCAP_OWNER_LOCK_FILE: &str = "sockscap.owner.lock";
pub const SOCKSCAP_STORE_ALREADY_OPEN: &str = "SOCKSCAP_STORE_ALREADY_OPEN";
pub const SOCKSCAP_SCHEMA_VERSION: i64 = 1;
const RESTORE_ON_SYSTEM_LOGIN_SETTING: &str = "restore_on_system_login";
const MAX_RECOVERY_ARTIFACT_BYTES: usize = 64 * 1024;
const DEFAULT_MINUTE_RETENTION_DAYS: i64 = 7;
const DEFAULT_HOURLY_RETENTION_DAYS: i64 = 90;

/// Thread-safe handle for the standalone Sockscap SQLite database.
pub struct SockscapStore {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    // Declared after `conn` so the database closes before the process-wide
    // ownership lock is released during normal field drop.
    _owner_lock: Option<File>,
    // Keep the canonical application-data directory open while SQLite and the
    // owner lock are live. Platform validation below detects path replacement;
    // a future handle-relative SQLite VFS is still required to eliminate the
    // remaining same-user TOCTOU window completely.
    _app_data_dir_guard: Option<File>,
    capture_operation: Arc<tokio::sync::Mutex<()>>,
}

impl SockscapStore {
    pub fn open(app_data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("create app data directory: {error}"))?;
        let app_data_dir = std::fs::canonicalize(app_data_dir)
            .map_err(|error| format!("canonicalize Sockscap app data directory: {error}"))?;
        let app_data_dir_guard = open_app_data_dir_guard(&app_data_dir)?;
        validate_app_data_dir_binding(app_data_dir_guard.as_ref(), &app_data_dir)?;

        let owner_lock = acquire_owner_lock(&app_data_dir)?;
        validate_app_data_dir_binding(app_data_dir_guard.as_ref(), &app_data_dir)?;
        let path = app_data_dir.join(SOCKSCAP_DB_FILE);
        validate_database_path(&path)?;
        let conn =
            Connection::open(&path).map_err(|error| format!("open {}: {error}", path.display()))?;
        configure_connection(&conn, true)?;
        migrate(&conn)?;
        harden_database_file(&path)?;
        validate_database_path(&path)?;
        validate_owner_lock_binding(&owner_lock, &app_data_dir.join(SOCKSCAP_OWNER_LOCK_FILE))?;
        validate_app_data_dir_binding(app_data_dir_guard.as_ref(), &app_data_dir)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: Some(path),
            _owner_lock: Some(owner_lock),
            _app_data_dir_guard: app_data_dir_guard,
            capture_operation: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
        configure_connection(&conn, false)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
            _owner_lock: None,
            _app_data_dir_guard: None,
            capture_operation: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub(crate) fn capture_operation(&self) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(&self.capture_operation)
    }

    pub fn database_path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn schema_version(&self) -> Result<i64, String> {
        self.lock_conn()?
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("read Sockscap schema version: {error}"))
    }

    fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "sockscap database lock poisoned".to_string())
    }

    pub fn list_profiles(&self) -> Result<Vec<PersistedRoutingProfile>, String> {
        let conn = self.lock_conn()?;
        load_profiles(&conn)
    }

    pub fn get_profile(&self, id: &str) -> Result<Option<PersistedRoutingProfile>, String> {
        validate_safe_id("profile id", id)?;
        let conn = self.lock_conn()?;
        load_profile(&conn, id)
    }

    /// Atomically validate and replace one profile and all ordered child rows.
    /// `expected_revision` supplies optimistic concurrency for multiple windows.
    pub fn upsert_profile(
        &self,
        profile: &RoutingProfileDraft,
        expected_revision: Option<u64>,
    ) -> Result<PersistedRoutingProfile, String> {
        validate_persisted_profile(profile)?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin profile transaction: {error}"))?;

        let existing = load_profile(&tx, &profile.id)?;
        if let Some(expected) = expected_revision {
            let actual = existing.as_ref().map(|value| value.revision).unwrap_or(0);
            if expected != actual {
                return Err(format!(
                    "PROFILE_REVISION_CONFLICT: expected revision {expected}, current revision {actual}"
                ));
            }
        }

        ensure_rule_sources_exist(&tx, &profile.rule_source_ids)?;
        let mut candidates = load_profiles(&tx)?
            .into_iter()
            .map(|record| record.profile)
            .filter(|stored| stored.id != profile.id)
            .collect::<Vec<_>>();
        candidates.push(profile.clone());
        if let Some(conflict) = detect_profile_conflicts(&candidates).into_iter().next() {
            return Err(format!(
                "PROFILE_CONFLICT: {} and {}: {}",
                conflict.profile_a, conflict.profile_b, conflict.reason
            ));
        }

        let now = unix_now();
        let created_at = existing
            .as_ref()
            .map(|record| record.created_at)
            .unwrap_or(now);
        let revision = existing
            .as_ref()
            .map(|record| record.revision.saturating_add(1))
            .unwrap_or(1);
        let draft_json = serde_json::to_string(profile)
            .map_err(|error| format!("serialize routing profile: {error}"))?;
        let scope = enum_name(&profile.scope)?;
        let egress_kind = profile
            .egress_kind
            .map(|value| enum_name(&value))
            .transpose()?;

        tx.execute(
            "INSERT INTO routing_profiles
             (id, name, enabled, priority, scope, include_children, egress_kind,
              egress_ref_id, draft_json, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               enabled = excluded.enabled,
               priority = excluded.priority,
               scope = excluded.scope,
               include_children = excluded.include_children,
               egress_kind = excluded.egress_kind,
               egress_ref_id = excluded.egress_ref_id,
               draft_json = excluded.draft_json,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![
                &profile.id,
                profile.name.trim(),
                profile.enabled,
                i64::from(profile.priority),
                scope,
                profile.include_children,
                egress_kind,
                profile.egress_ref_id.as_deref(),
                draft_json,
                to_sql_counter(revision, "profile revision")?,
                created_at,
                now,
            ],
        )
        .map_err(|error| format!("write routing profile: {error}"))?;

        replace_profile_children(&tx, profile)?;
        tx.commit()
            .map_err(|error| format!("commit routing profile: {error}"))?;

        Ok(PersistedRoutingProfile {
            profile: profile.clone(),
            revision,
            created_at,
            updated_at: now,
        })
    }

    pub fn delete_profile(&self, id: &str, expected_revision: Option<u64>) -> Result<(), String> {
        validate_safe_id("profile id", id)?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin delete profile transaction: {error}"))?;
        let current = load_profile(&tx, id)?
            .ok_or_else(|| format!("PROFILE_NOT_FOUND: routing profile '{id}' does not exist"))?;
        if expected_revision.is_some_and(|expected| expected != current.revision) {
            return Err(format!(
                "PROFILE_REVISION_CONFLICT: expected revision {}, current revision {}",
                expected_revision.unwrap_or_default(),
                current.revision
            ));
        }
        tx.execute("DELETE FROM routing_profiles WHERE id = ?1", params![id])
            .map_err(|error| format!("delete routing profile: {error}"))?;
        tx.commit()
            .map_err(|error| format!("commit delete routing profile: {error}"))
    }

    /// Freeze the currently enabled, validated profiles for a start/update
    /// transaction. Draft edits after this point cannot mutate the snapshot.
    pub fn prepare_config_snapshot(&self) -> Result<RoutingConfigSnapshot, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin config snapshot transaction: {error}"))?;
        let profiles = load_profiles(&tx)?
            .into_iter()
            .map(|record| record.profile)
            .filter(|profile| profile.enabled)
            .collect::<Vec<_>>();
        if profiles.is_empty() {
            return Err("NO_ENABLED_PROFILES: cannot prepare an empty routing snapshot".into());
        }
        for profile in &profiles {
            validate_persisted_profile(profile)?;
        }
        if let Some(conflict) = detect_profile_conflicts(&profiles).into_iter().next() {
            return Err(format!(
                "PROFILE_CONFLICT: {} and {}: {}",
                conflict.profile_a, conflict.profile_b, conflict.reason
            ));
        }
        let current_revision: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM engine_config_snapshots",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("read config snapshot revision: {error}"))?;
        let revision = u64::try_from(current_revision)
            .map_err(|error| format!("decode config snapshot revision: {error}"))?
            .checked_add(1)
            .ok_or_else(|| "config snapshot revision exhausted".to_string())?;
        let profile_ids = profiles
            .iter()
            .map(|profile| profile.id.clone())
            .collect::<Vec<_>>();
        let profile_ids_json = serde_json::to_string(&profile_ids)
            .map_err(|error| format!("serialize config snapshot ids: {error}"))?;
        let profiles_json = serde_json::to_string(&profiles)
            .map_err(|error| format!("serialize config snapshot: {error}"))?;
        let now = unix_now();
        tx.execute(
            "INSERT INTO engine_config_snapshots
             (revision, state, profile_ids_json, profiles_json, created_at, committed_at)
             VALUES (?1, 'prepared', ?2, ?3, ?4, NULL)",
            params![
                to_sql_counter(revision, "config snapshot revision")?,
                profile_ids_json,
                profiles_json,
                now,
            ],
        )
        .map_err(|error| format!("write prepared config snapshot: {error}"))?;
        let snapshot = load_config_snapshot(&tx, revision)?
            .ok_or_else(|| "prepared config snapshot disappeared".to_string())?;
        tx.commit()
            .map_err(|error| format!("commit prepared config snapshot: {error}"))?;
        Ok(snapshot)
    }

    /// Publish a prepared snapshot only after capture and self-check commit.
    pub fn commit_config_snapshot(&self, revision: u64) -> Result<RoutingConfigSnapshot, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin config snapshot commit: {error}"))?;
        let current = load_config_snapshot(&tx, revision)?
            .ok_or_else(|| format!("CONFIG_SNAPSHOT_NOT_FOUND: revision {revision}"))?;
        if current.state == ConfigSnapshotState::Committed {
            return Ok(current);
        }
        if current.state != ConfigSnapshotState::Prepared {
            return Err(format!(
                "CONFIG_SNAPSHOT_STATE_CONFLICT: revision {revision} is {:?}",
                current.state
            ));
        }
        let now = unix_now();
        tx.execute(
            "UPDATE engine_config_snapshots
             SET state = 'superseded'
             WHERE state = 'committed'",
            [],
        )
        .map_err(|error| format!("supersede previous config snapshot: {error}"))?;
        tx.execute(
            "UPDATE engine_config_snapshots
             SET state = 'committed', committed_at = ?1
             WHERE revision = ?2 AND state = 'prepared'",
            params![now, to_sql_counter(revision, "config snapshot revision")?],
        )
        .map_err(|error| format!("publish config snapshot: {error}"))?;
        tx.execute(
            "DELETE FROM engine_config_snapshots
             WHERE state = 'superseded'
               AND revision NOT IN (
                 SELECT revision FROM engine_config_snapshots
                 WHERE state = 'superseded' ORDER BY revision DESC LIMIT 16
               )
               AND revision != COALESCE((
                 SELECT config_revision FROM engine_recovery_journal
                 WHERE singleton_id = 1 AND cleanup_required = 1
               ), -1)",
            [],
        )
        .map_err(|error| format!("prune old config snapshots: {error}"))?;
        let committed = load_config_snapshot(&tx, revision)?
            .ok_or_else(|| "committed config snapshot disappeared".to_string())?;
        tx.commit()
            .map_err(|error| format!("commit config snapshot publication: {error}"))?;
        Ok(committed)
    }

    pub fn last_committed_config_snapshot(&self) -> Result<Option<RoutingConfigSnapshot>, String> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT revision, state, profiles_json, created_at, committed_at
             FROM engine_config_snapshots WHERE state = 'committed'",
            [],
            row_to_config_snapshot,
        )
        .optional()
        .map_err(|error| format!("read committed config snapshot: {error}"))
    }

    pub fn discard_prepared_config_snapshot(&self, revision: u64) -> Result<(), String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin config snapshot discard: {error}"))?;
        let current = load_config_snapshot(&tx, revision)?
            .ok_or_else(|| format!("CONFIG_SNAPSHOT_NOT_FOUND: revision {revision}"))?;
        if current.state != ConfigSnapshotState::Prepared {
            return Err(format!(
                "CONFIG_SNAPSHOT_STATE_CONFLICT: only prepared snapshots can be discarded, got {:?}",
                current.state
            ));
        }
        let referenced: bool = tx
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM engine_recovery_journal
                   WHERE singleton_id = 1 AND cleanup_required = 1 AND config_revision = ?1
                 )",
                params![to_sql_counter(revision, "config snapshot revision")?],
                |row| row.get(0),
            )
            .map_err(|error| format!("check recovery snapshot reference: {error}"))?;
        if referenced {
            return Err(format!(
                "CONFIG_SNAPSHOT_IN_USE: revision {revision} is referenced by recovery journal"
            ));
        }
        tx.execute(
            "DELETE FROM engine_config_snapshots WHERE revision = ?1 AND state = 'prepared'",
            params![to_sql_counter(revision, "config snapshot revision")?],
        )
        .map_err(|error| format!("discard prepared config snapshot: {error}"))?;
        tx.commit()
            .map_err(|error| format!("commit config snapshot discard: {error}"))
    }

    pub fn list_rule_sources(&self) -> Result<Vec<PersistedRuleSource>, String> {
        let conn = self.lock_conn()?;
        let mut statement = conn
            .prepare(
                "SELECT draft_json, revision, created_at, updated_at
                 FROM rule_sources ORDER BY name COLLATE NOCASE, id",
            )
            .map_err(|error| format!("prepare rule source list: {error}"))?;
        statement
            .query_map([], row_to_rule_source)
            .map_err(|error| format!("query rule sources: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("read rule sources: {error}"))
    }

    pub fn upsert_rule_source(
        &self,
        source: &RuleSourceDraft,
        expected_revision: Option<u64>,
    ) -> Result<PersistedRuleSource, String> {
        validate_rule_source(source)?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin rule source transaction: {error}"))?;
        let existing = load_rule_source(&tx, &source.id)?;
        if source.id == GFWLIST_OFFICIAL_SOURCE_ID && existing.is_some() {
            return Err("BUILTIN_RULE_SOURCE_READ_ONLY: official GFWList metadata is fixed".into());
        }
        if let Some(expected) = expected_revision {
            let actual = existing.as_ref().map(|value| value.revision).unwrap_or(0);
            if expected != actual {
                return Err(format!(
                    "RULE_SOURCE_REVISION_CONFLICT: expected revision {expected}, current revision {actual}"
                ));
            }
        }
        let now = unix_now();
        let created_at = existing
            .as_ref()
            .map(|record| record.created_at)
            .unwrap_or(now);
        let revision = existing
            .as_ref()
            .map(|record| record.revision.saturating_add(1))
            .unwrap_or(1);
        let draft_json = serde_json::to_string(source)
            .map_err(|error| format!("serialize rule source: {error}"))?;
        tx.execute(
            "INSERT INTO rule_sources
             (id, name, enabled, kind, source_url, refresh_interval_seconds,
              draft_json, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               enabled = excluded.enabled,
               kind = excluded.kind,
               source_url = excluded.source_url,
               refresh_interval_seconds = excluded.refresh_interval_seconds,
               draft_json = excluded.draft_json,
               revision = excluded.revision,
               updated_at = excluded.updated_at",
            params![
                &source.id,
                source.name.trim(),
                source.enabled,
                enum_name(&source.kind)?,
                source.url.as_deref(),
                to_sql_counter(
                    source.refresh_interval_seconds,
                    "rule source refresh interval"
                )?,
                draft_json,
                to_sql_counter(revision, "rule source revision")?,
                created_at,
                now,
            ],
        )
        .map_err(|error| format!("write rule source: {error}"))?;
        tx.commit()
            .map_err(|error| format!("commit rule source: {error}"))?;
        Ok(PersistedRuleSource {
            source: source.clone(),
            revision,
            created_at,
            updated_at: now,
        })
    }

    pub fn delete_rule_source(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), String> {
        validate_safe_id("rule source id", id)?;
        if id == GFWLIST_OFFICIAL_SOURCE_ID {
            return Err("BUILTIN_RULE_SOURCE_READ_ONLY: official GFWList cannot be deleted".into());
        }
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin delete rule source transaction: {error}"))?;
        let current = load_rule_source(&tx, id)?
            .ok_or_else(|| format!("RULE_SOURCE_NOT_FOUND: rule source '{id}' does not exist"))?;
        if expected_revision.is_some_and(|expected| expected != current.revision) {
            return Err(format!(
                "RULE_SOURCE_REVISION_CONFLICT: expected revision {}, current revision {}",
                expected_revision.unwrap_or_default(),
                current.revision
            ));
        }
        let references: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM profile_rule_sources WHERE source_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| format!("check rule source references: {error}"))?;
        if references != 0 {
            return Err(format!(
                "RULE_SOURCE_IN_USE: rule source '{id}' is referenced by {references} profile(s)"
            ));
        }
        tx.execute("DELETE FROM rule_sources WHERE id = ?1", params![id])
            .map_err(|error| format!("delete rule source: {error}"))?;
        tx.commit()
            .map_err(|error| format!("commit delete rule source: {error}"))
    }

    pub fn recovery_journal(&self) -> Result<RecoveryJournal, String> {
        let conn = self.lock_conn()?;
        load_recovery_journal(&conn)
    }

    /// Read the opt-in login restore preference. A missing row is the secure
    /// first-install default and never enables operating-system autostart.
    pub fn lifecycle_preferences(&self) -> Result<LifecyclePreferences, String> {
        let conn = self.lock_conn()?;
        conn.query_row(
            "SELECT value_json, updated_at FROM engine_settings WHERE key = ?1",
            params![RESTORE_ON_SYSTEM_LOGIN_SETTING],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| format!("read Sockscap lifecycle preferences: {error}"))?
        .map(|(value_json, updated_at)| {
            serde_json::from_str::<bool>(&value_json)
                .map(|restore_on_system_login| LifecyclePreferences {
                    restore_on_system_login,
                    updated_at: Some(updated_at),
                })
                .map_err(|error| format!("decode Sockscap lifecycle preferences: {error}"))
        })
        .transpose()
        .map(|value| value.unwrap_or_default())
    }

    /// Persist only the user's intent. The command boundary owns the matching
    /// OS autostart registration and writes this row only after that succeeds.
    pub fn set_restore_on_system_login(
        &self,
        enabled: bool,
    ) -> Result<LifecyclePreferences, String> {
        let now = unix_now();
        let value_json = serde_json::to_string(&enabled)
            .map_err(|error| format!("encode Sockscap lifecycle preferences: {error}"))?;
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO engine_settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
            params![RESTORE_ON_SYSTEM_LOGIN_SETTING, value_json, now],
        )
        .map_err(|error| format!("write Sockscap lifecycle preferences: {error}"))?;
        Ok(LifecyclePreferences {
            restore_on_system_login: enabled,
            updated_at: Some(now),
        })
    }

    pub fn begin_prepare(
        &self,
        active_profile_ids: &[String],
        config_revision: u64,
        platform: CapturePlatform,
        restore_after_recovery: bool,
        adapter_id: &str,
    ) -> Result<RecoveryJournal, String> {
        validate_safe_id("recovery adapter id", adapter_id)?;
        if active_profile_ids.is_empty() || active_profile_ids.len() > 1024 {
            return Err("recovery marker requires 1-1024 active profile ids".into());
        }
        let mut unique = HashSet::new();
        for id in active_profile_ids {
            validate_safe_id("recovery profile id", id)?;
            if !unique.insert(id) {
                return Err("recovery profile ids must be unique".into());
            }
        }
        let profile_ids_json = serde_json::to_string(active_profile_ids)
            .map_err(|error| format!("serialize recovery profiles: {error}"))?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin recovery transaction: {error}"))?;
        let current = load_recovery_journal(&tx)?;
        if current.cleanup_required || current.phase != RecoveryPhase::Clean {
            return Err(format!(
                "RECOVERY_REQUIRED: previous recovery generation {} is {:?}",
                current.generation, current.phase
            ));
        }
        let generation = current.generation.saturating_add(1);
        let adapter_binding = serde_json::to_string(&serde_json::json!({
            "bindingSchemaVersion": 1,
            "bindingState": "adapter_selected",
            "adapter": adapter_id,
            "generation": generation,
        }))
        .map_err(|error| format!("serialize recovery adapter binding: {error}"))?;
        let now = unix_now();
        tx.execute(
            "UPDATE engine_recovery_journal SET
               generation = ?1, phase = 'preparing', cleanup_required = 1,
               restore_after_recovery = ?2, config_revision = ?3,
               platform = ?4, active_profile_ids_json = ?5,
               artifact_state_json = ?6, helper_pid = NULL,
               last_heartbeat_at = NULL, last_error_code = NULL,
               created_at = ?7, updated_at = ?7
             WHERE singleton_id = 1",
            params![
                to_sql_counter(generation, "recovery generation")?,
                restore_after_recovery,
                to_sql_counter(config_revision, "recovery config revision")?,
                enum_name(&platform)?,
                profile_ids_json,
                adapter_binding,
                now,
            ],
        )
        .map_err(|error| format!("write preparing recovery marker: {error}"))?;
        let journal = load_recovery_journal(&tx)?;
        tx.commit()
            .map_err(|error| format!("commit preparing recovery marker: {error}"))?;
        Ok(journal)
    }

    pub fn record_capture_installed(
        &self,
        generation: u64,
        artifact_state: &Value,
    ) -> Result<RecoveryJournal, String> {
        validate_recovery_artifact(artifact_state)?;
        self.transition_recovery(
            generation,
            &[RecoveryPhase::Preparing],
            RecoveryPhase::CaptureInstalled,
            Some(artifact_state),
            None,
        )
    }

    /// Replace the non-secret recovery receipt without changing lifecycle
    /// phase. Helpers use this after a membership refresh or a partial failure
    /// so every privileged mutation remains recoverable after an app crash.
    pub fn update_recovery_artifact(
        &self,
        generation: u64,
        artifact_state: &Value,
    ) -> Result<RecoveryJournal, String> {
        validate_recovery_artifact(artifact_state)?;
        let artifact_json = serde_json::to_string(artifact_state)
            .map_err(|error| format!("serialize recovery artifact: {error}"))?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin recovery artifact update: {error}"))?;
        let current = load_recovery_journal(&tx)?;
        ensure_generation(&current, generation)?;
        if !current.cleanup_required || current.phase == RecoveryPhase::Clean {
            return Err(
                "RECOVERY_STATE_CONFLICT: cannot update an artifact without a recovery marker"
                    .into(),
            );
        }
        let now = unix_now();
        tx.execute(
            "UPDATE engine_recovery_journal
             SET artifact_state_json = ?1, updated_at = ?2
             WHERE singleton_id = 1 AND generation = ?3",
            params![
                artifact_json,
                now,
                to_sql_counter(generation, "recovery generation")?
            ],
        )
        .map_err(|error| format!("write recovery artifact update: {error}"))?;
        let journal = load_recovery_journal(&tx)?;
        tx.commit()
            .map_err(|error| format!("commit recovery artifact update: {error}"))?;
        Ok(journal)
    }

    pub fn commit_active(&self, generation: u64) -> Result<RecoveryJournal, String> {
        self.transition_recovery(
            generation,
            &[RecoveryPhase::CaptureInstalled],
            RecoveryPhase::Active,
            None,
            None,
        )
    }

    pub fn begin_stop(&self, generation: u64) -> Result<RecoveryJournal, String> {
        self.transition_recovery(
            generation,
            &[
                RecoveryPhase::Preparing,
                RecoveryPhase::CaptureInstalled,
                RecoveryPhase::Active,
                RecoveryPhase::RecoveryRequired,
            ],
            RecoveryPhase::Stopping,
            None,
            None,
        )
    }

    pub fn mark_recovery_required(
        &self,
        generation: u64,
        error_code: &str,
    ) -> Result<RecoveryJournal, String> {
        validate_error_code(error_code)?;
        self.transition_recovery(
            generation,
            &[
                RecoveryPhase::Preparing,
                RecoveryPhase::CaptureInstalled,
                RecoveryPhase::Active,
                RecoveryPhase::Stopping,
                RecoveryPhase::RecoveryRequired,
            ],
            RecoveryPhase::RecoveryRequired,
            None,
            Some(error_code),
        )
    }

    pub fn record_helper_heartbeat(
        &self,
        generation: u64,
        helper_pid: u32,
    ) -> Result<RecoveryJournal, String> {
        if helper_pid == 0 {
            return Err("helper PID must be non-zero".into());
        }
        let conn = self.lock_conn()?;
        let current = load_recovery_journal(&conn)?;
        ensure_generation(&current, generation)?;
        if !current.cleanup_required {
            return Err("cannot record helper heartbeat without an active recovery marker".into());
        }
        let now = unix_now();
        conn.execute(
            "UPDATE engine_recovery_journal
             SET helper_pid = ?1, last_heartbeat_at = ?2, updated_at = ?2
             WHERE singleton_id = 1 AND generation = ?3",
            params![
                i64::from(helper_pid),
                now,
                to_sql_counter(generation, "recovery generation")?
            ],
        )
        .map_err(|error| format!("record helper heartbeat: {error}"))?;
        load_recovery_journal(&conn)
    }

    /// Clear a marker only after the platform adapter/helper confirms cleanup.
    pub fn complete_recovery(&self, generation: u64) -> Result<RecoveryJournal, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin recovery completion: {error}"))?;
        let current = load_recovery_journal(&tx)?;
        ensure_generation(&current, generation)?;
        if !matches!(
            current.phase,
            RecoveryPhase::Preparing
                | RecoveryPhase::CaptureInstalled
                | RecoveryPhase::Stopping
                | RecoveryPhase::RecoveryRequired
        ) {
            return Err(format!(
                "RECOVERY_STATE_CONFLICT: cannot complete cleanup from {:?}",
                current.phase
            ));
        }
        let now = unix_now();
        tx.execute(
            "UPDATE engine_recovery_journal SET
               phase = 'clean', cleanup_required = 0,
               active_profile_ids_json = '[]', artifact_state_json = '{}',
               helper_pid = NULL, last_heartbeat_at = NULL,
               last_error_code = NULL, updated_at = ?1
             WHERE singleton_id = 1 AND generation = ?2",
            params![now, to_sql_counter(generation, "recovery generation")?],
        )
        .map_err(|error| format!("clear recovery marker: {error}"))?;
        let journal = load_recovery_journal(&tx)?;
        tx.commit()
            .map_err(|error| format!("commit recovery completion: {error}"))?;
        Ok(journal)
    }

    /// Batch aggregate flow lifecycle/byte deltas. The hot path should feed a
    /// bounded in-memory queue and call this method from its periodic worker.
    pub fn record_traffic_batch(&self, deltas: &[TrafficMinuteDelta]) -> Result<usize, String> {
        if deltas.len() > 100_000 {
            return Err("traffic statistics batch exceeds 100000 rows".into());
        }
        for delta in deltas {
            validate_traffic_delta(delta)?;
        }
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin traffic statistics transaction: {error}"))?;
        let mut persisted = 0;
        let mut collection_modes = HashMap::new();
        for delta in deltas {
            let mode = match collection_modes.get(&delta.profile_id) {
                Some(mode) => *mode,
                None => {
                    let mode = profile_collection_mode(&tx, &delta.profile_id)?;
                    collection_modes.insert(delta.profile_id.clone(), mode);
                    mode
                }
            };
            if mode != StatsCollectionMode::Persisted {
                continue;
            }
            tx.execute(
                "INSERT INTO traffic_minute_buckets
                 (bucket_start, profile_id, app_identity, protocol, hostname_source,
                  policy_action, effective_action, outcome, connector, error_code,
                  bytes_up, bytes_down, connections, errors, connect_millis_total)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                         ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(
                   bucket_start, profile_id, app_identity, protocol, hostname_source,
                   policy_action, effective_action, outcome, connector, error_code
                 ) DO UPDATE SET
                   bytes_up = bytes_up + excluded.bytes_up,
                   bytes_down = bytes_down + excluded.bytes_down,
                   connections = connections + excluded.connections,
                   errors = errors + excluded.errors,
                   connect_millis_total = connect_millis_total + excluded.connect_millis_total",
                params![
                    delta.bucket_start,
                    &delta.profile_id,
                    delta.app_identity.as_deref().unwrap_or(""),
                    &delta.protocol,
                    enum_name(&delta.hostname_source)?,
                    enum_name(&delta.policy_action)?,
                    enum_name(&delta.effective_action)?,
                    enum_name(&delta.outcome)?,
                    delta.connector.as_deref().unwrap_or(""),
                    delta.error_code.as_deref().unwrap_or(""),
                    to_sql_counter(delta.bytes_up, "bytesUp")?,
                    to_sql_counter(delta.bytes_down, "bytesDown")?,
                    to_sql_counter(delta.connections, "connections")?,
                    to_sql_counter(delta.errors, "errors")?,
                    to_sql_counter(delta.connect_millis_total, "connectMillisTotal")?,
                ],
            )
            .map_err(|error| format!("upsert traffic minute bucket: {error}"))?;
            persisted += 1;
        }
        tx.commit()
            .map_err(|error| format!("commit traffic statistics: {error}"))?;
        Ok(persisted)
    }

    pub fn record_domain_batch(&self, deltas: &[DomainDayDelta]) -> Result<usize, String> {
        if deltas.len() > 50_000 {
            return Err("domain statistics batch exceeds 50000 rows".into());
        }
        let normalized = deltas
            .iter()
            .map(|delta| {
                if delta.day_start < 0 || delta.day_start % 86_400 != 0 {
                    return Err("domain statistics dayStart must align to UTC day".to_string());
                }
                validate_safe_id("domain statistics profile id", &delta.profile_id)?;
                Ok((delta, normalize_stats_domain(&delta.domain)?))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin domain statistics transaction: {error}"))?;
        let mut persisted = 0;
        let mut privacy_by_profile = HashMap::new();
        for (delta, domain) in normalized {
            if !privacy_by_profile.contains_key(&delta.profile_id) {
                let privacy = profile_stats_privacy(&tx, &delta.profile_id)?;
                privacy_by_profile.insert(delta.profile_id.clone(), privacy);
            }
            let privacy = privacy_by_profile
                .get(&delta.profile_id)
                .ok_or_else(|| "profile privacy cache invariant failed".to_string())?;
            if privacy.collection_mode != StatsCollectionMode::Persisted
                || !privacy.domain_aggregation_enabled
            {
                continue;
            }
            tx.execute(
                "INSERT INTO optional_domain_day_buckets
                 (day_start, profile_id, domain, bytes_up, bytes_down, connections)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(day_start, profile_id, domain) DO UPDATE SET
                   bytes_up = bytes_up + excluded.bytes_up,
                   bytes_down = bytes_down + excluded.bytes_down,
                   connections = connections + excluded.connections",
                params![
                    delta.day_start,
                    &delta.profile_id,
                    domain,
                    to_sql_counter(delta.bytes_up, "domain bytesUp")?,
                    to_sql_counter(delta.bytes_down, "domain bytesDown")?,
                    to_sql_counter(delta.connections, "domain connections")?,
                ],
            )
            .map_err(|error| format!("upsert domain day bucket: {error}"))?;
            persisted += 1;
        }
        tx.commit()
            .map_err(|error| format!("commit domain statistics: {error}"))?;
        Ok(persisted)
    }

    pub fn record_egress_health_batch(
        &self,
        deltas: &[EgressHealthMinuteDelta],
    ) -> Result<usize, String> {
        if deltas.len() > 50_000 {
            return Err("egress health batch exceeds 50000 rows".into());
        }
        for delta in deltas {
            validate_egress_health_delta(delta)?;
        }
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin egress health transaction: {error}"))?;
        let mut persisted = 0;
        let mut collection_modes = HashMap::new();
        for delta in deltas {
            let mode = match collection_modes.get(&delta.profile_id) {
                Some(mode) => *mode,
                None => {
                    let mode = profile_collection_mode(&tx, &delta.profile_id)?;
                    collection_modes.insert(delta.profile_id.clone(), mode);
                    mode
                }
            };
            if mode != StatsCollectionMode::Persisted {
                continue;
            }
            tx.execute(
                "INSERT INTO egress_health_minute_buckets
                 (bucket_start, profile_id, egress_kind, control_state,
                  active_controls_max, active_channels_max, channel_errors,
                  reconnects, bytes_up, bytes_down, handshake_millis_total,
                  handshake_samples, host_key_state, last_error_code)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(
                   bucket_start, profile_id, egress_kind, control_state,
                   host_key_state, last_error_code
                 ) DO UPDATE SET
                   active_controls_max = MAX(active_controls_max, excluded.active_controls_max),
                   active_channels_max = MAX(active_channels_max, excluded.active_channels_max),
                   channel_errors = channel_errors + excluded.channel_errors,
                   reconnects = reconnects + excluded.reconnects,
                   bytes_up = bytes_up + excluded.bytes_up,
                   bytes_down = bytes_down + excluded.bytes_down,
                   handshake_millis_total = handshake_millis_total + excluded.handshake_millis_total,
                   handshake_samples = handshake_samples + excluded.handshake_samples",
                params![
                    delta.bucket_start,
                    &delta.profile_id,
                    &delta.egress_kind,
                    &delta.control_state,
                    to_sql_counter(delta.active_controls_max, "activeControlsMax")?,
                    to_sql_counter(delta.active_channels_max, "activeChannelsMax")?,
                    to_sql_counter(delta.channel_errors, "channelErrors")?,
                    to_sql_counter(delta.reconnects, "reconnects")?,
                    to_sql_counter(delta.bytes_up, "egress bytesUp")?,
                    to_sql_counter(delta.bytes_down, "egress bytesDown")?,
                    to_sql_counter(delta.handshake_millis_total, "handshakeMillisTotal")?,
                    to_sql_counter(delta.handshake_samples, "handshakeSamples")?,
                    delta.host_key_state.as_deref().unwrap_or(""),
                    delta.last_error_code.as_deref().unwrap_or(""),
                ],
            )
            .map_err(|error| format!("upsert egress health bucket: {error}"))?;
            persisted += 1;
        }
        tx.commit()
            .map_err(|error| format!("commit egress health statistics: {error}"))?;
        Ok(persisted)
    }

    pub fn stats_snapshot(&self, query: &StatsSnapshotQuery) -> Result<StatsSnapshot, String> {
        validate_stats_query(query)?;
        let conn = self.lock_conn()?;
        let totals = query_stats_totals(&conn, query.from_unix, query.to_unix)?;
        let mut series = query_stats_series(
            &conn,
            "traffic_minute_buckets",
            60,
            query.from_unix,
            query.to_unix,
        )?;
        series.extend(query_stats_series(
            &conn,
            "traffic_hour_buckets",
            3600,
            query.from_unix,
            query.to_unix,
        )?);
        series.sort_by_key(|point| (point.bucket_start, point.resolution_seconds));
        let top_applications =
            query_top_applications(&conn, query.from_unix, query.to_unix, query.limit)?;
        let top_domains = if query.include_domains {
            query_top_domains(&conn, query.from_unix, query.to_unix, query.limit)?
        } else {
            Vec::new()
        };
        let egress_health = query_egress_health(&conn, query.from_unix, query.to_unix)?;
        Ok(StatsSnapshot {
            generated_at: unix_now(),
            from_unix: query.from_unix,
            to_unix: query.to_unix,
            totals,
            series,
            top_applications,
            top_domains,
            egress_health,
        })
    }

    pub fn clear_stats(&self) -> Result<u64, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin statistics clear: {error}"))?;
        let mut removed = 0u64;
        for table in [
            "traffic_minute_buckets",
            "traffic_hour_buckets",
            "optional_domain_day_buckets",
            "egress_health_minute_buckets",
        ] {
            removed = removed.saturating_add(
                tx.execute(&format!("DELETE FROM {table}"), [])
                    .map_err(|error| format!("clear {table}: {error}"))? as u64,
            );
        }
        tx.commit()
            .map_err(|error| format!("commit statistics clear: {error}"))?;
        Ok(removed)
    }

    /// Roll expired minute rows into hourly buckets and apply each profile's
    /// retention/privacy policy in one transaction.
    pub fn cleanup_stats(&self, now_unix: i64) -> Result<StatsCleanupReport, String> {
        if now_unix < 0 {
            return Err("statistics cleanup time cannot be negative".into());
        }
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin statistics cleanup: {error}"))?;
        let profiles = load_profiles(&tx)?;
        let mut report = StatsCleanupReport::default();
        for record in profiles {
            let id = record.profile.id;
            let privacy = record.profile.stats_privacy;
            if privacy.collection_mode != StatsCollectionMode::Persisted {
                report.deleted_rows = report
                    .deleted_rows
                    .saturating_add(delete_profile_stats(&tx, &id)?);
                continue;
            }
            let minute_cutoff = aligned_cutoff(now_unix, privacy.minute_retention_days, 60);
            let hourly_cutoff = aligned_cutoff(now_unix, privacy.hourly_retention_days, 3600);
            report.rolled_up_rows = report
                .rolled_up_rows
                .saturating_add(roll_up_profile_minutes(
                    &tx,
                    &id,
                    minute_cutoff,
                    hourly_cutoff,
                )?);
            report.deleted_rows = report.deleted_rows.saturating_add(
                tx.execute(
                    "DELETE FROM traffic_minute_buckets
                     WHERE profile_id = ?1 AND bucket_start < ?2",
                    params![&id, minute_cutoff],
                )
                .map_err(|error| format!("expire minute statistics: {error}"))?
                    as u64,
            );
            report.deleted_rows = report.deleted_rows.saturating_add(
                tx.execute(
                    "DELETE FROM traffic_hour_buckets
                     WHERE profile_id = ?1 AND bucket_start < ?2",
                    params![&id, hourly_cutoff],
                )
                .map_err(|error| format!("expire hourly statistics: {error}"))?
                    as u64,
            );
            report.deleted_rows = report.deleted_rows.saturating_add(
                tx.execute(
                    "DELETE FROM egress_health_minute_buckets
                     WHERE profile_id = ?1 AND bucket_start < ?2",
                    params![&id, minute_cutoff],
                )
                .map_err(|error| format!("expire egress health statistics: {error}"))?
                    as u64,
            );
            if privacy.domain_aggregation_enabled {
                let domain_cutoff = aligned_cutoff(now_unix, privacy.domain_retention_days, 86_400);
                report.deleted_rows = report.deleted_rows.saturating_add(
                    tx.execute(
                        "DELETE FROM optional_domain_day_buckets
                         WHERE profile_id = ?1 AND day_start < ?2",
                        params![&id, domain_cutoff],
                    )
                    .map_err(|error| format!("expire domain statistics: {error}"))?
                        as u64,
                );
            } else {
                report.deleted_rows = report.deleted_rows.saturating_add(
                    tx.execute(
                        "DELETE FROM optional_domain_day_buckets WHERE profile_id = ?1",
                        params![&id],
                    )
                    .map_err(|error| format!("remove disabled domain statistics: {error}"))?
                        as u64,
                );
            }
        }

        let orphan_minute_cutoff =
            aligned_cutoff(now_unix, DEFAULT_MINUTE_RETENTION_DAYS as u16, 60);
        let orphan_hourly_cutoff =
            aligned_cutoff(now_unix, DEFAULT_HOURLY_RETENTION_DAYS as u16, 3600);
        for (table, cutoff) in [
            ("traffic_minute_buckets", orphan_minute_cutoff),
            ("egress_health_minute_buckets", orphan_minute_cutoff),
            ("traffic_hour_buckets", orphan_hourly_cutoff),
            (
                "optional_domain_day_buckets",
                aligned_cutoff(now_unix, DEFAULT_MINUTE_RETENTION_DAYS as u16, 86_400),
            ),
        ] {
            report.deleted_rows = report.deleted_rows.saturating_add(
                tx.execute(
                    &format!(
                        "DELETE FROM {table}
                         WHERE profile_id NOT IN (SELECT id FROM routing_profiles)
                           AND {} < ?1",
                        if table == "optional_domain_day_buckets" {
                            "day_start"
                        } else {
                            "bucket_start"
                        }
                    ),
                    params![cutoff],
                )
                .map_err(|error| format!("expire orphaned {table}: {error}"))?
                    as u64,
            );
        }
        tx.commit()
            .map_err(|error| format!("commit statistics cleanup: {error}"))?;
        Ok(report)
    }

    fn transition_recovery(
        &self,
        generation: u64,
        allowed: &[RecoveryPhase],
        next: RecoveryPhase,
        artifact_state: Option<&Value>,
        error_code: Option<&str>,
    ) -> Result<RecoveryJournal, String> {
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("begin recovery state transition: {error}"))?;
        let current = load_recovery_journal(&tx)?;
        ensure_generation(&current, generation)?;
        if !allowed.contains(&current.phase) {
            return Err(format!(
                "RECOVERY_STATE_CONFLICT: cannot move from {:?} to {:?}",
                current.phase, next
            ));
        }
        let artifact_json = artifact_state
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("serialize recovery artifact: {error}"))?;
        let now = unix_now();
        tx.execute(
            "UPDATE engine_recovery_journal SET
               phase = ?1,
               artifact_state_json = COALESCE(?2, artifact_state_json),
               last_error_code = COALESCE(?3, last_error_code),
               updated_at = ?4
             WHERE singleton_id = 1 AND generation = ?5",
            params![
                enum_name(&next)?,
                artifact_json,
                error_code,
                now,
                to_sql_counter(generation, "recovery generation")?
            ],
        )
        .map_err(|error| format!("write recovery state transition: {error}"))?;
        let journal = load_recovery_journal(&tx)?;
        tx.commit()
            .map_err(|error| format!("commit recovery state transition: {error}"))?;
        Ok(journal)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRoutingProfile {
    pub profile: RoutingProfileDraft,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigSnapshotState {
    Prepared,
    Committed,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingConfigSnapshot {
    pub revision: u64,
    pub state: ConfigSnapshotState,
    pub profiles: Vec<RoutingProfileDraft>,
    pub created_at: i64,
    pub committed_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSourceDraft {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub kind: RuleSourceKind,
    pub url: Option<String>,
    pub refresh_interval_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedRuleSource {
    pub source: RuleSourceDraft,
    pub revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryPhase {
    Clean,
    Preparing,
    CaptureInstalled,
    Active,
    Stopping,
    RecoveryRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournal {
    pub generation: u64,
    pub phase: RecoveryPhase,
    pub cleanup_required: bool,
    pub restore_after_recovery: bool,
    pub config_revision: u64,
    pub platform: CapturePlatform,
    pub active_profile_ids: Vec<String>,
    pub artifact_state: Value,
    pub helper_pid: Option<u32>,
    pub last_heartbeat_at: Option<i64>,
    pub last_error_code: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LifecyclePreferences {
    pub restore_on_system_login: bool,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficMinuteDelta {
    pub bucket_start: i64,
    pub profile_id: String,
    pub app_identity: Option<String>,
    pub protocol: String,
    pub hostname_source: HostnameSource,
    pub policy_action: RouteAction,
    pub effective_action: RouteAction,
    pub outcome: FlowOutcomeKind,
    pub connector: Option<String>,
    pub error_code: Option<String>,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub connections: u64,
    pub errors: u64,
    pub connect_millis_total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainDayDelta {
    pub day_start: i64,
    pub profile_id: String,
    pub domain: String,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub connections: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressHealthMinuteDelta {
    pub bucket_start: i64,
    pub profile_id: String,
    pub egress_kind: String,
    pub control_state: String,
    pub active_controls_max: u64,
    pub active_channels_max: u64,
    pub channel_errors: u64,
    pub reconnects: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub handshake_millis_total: u64,
    pub handshake_samples: u64,
    pub host_key_state: Option<String>,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshotQuery {
    pub from_unix: i64,
    pub to_unix: i64,
    pub include_domains: bool,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatsTotals {
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub connections: u64,
    pub errors: u64,
    pub direct_connections: u64,
    pub proxy_connections: u64,
    pub blocked_connections: u64,
    pub unknown_hostname_connections: u64,
    pub connect_millis_total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSeriesPoint {
    pub bucket_start: i64,
    pub resolution_seconds: u16,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub connections: u64,
    pub errors: u64,
    pub direct_connections: u64,
    pub proxy_connections: u64,
    pub blocked_connections: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsTopEntry {
    pub key: String,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub connections: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EgressHealthPoint {
    pub bucket_start: i64,
    pub profile_id: String,
    pub egress_kind: String,
    pub control_state: String,
    pub active_controls_max: u64,
    pub active_channels_max: u64,
    pub channel_errors: u64,
    pub reconnects: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub handshake_millis_total: u64,
    pub handshake_samples: u64,
    pub host_key_state: Option<String>,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub generated_at: i64,
    pub from_unix: i64,
    pub to_unix: i64,
    pub totals: StatsTotals,
    pub series: Vec<StatsSeriesPoint>,
    pub top_applications: Vec<StatsTopEntry>,
    pub top_domains: Vec<StatsTopEntry>,
    pub egress_health: Vec<EgressHealthPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatsCleanupReport {
    pub rolled_up_rows: u64,
    pub deleted_rows: u64,
}

fn validate_traffic_delta(delta: &TrafficMinuteDelta) -> Result<(), String> {
    if delta.bucket_start < 0 || delta.bucket_start % 60 != 0 {
        return Err("traffic statistics bucketStart must align to UTC minute".into());
    }
    validate_safe_id("traffic statistics profile id", &delta.profile_id)?;
    validate_metric_label("protocol", &delta.protocol, 32, false)?;
    if let Some(identity) = &delta.app_identity {
        if identity.len() > 4096 || identity.contains('\0') {
            return Err("application identity is too long or contains NUL".into());
        }
    }
    if let Some(connector) = &delta.connector {
        validate_metric_label("connector", connector, 64, false)?;
    }
    if let Some(code) = &delta.error_code {
        validate_metric_label("error code", code, 128, true)?;
    }
    for (value, label) in [
        (delta.bytes_up, "bytesUp"),
        (delta.bytes_down, "bytesDown"),
        (delta.connections, "connections"),
        (delta.errors, "errors"),
        (delta.connect_millis_total, "connectMillisTotal"),
    ] {
        to_sql_counter(value, label)?;
    }
    Ok(())
}

fn validate_egress_health_delta(delta: &EgressHealthMinuteDelta) -> Result<(), String> {
    if delta.bucket_start < 0 || delta.bucket_start % 60 != 0 {
        return Err("egress health bucketStart must align to UTC minute".into());
    }
    validate_safe_id("egress health profile id", &delta.profile_id)?;
    validate_metric_label("egress kind", &delta.egress_kind, 64, false)?;
    validate_metric_label("control state", &delta.control_state, 64, false)?;
    if let Some(state) = &delta.host_key_state {
        validate_metric_label("host-key state", state, 64, false)?;
    }
    if let Some(code) = &delta.last_error_code {
        validate_metric_label("egress error code", code, 128, true)?;
    }
    for (value, label) in [
        (delta.active_controls_max, "activeControlsMax"),
        (delta.active_channels_max, "activeChannelsMax"),
        (delta.channel_errors, "channelErrors"),
        (delta.reconnects, "reconnects"),
        (delta.bytes_up, "bytesUp"),
        (delta.bytes_down, "bytesDown"),
        (delta.handshake_millis_total, "handshakeMillisTotal"),
        (delta.handshake_samples, "handshakeSamples"),
    ] {
        to_sql_counter(value, label)?;
    }
    Ok(())
}

fn validate_metric_label(
    label: &str,
    value: &str,
    max_len: usize,
    uppercase_only: bool,
) -> Result<(), String> {
    if value.is_empty() || value.len() > max_len {
        return Err(format!("{label} must be 1-{max_len} ASCII characters"));
    }
    let valid = value.bytes().all(|byte| {
        let alpha = if uppercase_only {
            byte.is_ascii_uppercase()
        } else {
            byte.is_ascii_alphabetic()
        };
        alpha || byte.is_ascii_digit() || matches!(byte, b'_' | b'-' | b'.')
    });
    if !valid {
        return Err(format!("{label} contains unsupported characters"));
    }
    Ok(())
}

fn profile_stats_privacy(
    conn: &Connection,
    profile_id: &str,
) -> Result<super::types::StatsPrivacy, String> {
    load_profile(conn, profile_id)?
        .map(|record| record.profile.stats_privacy)
        .ok_or_else(|| {
            format!("PROFILE_NOT_FOUND: statistics reference unknown profile '{profile_id}'")
        })
}

fn profile_collection_mode(
    conn: &Connection,
    profile_id: &str,
) -> Result<StatsCollectionMode, String> {
    Ok(profile_stats_privacy(conn, profile_id)?.collection_mode)
}

fn normalize_stats_domain(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('.');
    if trimmed.is_empty()
        || trimmed.len() > 1024
        || trimmed.contains(['/', '\\', ':', '@', '\0'])
        || trimmed.chars().any(char::is_whitespace)
    {
        return Err("domain aggregate requires a hostname without URL/path/credentials".into());
    }
    let parsed = url::Url::parse(&format!("https://{trimmed}/"))
        .map_err(|_| "domain aggregate contains an invalid IDNA hostname".to_string())?;
    let ascii = parsed
        .host_str()
        .ok_or_else(|| "domain aggregate contains no hostname".to_string())?
        .to_ascii_lowercase();
    if ascii.len() > 253
        || ascii
            .split('.')
            .any(|label| label.is_empty() || label.len() > 63)
    {
        return Err("domain aggregate hostname is outside DNS length bounds".into());
    }
    Ok(ascii)
}

fn to_sql_counter(value: u64, label: &str) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| format!("{label} exceeds SQLite signed integer range"))
}

fn validate_stats_query(query: &StatsSnapshotQuery) -> Result<(), String> {
    if query.from_unix < 0 || query.to_unix <= query.from_unix {
        return Err("statistics query requires 0 <= fromUnix < toUnix".into());
    }
    if query.to_unix - query.from_unix > 366 * 86_400 {
        return Err("statistics query range cannot exceed 366 days".into());
    }
    if query.limit == 0 || query.limit > 100 {
        return Err("statistics top-entry limit must be 1-100".into());
    }
    Ok(())
}

fn query_stats_totals(conn: &Connection, from: i64, to: i64) -> Result<StatsTotals, String> {
    conn.query_row(
        "WITH buckets AS (
           SELECT * FROM traffic_minute_buckets WHERE bucket_start >= ?1 AND bucket_start < ?2
           UNION ALL
           SELECT * FROM traffic_hour_buckets WHERE bucket_start >= ?1 AND bucket_start < ?2
         )
         SELECT COALESCE(SUM(bytes_up), 0), COALESCE(SUM(bytes_down), 0),
                COALESCE(SUM(connections), 0), COALESCE(SUM(errors), 0),
                COALESCE(SUM(CASE WHEN effective_action = 'direct' THEN connections ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN effective_action = 'proxy' THEN connections ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN effective_action = 'block' OR outcome = 'blocked' THEN connections ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN hostname_source IN ('unknown', 'ip_only') THEN connections ELSE 0 END), 0),
                COALESCE(SUM(connect_millis_total), 0)
         FROM buckets",
        params![from, to],
        |row| {
            Ok(StatsTotals {
                bytes_up: sql_counter(row, 0)?,
                bytes_down: sql_counter(row, 1)?,
                connections: sql_counter(row, 2)?,
                errors: sql_counter(row, 3)?,
                direct_connections: sql_counter(row, 4)?,
                proxy_connections: sql_counter(row, 5)?,
                blocked_connections: sql_counter(row, 6)?,
                unknown_hostname_connections: sql_counter(row, 7)?,
                connect_millis_total: sql_counter(row, 8)?,
            })
        },
    )
    .map_err(|error| format!("query statistics totals: {error}"))
}

fn query_stats_series(
    conn: &Connection,
    table: &str,
    resolution_seconds: u16,
    from: i64,
    to: i64,
) -> Result<Vec<StatsSeriesPoint>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT bucket_start, SUM(bytes_up), SUM(bytes_down), SUM(connections), SUM(errors),
                    SUM(CASE WHEN effective_action = 'direct' THEN connections ELSE 0 END),
                    SUM(CASE WHEN effective_action = 'proxy' THEN connections ELSE 0 END),
                    SUM(CASE WHEN effective_action = 'block' OR outcome = 'blocked' THEN connections ELSE 0 END)
             FROM {table}
             WHERE bucket_start >= ?1 AND bucket_start < ?2
             GROUP BY bucket_start ORDER BY bucket_start"
        ))
        .map_err(|error| format!("prepare statistics series: {error}"))?;
    statement
        .query_map(params![from, to], |row| {
            Ok(StatsSeriesPoint {
                bucket_start: row.get(0)?,
                resolution_seconds,
                bytes_up: sql_counter(row, 1)?,
                bytes_down: sql_counter(row, 2)?,
                connections: sql_counter(row, 3)?,
                errors: sql_counter(row, 4)?,
                direct_connections: sql_counter(row, 5)?,
                proxy_connections: sql_counter(row, 6)?,
                blocked_connections: sql_counter(row, 7)?,
            })
        })
        .map_err(|error| format!("query statistics series: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read statistics series: {error}"))
}

fn query_top_applications(
    conn: &Connection,
    from: i64,
    to: i64,
    limit: u16,
) -> Result<Vec<StatsTopEntry>, String> {
    let mut statement = conn
        .prepare(
            "WITH buckets AS (
               SELECT app_identity, bytes_up, bytes_down, connections
               FROM traffic_minute_buckets WHERE bucket_start >= ?1 AND bucket_start < ?2
               UNION ALL
               SELECT app_identity, bytes_up, bytes_down, connections
               FROM traffic_hour_buckets WHERE bucket_start >= ?1 AND bucket_start < ?2
             )
             SELECT app_identity, SUM(bytes_up), SUM(bytes_down), SUM(connections)
             FROM buckets WHERE app_identity != ''
             GROUP BY app_identity
             ORDER BY SUM(bytes_up + bytes_down) DESC, app_identity
             LIMIT ?3",
        )
        .map_err(|error| format!("prepare top applications: {error}"))?;
    statement
        .query_map(params![from, to, limit], row_to_top_entry)
        .map_err(|error| format!("query top applications: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read top applications: {error}"))
}

fn query_top_domains(
    conn: &Connection,
    from: i64,
    to: i64,
    limit: u16,
) -> Result<Vec<StatsTopEntry>, String> {
    let mut statement = conn
        .prepare(
            "SELECT domain, SUM(bytes_up), SUM(bytes_down), SUM(connections)
             FROM optional_domain_day_buckets
             WHERE day_start >= (?1 / 86400) * 86400
               AND day_start < ((?2 + 86399) / 86400) * 86400
             GROUP BY domain
             ORDER BY SUM(bytes_up + bytes_down) DESC, domain
             LIMIT ?3",
        )
        .map_err(|error| format!("prepare top domains: {error}"))?;
    statement
        .query_map(params![from, to, limit], row_to_top_entry)
        .map_err(|error| format!("query top domains: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read top domains: {error}"))
}

fn row_to_top_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<StatsTopEntry> {
    Ok(StatsTopEntry {
        key: row.get(0)?,
        bytes_up: sql_counter(row, 1)?,
        bytes_down: sql_counter(row, 2)?,
        connections: sql_counter(row, 3)?,
    })
}

fn query_egress_health(
    conn: &Connection,
    from: i64,
    to: i64,
) -> Result<Vec<EgressHealthPoint>, String> {
    let mut statement = conn
        .prepare(
            "SELECT bucket_start, profile_id, egress_kind, control_state,
                    active_controls_max, active_channels_max, channel_errors,
                    reconnects, bytes_up, bytes_down, handshake_millis_total,
                    handshake_samples, NULLIF(host_key_state, ''),
                    NULLIF(last_error_code, '')
             FROM egress_health_minute_buckets
             WHERE bucket_start >= ?1 AND bucket_start < ?2
             ORDER BY bucket_start, profile_id",
        )
        .map_err(|error| format!("prepare egress health snapshot: {error}"))?;
    statement
        .query_map(params![from, to], |row| {
            Ok(EgressHealthPoint {
                bucket_start: row.get(0)?,
                profile_id: row.get(1)?,
                egress_kind: row.get(2)?,
                control_state: row.get(3)?,
                active_controls_max: sql_counter(row, 4)?,
                active_channels_max: sql_counter(row, 5)?,
                channel_errors: sql_counter(row, 6)?,
                reconnects: sql_counter(row, 7)?,
                bytes_up: sql_counter(row, 8)?,
                bytes_down: sql_counter(row, 9)?,
                handshake_millis_total: sql_counter(row, 10)?,
                handshake_samples: sql_counter(row, 11)?,
                host_key_state: row.get(12)?,
                last_error_code: row.get(13)?,
            })
        })
        .map_err(|error| format!("query egress health snapshot: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read egress health snapshot: {error}"))
}

fn sql_counter(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })
}

fn aligned_cutoff(now_unix: i64, retention_days: u16, resolution: i64) -> i64 {
    let cutoff = now_unix.saturating_sub(i64::from(retention_days) * 86_400);
    cutoff - cutoff.rem_euclid(resolution)
}

fn roll_up_profile_minutes(
    tx: &Transaction<'_>,
    profile_id: &str,
    minute_cutoff: i64,
    hourly_cutoff: i64,
) -> Result<u64, String> {
    tx.execute(
        "INSERT INTO traffic_hour_buckets
         (bucket_start, profile_id, app_identity, protocol, hostname_source,
          policy_action, effective_action, outcome, connector, error_code,
          bytes_up, bytes_down, connections, errors, connect_millis_total)
         SELECT (bucket_start / 3600) * 3600, profile_id, app_identity,
                protocol, hostname_source, policy_action, effective_action,
                outcome, connector, error_code, SUM(bytes_up), SUM(bytes_down),
                SUM(connections), SUM(errors), SUM(connect_millis_total)
         FROM traffic_minute_buckets
         WHERE profile_id = ?1 AND bucket_start < ?2 AND bucket_start >= ?3
         GROUP BY (bucket_start / 3600) * 3600, profile_id, app_identity,
                  protocol, hostname_source, policy_action, effective_action,
                  outcome, connector, error_code
         ON CONFLICT(
           bucket_start, profile_id, app_identity, protocol, hostname_source,
           policy_action, effective_action, outcome, connector, error_code
         ) DO UPDATE SET
           bytes_up = bytes_up + excluded.bytes_up,
           bytes_down = bytes_down + excluded.bytes_down,
           connections = connections + excluded.connections,
           errors = errors + excluded.errors,
           connect_millis_total = connect_millis_total + excluded.connect_millis_total",
        params![profile_id, minute_cutoff, hourly_cutoff],
    )
    .map(|rows| rows as u64)
    .map_err(|error| format!("roll up minute statistics: {error}"))
}

fn delete_profile_stats(tx: &Transaction<'_>, profile_id: &str) -> Result<u64, String> {
    let mut removed = 0u64;
    for table in [
        "traffic_minute_buckets",
        "traffic_hour_buckets",
        "optional_domain_day_buckets",
        "egress_health_minute_buckets",
    ] {
        removed = removed.saturating_add(
            tx.execute(
                &format!("DELETE FROM {table} WHERE profile_id = ?1"),
                params![profile_id],
            )
            .map_err(|error| format!("delete {table} for profile: {error}"))? as u64,
        );
    }
    Ok(removed)
}

#[cfg(unix)]
fn open_app_data_dir_guard(path: &Path) -> Result<Option<File>, String> {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW);
    options.open(path).map(Some).map_err(|error| {
        format!(
            "open Sockscap app data directory {}: {error}",
            path.display()
        )
    })
}

#[cfg(windows)]
fn open_app_data_dir_guard(path: &Path) -> Result<Option<File>, String> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let mut options = OpenOptions::new();
    options
        .read(true)
        // Deliberately omit FILE_SHARE_DELETE so the canonical directory
        // cannot be renamed or deleted while this process owns the store.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path).map(Some).map_err(|error| {
        format!(
            "open Sockscap app data directory {}: {error}",
            path.display()
        )
    })
}

#[cfg(not(any(unix, windows)))]
fn open_app_data_dir_guard(path: &Path) -> Result<Option<File>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "inspect Sockscap app data directory {}: {error}",
            path.display()
        )
    })?;
    if !metadata.file_type().is_dir() {
        return Err(format!(
            "Sockscap app data path {} is not a directory",
            path.display()
        ));
    }
    Ok(None)
}

#[cfg(unix)]
fn validate_app_data_dir_binding(guard: Option<&File>, path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let guard = guard.ok_or_else(|| "Sockscap app data directory guard is missing".to_string())?;
    let mut opened = guard.metadata().map_err(|error| {
        format!(
            "inspect open Sockscap app data directory {}: {error}",
            path.display()
        )
    })?;
    let current = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "reinspect Sockscap app data directory {}: {error}",
            path.display()
        )
    })?;
    if !opened.file_type().is_dir()
        || !current.file_type().is_dir()
        || opened.dev() != current.dev()
        || opened.ino() != current.ino()
    {
        return Err(format!(
            "Sockscap app data directory {} changed identity during store open",
            path.display()
        ));
    }

    let effective_uid = unsafe { libc::geteuid() };
    if opened.uid() != effective_uid {
        return Err(format!(
            "Sockscap app data directory {} is not owned by the current user",
            path.display()
        ));
    }
    if opened.mode() & 0o077 != 0 {
        guard
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|error| {
                format!(
                    "harden Sockscap app data directory {} permissions: {error}",
                    path.display()
                )
            })?;
        opened = guard.metadata().map_err(|error| {
            format!(
                "reinspect hardened Sockscap app data directory {}: {error}",
                path.display()
            )
        })?;
        if opened.uid() != effective_uid || opened.mode() & 0o077 != 0 {
            return Err(format!(
                "Sockscap app data directory {} permissions could not be hardened to 0700",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn validate_app_data_dir_binding(guard: Option<&File>, path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let guard = guard.ok_or_else(|| "Sockscap app data directory guard is missing".to_string())?;
    let opened = guard.metadata().map_err(|error| {
        format!(
            "inspect open Sockscap app data directory {}: {error}",
            path.display()
        )
    })?;
    let current = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "reinspect Sockscap app data directory {}: {error}",
            path.display()
        )
    })?;
    let current_guard = open_app_data_dir_guard(path)?
        .ok_or_else(|| "Sockscap app data directory guard is missing".to_string())?;
    if !opened.file_type().is_dir()
        || !current.file_type().is_dir()
        || opened.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || current.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || windows_file_identity(guard, path)? != windows_file_identity(&current_guard, path)?
    {
        return Err(format!(
            "Sockscap app data directory {} is a reparse point or changed identity during store open",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn validate_app_data_dir_binding(_guard: Option<&File>, path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "inspect Sockscap app data directory {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        Err(format!(
            "Sockscap app data path {} is not a directory",
            path.display()
        ))
    }
}

fn acquire_owner_lock(app_data_dir: &Path) -> Result<File, String> {
    let path = app_data_dir.join(SOCKSCAP_OWNER_LOCK_FILE);
    let (file, created) = open_owner_lock_file(&path)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect Sockscap owner lock {}: {error}", path.display()))?;
    if !metadata.file_type().is_file() {
        return Err(format!(
            "Sockscap owner lock {} is not a regular file",
            path.display()
        ));
    }

    #[cfg(unix)]
    harden_and_validate_unix_owner_lock(&file, &path, &metadata, created)?;

    #[cfg(not(unix))]
    let _ = created;

    validate_owner_lock_binding(&file, &path)?;

    file.try_lock_exclusive().map_err(|error| {
        let contended = fs2::lock_contended_error();
        if error.kind() == std::io::ErrorKind::WouldBlock
            || error.raw_os_error() == contended.raw_os_error()
        {
            format!(
                "{SOCKSCAP_STORE_ALREADY_OPEN}: another process owns {}",
                path.display()
            )
        } else {
            format!("acquire Sockscap owner lock {}: {error}", path.display())
        }
    })?;
    validate_owner_lock_binding(&file, &path)?;
    Ok(file)
}

#[cfg(unix)]
fn owner_lock_open_options() -> OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    options
}

#[cfg(windows)]
fn owner_lock_open_options() -> OpenOptions {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        // A contender may open and lock the file, but it cannot replace the
        // path while the current owner handle is alive.
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options
}

#[cfg(not(any(unix, windows)))]
fn owner_lock_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    options
}

fn open_owner_lock_file(path: &Path) -> Result<(File, bool), String> {
    let mut create_options = owner_lock_open_options();
    match create_options.create_new(true).open(path) {
        Ok(file) => Ok((file, true)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            owner_lock_open_options()
                .open(path)
                .map(|file| (file, false))
                .map_err(|error| {
                    format!(
                        "open existing Sockscap owner lock {}: {error}",
                        path.display()
                    )
                })
        }
        Err(error) => Err(format!(
            "create Sockscap owner lock {}: {error}",
            path.display()
        )),
    }
}

#[cfg(unix)]
fn harden_and_validate_unix_owner_lock(
    file: &File,
    path: &Path,
    initial: &std::fs::Metadata,
    created: bool,
) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let effective_uid = unsafe { libc::geteuid() };
    if initial.nlink() != 1 {
        return Err(format!(
            "Sockscap owner lock {} must have exactly one hard link",
            path.display()
        ));
    }
    if initial.uid() != effective_uid {
        return Err(format!(
            "Sockscap owner lock {} is not owned by the current user",
            path.display()
        ));
    }
    if created {
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|error| {
                format!(
                    "set Sockscap owner lock {} permissions: {error}",
                    path.display()
                )
            })?;
    }

    let metadata = file
        .metadata()
        .map_err(|error| format!("reinspect Sockscap owner lock {}: {error}", path.display()))?;
    if !metadata.file_type().is_file() || metadata.nlink() != 1 || metadata.uid() != effective_uid {
        return Err(format!(
            "Sockscap owner lock {} changed identity during validation",
            path.display()
        ));
    }
    if metadata.mode() & 0o7777 != 0o600 {
        return Err(format!(
            "Sockscap owner lock {} permissions must be 0600",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_owner_lock_binding(file: &File, path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;

    let opened = file
        .metadata()
        .map_err(|error| format!("inspect Sockscap owner lock {}: {error}", path.display()))?;
    let current = std::fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect Sockscap owner lock {}: {error}", path.display()))?;
    if !current.file_type().is_file()
        || opened.dev() != current.dev()
        || opened.ino() != current.ino()
        || opened.nlink() != 1
        || current.nlink() != 1
    {
        return Err(format!(
            "Sockscap owner lock {} changed identity during store open",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn validate_owner_lock_binding(file: &File, path: &Path) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    let opened = file
        .metadata()
        .map_err(|error| format!("inspect Sockscap owner lock {}: {error}", path.display()))?;
    let current = std::fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect Sockscap owner lock {}: {error}", path.display()))?;
    let current_file = owner_lock_open_options()
        .open(path)
        .map_err(|error| format!("reopen Sockscap owner lock {}: {error}", path.display()))?;
    if !opened.file_type().is_file()
        || !current.file_type().is_file()
        || opened.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || current.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || windows_file_identity(file, path)? != windows_file_identity(&current_file, path)?
    {
        return Err(format!(
            "Sockscap owner lock {} is a reparse point or changed identity during store open",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct WindowsFileIdentity {
    volume_serial_number: u32,
    file_index: u64,
}

#[cfg(windows)]
fn windows_file_identity(file: &File, path: &Path) -> Result<WindowsFileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    use winapi::um::fileapi::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};

    let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let succeeded = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
    if succeeded == 0 {
        return Err(format!(
            "read Windows file identity for {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(WindowsFileIdentity {
        volume_serial_number: information.dwVolumeSerialNumber,
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
    })
}

#[cfg(not(any(unix, windows)))]
fn validate_owner_lock_binding(file: &File, path: &Path) -> Result<(), String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect Sockscap owner lock {}: {error}", path.display()))?;
    if metadata.file_type().is_file() {
        Ok(())
    } else {
        Err(format!(
            "Sockscap owner lock {} is not a regular file",
            path.display()
        ))
    }
}

fn validate_database_path(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "inspect Sockscap database path {}: {error}",
                path.display()
            ));
        }
    };
    if !metadata.file_type().is_file() {
        return Err(format!(
            "Sockscap database path {} is not a regular file",
            path.display()
        ));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(format!(
                "Sockscap database {} is not owned by the current user",
                path.display()
            ));
        }
        if metadata.nlink() != 1 {
            return Err(format!(
                "Sockscap database {} must have exactly one hard link",
                path.display()
            ));
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!(
                "Sockscap database {} must not be a reparse point",
                path.display()
            ));
        }
    }
    Ok(())
}

fn configure_connection(conn: &Connection, disk: bool) -> Result<(), String> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("configure Sockscap busy timeout: {error}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("enable Sockscap foreign keys: {error}"))?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("read Sockscap schema version: {error}"))?;
    if version > SOCKSCAP_SCHEMA_VERSION {
        return Err(format!(
            "sockscap.db schema {version} is newer than supported version {SOCKSCAP_SCHEMA_VERSION}"
        ));
    }
    if disk {
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .map_err(|error| format!("enable Sockscap WAL: {error}"))?;
        if !mode.eq_ignore_ascii_case("wal") {
            return Err(format!("Sockscap database refused WAL mode: {mode}"));
        }
    }
    conn.pragma_update(None, "synchronous", if disk { "FULL" } else { "NORMAL" })
        .map_err(|error| format!("configure Sockscap synchronous mode: {error}"))?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("read Sockscap schema version: {error}"))?;
    if version > SOCKSCAP_SCHEMA_VERSION {
        return Err(format!(
            "sockscap.db schema {version} is newer than supported version {SOCKSCAP_SCHEMA_VERSION}"
        ));
    }
    if version == 0 {
        conn.execute_batch(SCHEMA_V1)
            .map_err(|error| format!("create Sockscap schema v1: {error}"))?;
        conn.pragma_update(None, "user_version", SOCKSCAP_SCHEMA_VERSION)
            .map_err(|error| format!("set Sockscap schema version: {error}"))?;
    }
    seed_builtin_rule_source(conn)?;
    seed_recovery_journal(conn)?;
    Ok(())
}

fn harden_database_file(path: &Path) -> Result<(), String> {
    validate_database_path(path)?;
    #[cfg(unix)]
    {
        harden_unix_sqlite_file(path)?;
    }
    for suffix in ["-wal", "-shm"] {
        let sidecar = sqlite_sidecar_path(path, suffix);
        match std::fs::symlink_metadata(&sidecar) {
            Ok(_) => {
                validate_database_path(&sidecar)?;
                #[cfg(unix)]
                harden_unix_sqlite_file(&sidecar)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "inspect Sockscap SQLite sidecar {}: {error}",
                    sidecar.display()
                ));
            }
        }
    }
    Ok(())
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut sidecar = path.as_os_str().to_os_string();
    sidecar.push(suffix);
    PathBuf::from(sidecar)
}

#[cfg(unix)]
fn harden_unix_sqlite_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("harden {} permissions: {error}", path.display()))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect hardened {}: {error}", path.display()))?;
    if !metadata.file_type().is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(format!(
            "Sockscap SQLite file {} failed owner, link, or 0600 validation",
            path.display()
        ));
    }
    Ok(())
}

fn seed_builtin_rule_source(conn: &Connection) -> Result<(), String> {
    let now = unix_now();
    let source = RuleSourceDraft {
        id: GFWLIST_OFFICIAL_SOURCE_ID.into(),
        name: "GFWList (official)".into(),
        enabled: true,
        kind: RuleSourceKind::GfwlistOfficial,
        url: None,
        refresh_interval_seconds: 6 * 60 * 60,
    };
    let draft_json = serde_json::to_string(&source)
        .map_err(|error| format!("serialize built-in rule source: {error}"))?;
    conn.execute(
        "INSERT OR IGNORE INTO rule_sources
         (id, name, enabled, kind, source_url, refresh_interval_seconds,
          draft_json, revision, created_at, updated_at)
         VALUES (?1, ?2, 1, 'gfwlist_official', NULL, ?3, ?4, 1, ?5, ?5)",
        params![
            GFWLIST_OFFICIAL_SOURCE_ID,
            source.name,
            to_sql_counter(
                source.refresh_interval_seconds,
                "built-in rule source refresh interval",
            )?,
            draft_json,
            now,
        ],
    )
    .map_err(|error| format!("seed built-in rule source: {error}"))?;
    Ok(())
}

fn seed_recovery_journal(conn: &Connection) -> Result<(), String> {
    let now = unix_now();
    conn.execute(
        "INSERT OR IGNORE INTO engine_recovery_journal
         (singleton_id, generation, phase, cleanup_required,
          restore_after_recovery, config_revision, platform,
          active_profile_ids_json, artifact_state_json, created_at, updated_at)
         VALUES (1, 0, 'clean', 0, 0, 0, ?1, '[]', '{}', ?2, ?2)",
        params![enum_name(&CapturePlatform::current())?, now],
    )
    .map_err(|error| format!("seed recovery journal: {error}"))?;
    Ok(())
}

fn load_profiles(conn: &Connection) -> Result<Vec<PersistedRoutingProfile>, String> {
    let mut statement = conn
        .prepare(
            "SELECT draft_json, revision, created_at, updated_at
             FROM routing_profiles ORDER BY priority, name COLLATE NOCASE, id",
        )
        .map_err(|error| format!("prepare routing profile list: {error}"))?;
    statement
        .query_map([], row_to_profile)
        .map_err(|error| format!("query routing profiles: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read routing profiles: {error}"))
}

fn load_profile(conn: &Connection, id: &str) -> Result<Option<PersistedRoutingProfile>, String> {
    conn.query_row(
        "SELECT draft_json, revision, created_at, updated_at
         FROM routing_profiles WHERE id = ?1",
        params![id],
        row_to_profile,
    )
    .optional()
    .map_err(|error| format!("read routing profile '{id}': {error}"))
}

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersistedRoutingProfile> {
    let draft_json: String = row.get(0)?;
    let profile = serde_json::from_str(&draft_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PersistedRoutingProfile {
        profile,
        revision: sql_counter(row, 1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn load_config_snapshot(
    conn: &Connection,
    revision: u64,
) -> Result<Option<RoutingConfigSnapshot>, String> {
    conn.query_row(
        "SELECT revision, state, profiles_json, created_at, committed_at
         FROM engine_config_snapshots WHERE revision = ?1",
        params![to_sql_counter(revision, "config snapshot revision")?],
        row_to_config_snapshot,
    )
    .optional()
    .map_err(|error| format!("read config snapshot {revision}: {error}"))
}

fn row_to_config_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoutingConfigSnapshot> {
    let state: String = row.get(1)?;
    let profiles_json: String = row.get(2)?;
    let state = parse_enum(&state, "config snapshot state").map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
        )
    })?;
    let profiles = serde_json::from_str(&profiles_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(RoutingConfigSnapshot {
        revision: sql_counter(row, 0)?,
        state,
        profiles,
        created_at: row.get(3)?,
        committed_at: row.get(4)?,
    })
}

fn load_rule_source(conn: &Connection, id: &str) -> Result<Option<PersistedRuleSource>, String> {
    conn.query_row(
        "SELECT draft_json, revision, created_at, updated_at
         FROM rule_sources WHERE id = ?1",
        params![id],
        row_to_rule_source,
    )
    .optional()
    .map_err(|error| format!("read rule source '{id}': {error}"))
}

fn row_to_rule_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersistedRuleSource> {
    let draft_json: String = row.get(0)?;
    let source = serde_json::from_str(&draft_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PersistedRuleSource {
        source,
        revision: sql_counter(row, 1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn replace_profile_children(
    tx: &Transaction<'_>,
    profile: &RoutingProfileDraft,
) -> Result<(), String> {
    for table in [
        "app_selectors",
        "runtime_process_selectors",
        "profile_rule_sources",
        "custom_rules",
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE profile_id = ?1"),
            params![&profile.id],
        )
        .map_err(|error| format!("clear {table}: {error}"))?;
    }

    for (position, selector) in profile.app_selectors.iter().enumerate() {
        tx.execute(
            "INSERT INTO app_selectors (profile_id, position, kind, value)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &profile.id,
                position as i64,
                enum_name(&selector.kind)?,
                &selector.value,
            ],
        )
        .map_err(|error| format!("write app selector: {error}"))?;
    }
    for (position, selector) in profile.runtime_processes.iter().enumerate() {
        tx.execute(
            "INSERT INTO runtime_process_selectors
             (profile_id, position, pid, process_start_time)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &profile.id,
                position as i64,
                i64::from(selector.pid),
                to_sql_counter(selector.process_start_time, "process start time")?,
            ],
        )
        .map_err(|error| format!("write runtime process selector: {error}"))?;
    }
    for (position, source_id) in profile.rule_source_ids.iter().enumerate() {
        tx.execute(
            "INSERT INTO profile_rule_sources (profile_id, source_id, position)
             VALUES (?1, ?2, ?3)",
            params![&profile.id, source_id, position as i64],
        )
        .map_err(|error| format!("write profile rule source: {error}"))?;
    }
    for (position, rule) in profile.custom_rules.iter().enumerate() {
        tx.execute(
            "INSERT INTO custom_rules
             (profile_id, rule_id, position, enabled, action, kind, pattern)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                &profile.id,
                &rule.id,
                position as i64,
                rule.enabled,
                enum_name(&rule.action)?,
                enum_name(&rule.kind)?,
                &rule.pattern,
            ],
        )
        .map_err(|error| format!("write custom rule: {error}"))?;
    }
    Ok(())
}

fn ensure_rule_sources_exist(tx: &Transaction<'_>, source_ids: &[String]) -> Result<(), String> {
    for id in source_ids {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM rule_sources WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| format!("check rule source '{id}': {error}"))?;
        if !exists {
            return Err(format!(
                "RULE_SOURCE_NOT_FOUND: routing profile references unknown source '{id}'"
            ));
        }
    }
    Ok(())
}

fn validate_persisted_profile(profile: &RoutingProfileDraft) -> Result<(), String> {
    let issues = validate_profile_draft(profile);
    if !issues.is_empty() {
        return Err(format!(
            "INVALID_PROFILE: {}",
            issues
                .into_iter()
                .map(|issue| format!("{}: {}", issue.field, issue.message))
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    if profile.app_selectors.len() > 1024
        || profile.runtime_processes.len() > 4096
        || profile.rule_source_ids.len() > 256
        || profile.custom_rules.len() > 10_000
    {
        return Err("INVALID_PROFILE: selector, source, or custom-rule limit exceeded".into());
    }
    if profile.name != profile.name.trim() {
        return Err("INVALID_PROFILE: profile name cannot have leading/trailing whitespace".into());
    }
    for selector in &profile.app_selectors {
        if selector.value.contains('\0') {
            return Err("INVALID_PROFILE: application selector contains NUL".into());
        }
    }
    match (&profile.egress_kind, &profile.egress_ref_id) {
        (Some(_), Some(id)) => validate_safe_id("egress session id", id)?,
        (Some(_), None) | (None, Some(_)) => {
            return Err(
                "INVALID_PROFILE: egressKind and egressRefId must be supplied together".into(),
            );
        }
        (None, None) => {}
    }
    let invalid_rules = compile_custom_rules(&profile.id, &profile.custom_rules).unsupported;
    if !invalid_rules.is_empty() {
        return Err(format!(
            "INVALID_PROFILE: {} custom rule(s) failed compilation",
            invalid_rules.len()
        ));
    }
    let privacy = &profile.stats_privacy;
    if privacy.minute_retention_days == 0
        || privacy.minute_retention_days > 365
        || privacy.hourly_retention_days == 0
        || privacy.hourly_retention_days > 3650
        || privacy.hourly_retention_days < privacy.minute_retention_days
        || (privacy.domain_aggregation_enabled
            && (privacy.domain_retention_days == 0 || privacy.domain_retention_days > 365))
    {
        return Err("INVALID_PROFILE: statistics retention is outside safe bounds".into());
    }
    Ok(())
}

fn validate_rule_source(source: &RuleSourceDraft) -> Result<(), String> {
    validate_source_id(&source.id)?;
    if source.name.trim().is_empty() || source.name.chars().count() > 128 {
        return Err("rule source name must be 1-128 characters".into());
    }
    if source.id == GFWLIST_OFFICIAL_SOURCE_ID || source.kind == RuleSourceKind::GfwlistOfficial {
        return Err("official GFWList is a built-in read-only source".into());
    }
    if !(15 * 60..=30 * 24 * 60 * 60).contains(&source.refresh_interval_seconds) {
        return Err("rule source refresh interval must be between 15 minutes and 30 days".into());
    }
    match source.kind {
        RuleSourceKind::CustomUrl => {
            let raw = source
                .url
                .as_deref()
                .ok_or_else(|| "custom URL rule source requires a URL".to_string())?;
            if raw.len() > 4096 || raw.contains('\0') {
                return Err("rule source URL is too long or contains NUL".into());
            }
            let url = url::Url::parse(raw).map_err(|error| format!("invalid rule URL: {error}"))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err("rule source URL must use http or https".into());
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err("credentials in rule source URLs are not persisted".into());
            }
        }
        RuleSourceKind::LocalFile => {
            if source.url.is_some() {
                return Err(
                    "local rule imports are copied into app storage; external paths are not persisted"
                        .into(),
                );
            }
        }
        RuleSourceKind::GfwlistOfficial => unreachable!(),
    }
    Ok(())
}

fn load_recovery_journal(conn: &Connection) -> Result<RecoveryJournal, String> {
    conn.query_row(
        "SELECT generation, phase, cleanup_required, restore_after_recovery,
                config_revision, platform, active_profile_ids_json,
                artifact_state_json, helper_pid, last_heartbeat_at,
                last_error_code, created_at, updated_at
         FROM engine_recovery_journal WHERE singleton_id = 1",
        [],
        |row| {
            let phase: String = row.get(1)?;
            let platform: String = row.get(5)?;
            let profile_ids_json: String = row.get(6)?;
            let artifact_json: String = row.get(7)?;
            Ok((
                sql_counter(row, 0)?,
                phase,
                row.get::<_, bool>(2)?,
                row.get::<_, bool>(3)?,
                sql_counter(row, 4)?,
                platform,
                profile_ids_json,
                artifact_json,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<i64>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, i64>(11)?,
                row.get::<_, i64>(12)?,
            ))
        },
    )
    .map_err(|error| format!("read recovery journal: {error}"))
    .and_then(
        |(
            generation,
            phase,
            cleanup_required,
            restore_after_recovery,
            config_revision,
            platform,
            profile_ids_json,
            artifact_json,
            helper_pid,
            last_heartbeat_at,
            last_error_code,
            created_at,
            updated_at,
        )| {
            Ok(RecoveryJournal {
                generation,
                phase: parse_enum(&phase, "recovery phase")?,
                cleanup_required,
                restore_after_recovery,
                config_revision,
                platform: parse_enum(&platform, "capture platform")?,
                active_profile_ids: serde_json::from_str(&profile_ids_json)
                    .map_err(|error| format!("decode recovery profiles: {error}"))?,
                artifact_state: serde_json::from_str(&artifact_json)
                    .map_err(|error| format!("decode recovery artifact: {error}"))?,
                helper_pid: helper_pid
                    .map(u32::try_from)
                    .transpose()
                    .map_err(|error| format!("decode helper PID: {error}"))?,
                last_heartbeat_at,
                last_error_code,
                created_at,
                updated_at,
            })
        },
    )
}

fn validate_recovery_artifact(value: &Value) -> Result<(), String> {
    if !value.is_object() {
        return Err("recovery artifact state must be a JSON object".into());
    }
    let serialized = serde_json::to_vec(value)
        .map_err(|error| format!("serialize recovery artifact: {error}"))?;
    if serialized.len() > MAX_RECOVERY_ARTIFACT_BYTES {
        return Err(format!(
            "recovery artifact exceeds {MAX_RECOVERY_ARTIFACT_BYTES} byte limit"
        ));
    }
    reject_sensitive_json(value, "artifactState")
}

fn reject_sensitive_json(value: &Value, path: &str) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
                if [
                    "password",
                    "passphrase",
                    "secret",
                    "credential",
                    "privatekey",
                    "mfanswer",
                    "otp",
                    "username",
                    "payload",
                ]
                .iter()
                .any(|sensitive| normalized.contains(sensitive))
                {
                    return Err(format!(
                        "recovery artifact contains forbidden sensitive field {path}.{key}"
                    ));
                }
                reject_sensitive_json(child, &format!("{path}.{key}"))?;
            }
        }
        Value::Array(values) => {
            for (index, child) in values.iter().enumerate() {
                reject_sensitive_json(child, &format!("{path}[{index}]"))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn ensure_generation(journal: &RecoveryJournal, generation: u64) -> Result<(), String> {
    if generation != journal.generation {
        return Err(format!(
            "RECOVERY_GENERATION_CONFLICT: expected {}, current {}",
            generation, journal.generation
        ));
    }
    Ok(())
}

fn validate_error_code(code: &str) -> Result<(), String> {
    if code.is_empty()
        || code.len() > 128
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err("recovery error code must be 1-128 uppercase ASCII characters/digits/_".into());
    }
    Ok(())
}

fn validate_safe_id(label: &str, id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!(
            "{label} must be 1-128 ASCII letters, digits, '-' or '_'"
        ));
    }
    Ok(())
}

fn enum_name<T: Serialize>(value: &T) -> Result<String, String> {
    match serde_json::to_value(value).map_err(|error| error.to_string())? {
        Value::String(value) => Ok(value),
        _ => Err("enum did not serialize as a string".into()),
    }
}

fn parse_enum<T: for<'de> Deserialize<'de>>(value: &str, label: &str) -> Result<T, String> {
    serde_json::from_value(Value::String(value.to_string()))
        .map_err(|error| format!("decode {label} '{value}': {error}"))
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

const SCHEMA_V1: &str = r#"
BEGIN IMMEDIATE;

CREATE TABLE routing_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    priority INTEGER NOT NULL CHECK(priority >= 0),
    scope TEXT NOT NULL,
    include_children INTEGER NOT NULL CHECK(include_children IN (0, 1)),
    egress_kind TEXT,
    egress_ref_id TEXT,
    draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_routing_profiles_priority
    ON routing_profiles(enabled, priority, id);
CREATE INDEX idx_routing_profiles_egress
    ON routing_profiles(egress_kind, egress_ref_id);

CREATE TABLE app_selectors (
    profile_id TEXT NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY(profile_id, position)
);
CREATE INDEX idx_app_selectors_identity ON app_selectors(kind, value);

CREATE TABLE runtime_process_selectors (
    profile_id TEXT NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 0),
    pid INTEGER NOT NULL CHECK(pid > 0),
    process_start_time INTEGER NOT NULL CHECK(process_start_time > 0),
    PRIMARY KEY(profile_id, position)
);
CREATE INDEX idx_runtime_process_identity
    ON runtime_process_selectors(pid, process_start_time);

CREATE TABLE rule_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    kind TEXT NOT NULL,
    source_url TEXT,
    refresh_interval_seconds INTEGER NOT NULL CHECK(refresh_interval_seconds > 0),
    draft_json TEXT NOT NULL CHECK(json_valid(draft_json)),
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE profile_rule_sources (
    profile_id TEXT NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES rule_sources(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL CHECK(position >= 0),
    PRIMARY KEY(profile_id, position),
    UNIQUE(profile_id, source_id)
);

CREATE TABLE custom_rules (
    profile_id TEXT NOT NULL REFERENCES routing_profiles(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    action TEXT NOT NULL,
    kind TEXT NOT NULL,
    pattern TEXT NOT NULL,
    PRIMARY KEY(profile_id, rule_id),
    UNIQUE(profile_id, position)
);

CREATE TABLE engine_config_snapshots (
    revision INTEGER PRIMARY KEY CHECK(revision > 0),
    state TEXT NOT NULL CHECK(state IN ('prepared', 'committed', 'superseded')),
    profile_ids_json TEXT NOT NULL CHECK(json_valid(profile_ids_json)),
    profiles_json TEXT NOT NULL CHECK(json_valid(profiles_json)),
    created_at INTEGER NOT NULL,
    committed_at INTEGER
);
CREATE UNIQUE INDEX idx_engine_config_one_committed
    ON engine_config_snapshots(state) WHERE state = 'committed';
CREATE INDEX idx_engine_config_created
    ON engine_config_snapshots(created_at DESC);

CREATE TABLE traffic_minute_buckets (
    bucket_start INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    app_identity TEXT NOT NULL DEFAULT '',
    protocol TEXT NOT NULL,
    hostname_source TEXT NOT NULL,
    policy_action TEXT NOT NULL,
    effective_action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    connector TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    bytes_up INTEGER NOT NULL DEFAULT 0 CHECK(bytes_up >= 0),
    bytes_down INTEGER NOT NULL DEFAULT 0 CHECK(bytes_down >= 0),
    connections INTEGER NOT NULL DEFAULT 0 CHECK(connections >= 0),
    errors INTEGER NOT NULL DEFAULT 0 CHECK(errors >= 0),
    connect_millis_total INTEGER NOT NULL DEFAULT 0 CHECK(connect_millis_total >= 0),
    PRIMARY KEY(
        bucket_start, profile_id, app_identity, protocol, hostname_source,
        policy_action, effective_action, outcome, connector, error_code
    )
);
CREATE INDEX idx_traffic_minute_time ON traffic_minute_buckets(bucket_start);
CREATE INDEX idx_traffic_minute_profile_time
    ON traffic_minute_buckets(profile_id, bucket_start);

CREATE TABLE traffic_hour_buckets AS SELECT * FROM traffic_minute_buckets WHERE 0;
CREATE UNIQUE INDEX idx_traffic_hour_key ON traffic_hour_buckets(
    bucket_start, profile_id, app_identity, protocol, hostname_source,
    policy_action, effective_action, outcome, connector, error_code
);
CREATE INDEX idx_traffic_hour_time ON traffic_hour_buckets(bucket_start);

CREATE TABLE optional_domain_day_buckets (
    day_start INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    bytes_up INTEGER NOT NULL DEFAULT 0 CHECK(bytes_up >= 0),
    bytes_down INTEGER NOT NULL DEFAULT 0 CHECK(bytes_down >= 0),
    connections INTEGER NOT NULL DEFAULT 0 CHECK(connections >= 0),
    PRIMARY KEY(day_start, profile_id, domain)
);
CREATE INDEX idx_domain_day_time ON optional_domain_day_buckets(day_start);

CREATE TABLE egress_health_minute_buckets (
    bucket_start INTEGER NOT NULL,
    profile_id TEXT NOT NULL,
    egress_kind TEXT NOT NULL,
    control_state TEXT NOT NULL,
    active_controls_max INTEGER NOT NULL DEFAULT 0 CHECK(active_controls_max >= 0),
    active_channels_max INTEGER NOT NULL DEFAULT 0 CHECK(active_channels_max >= 0),
    channel_errors INTEGER NOT NULL DEFAULT 0 CHECK(channel_errors >= 0),
    reconnects INTEGER NOT NULL DEFAULT 0 CHECK(reconnects >= 0),
    bytes_up INTEGER NOT NULL DEFAULT 0 CHECK(bytes_up >= 0),
    bytes_down INTEGER NOT NULL DEFAULT 0 CHECK(bytes_down >= 0),
    handshake_millis_total INTEGER NOT NULL DEFAULT 0 CHECK(handshake_millis_total >= 0),
    handshake_samples INTEGER NOT NULL DEFAULT 0 CHECK(handshake_samples >= 0),
    host_key_state TEXT NOT NULL DEFAULT '',
    last_error_code TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(bucket_start, profile_id, egress_kind, control_state, host_key_state, last_error_code)
);
CREATE INDEX idx_egress_health_time ON egress_health_minute_buckets(bucket_start);

CREATE TABLE engine_recovery_journal (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
    generation INTEGER NOT NULL CHECK(generation >= 0),
    phase TEXT NOT NULL,
    cleanup_required INTEGER NOT NULL CHECK(cleanup_required IN (0, 1)),
    restore_after_recovery INTEGER NOT NULL CHECK(restore_after_recovery IN (0, 1)),
    config_revision INTEGER NOT NULL CHECK(config_revision >= 0),
    platform TEXT NOT NULL,
    active_profile_ids_json TEXT NOT NULL CHECK(json_valid(active_profile_ids_json)),
    artifact_state_json TEXT NOT NULL CHECK(json_valid(artifact_state_json)),
    helper_pid INTEGER,
    last_heartbeat_at INTEGER,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE engine_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK(json_valid(value_json)),
    updated_at INTEGER NOT NULL
);

COMMIT;
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::{
        AppSelector, CustomRuleDraft, CustomRuleKind, EgressKind, ProfileScope, StatsPrivacy,
    };

    fn store() -> SockscapStore {
        SockscapStore::open_in_memory().expect("open in-memory Sockscap store")
    }

    fn profile(id: &str) -> RoutingProfileDraft {
        RoutingProfileDraft {
            id: id.into(),
            name: format!("Profile {id}"),
            enabled: true,
            priority: 10,
            scope: ProfileScope::Global,
            egress_kind: Some(EgressKind::ProxySession),
            egress_ref_id: Some("proxy-session".into()),
            rule_source_ids: vec![GFWLIST_OFFICIAL_SOURCE_ID.into()],
            custom_rules: vec![CustomRuleDraft {
                id: "manual-example".into(),
                enabled: true,
                action: RouteAction::Proxy,
                kind: CustomRuleKind::DomainSuffix,
                pattern: "example.com".into(),
            }],
            default_action: RouteAction::Proxy,
            ..Default::default()
        }
    }

    fn traffic_delta(profile_id: &str, bucket_start: i64) -> TrafficMinuteDelta {
        TrafficMinuteDelta {
            bucket_start,
            profile_id: profile_id.into(),
            app_identity: Some("/usr/bin/curl".into()),
            protocol: "tcp".into(),
            hostname_source: HostnameSource::TlsSni,
            policy_action: RouteAction::Proxy,
            effective_action: RouteAction::Proxy,
            outcome: FlowOutcomeKind::Established,
            connector: Some("socks5".into()),
            error_code: None,
            bytes_up: 120,
            bytes_down: 480,
            connections: 1,
            errors: 0,
            connect_millis_total: 12,
        }
    }

    #[test]
    fn disk_database_uses_wal_current_schema_and_private_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let store = SockscapStore::open(directory.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), SOCKSCAP_SCHEMA_VERSION);
        let expected_path = directory.path().join(SOCKSCAP_DB_FILE);
        assert_eq!(store.database_path(), Some(expected_path.as_path()));
        let mode: String = store
            .lock_conn()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode.to_ascii_lowercase(), "wal");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let directory_mode = std::fs::metadata(directory.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(directory_mode, 0o700);
            let mode = std::fs::metadata(store.database_path().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
            let lock_mode = std::fs::metadata(directory.path().join(SOCKSCAP_OWNER_LOCK_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(lock_mode, 0o600);
            for suffix in ["-wal", "-shm"] {
                let sidecar = sqlite_sidecar_path(store.database_path().unwrap(), suffix);
                let sidecar_mode = std::fs::metadata(sidecar).unwrap().permissions().mode() & 0o777;
                assert_eq!(sidecar_mode, 0o600);
            }
        }
        let tables: i64 = store
            .lock_conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name IN (
                   'routing_profiles', 'app_selectors', 'rule_sources',
                   'profile_rule_sources', 'custom_rules',
                   'engine_config_snapshots',
                   'traffic_minute_buckets', 'traffic_hour_buckets',
                   'optional_domain_day_buckets',
                   'engine_recovery_journal', 'egress_health_minute_buckets',
                   'engine_settings'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 12);
    }

    #[cfg(unix)]
    #[test]
    fn disk_store_binds_to_the_canonical_private_app_data_directory() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let parent = tempfile::tempdir().unwrap();
        let app_data = parent.path().join("app-data");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::set_permissions(&app_data, std::fs::Permissions::from_mode(0o777)).unwrap();
        let alias = parent.path().join("app-data-alias");
        symlink(&app_data, &alias).unwrap();

        let store = SockscapStore::open(&alias).unwrap();
        let expected = app_data.canonicalize().unwrap().join(SOCKSCAP_DB_FILE);
        assert_eq!(store.database_path(), Some(expected.as_path()));
        let directory_mode = std::fs::metadata(&app_data).unwrap().permissions().mode() & 0o777;
        assert_eq!(directory_mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn disk_store_rejects_symlink_database_and_owner_lock_paths() {
        use std::os::unix::fs::symlink;

        let database_directory = tempfile::tempdir().unwrap();
        let foreign_database = database_directory.path().join("foreign.db");
        std::fs::write(&foreign_database, b"not a Sockscap database").unwrap();
        symlink(
            &foreign_database,
            database_directory.path().join(SOCKSCAP_DB_FILE),
        )
        .unwrap();
        let database_error = SockscapStore::open(database_directory.path())
            .err()
            .expect("a database symlink must be rejected");
        assert!(database_error.contains("database path"));
        assert!(database_error.contains("not a regular file"));

        let lock_directory = tempfile::tempdir().unwrap();
        let foreign_lock = lock_directory.path().join("foreign.lock");
        std::fs::write(&foreign_lock, b"").unwrap();
        symlink(
            &foreign_lock,
            lock_directory.path().join(SOCKSCAP_OWNER_LOCK_FILE),
        )
        .unwrap();
        let lock_error = SockscapStore::open(lock_directory.path())
            .err()
            .expect("an owner-lock symlink must be rejected");
        assert!(lock_error.contains("owner lock"));
    }

    #[test]
    fn synchronous_mode_is_full_on_disk_and_normal_in_memory() {
        let directory = tempfile::tempdir().unwrap();
        let disk = SockscapStore::open(directory.path()).unwrap();
        let disk_synchronous: i64 = disk
            .lock_conn()
            .unwrap()
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(disk_synchronous, 2);

        let memory = store();
        let memory_synchronous: i64 = memory
            .lock_conn()
            .unwrap()
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        assert_eq!(memory_synchronous, 1);
    }

    #[test]
    fn disk_store_owner_lock_is_exclusive_and_released_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let first = SockscapStore::open(directory.path()).unwrap();

        let error = SockscapStore::open(directory.path())
            .err()
            .expect("a second disk store must not open the same database");
        assert!(
            error.starts_with(SOCKSCAP_STORE_ALREADY_OPEN),
            "unexpected owner-lock error: {error}"
        );

        drop(first);
        let reopened = SockscapStore::open(directory.path())
            .expect("dropping the first store must release its owner lock");
        assert_eq!(reopened.schema_version().unwrap(), SOCKSCAP_SCHEMA_VERSION);
    }

    #[test]
    fn refuses_database_from_a_newer_schema() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(SOCKSCAP_DB_FILE);
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        drop(conn);
        let error = SockscapStore::open(directory.path())
            .err()
            .expect("newer schema must be refused");
        assert!(error.contains("newer than supported"));
        let conn = Connection::open(path).unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_ne!(mode.to_ascii_lowercase(), "wal");
    }

    #[test]
    fn login_restore_is_explicit_and_round_trips_in_engine_settings() {
        let store = store();
        assert_eq!(
            store.lifecycle_preferences().unwrap(),
            LifecyclePreferences::default()
        );

        let enabled = store.set_restore_on_system_login(true).unwrap();
        assert!(enabled.restore_on_system_login);
        assert!(enabled.updated_at.is_some());
        assert_eq!(store.lifecycle_preferences().unwrap(), enabled);

        let disabled = store.set_restore_on_system_login(false).unwrap();
        assert!(!disabled.restore_on_system_login);
        assert!(disabled.updated_at.is_some());
        assert_eq!(store.lifecycle_preferences().unwrap(), disabled);

        let rows: i64 = store
            .lock_conn()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM engine_settings WHERE key = ?1",
                params![RESTORE_ON_SYSTEM_LOGIN_SETTING],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn profile_round_trip_is_atomic_revisioned_and_normalized() {
        let store = store();
        let first = store.upsert_profile(&profile("global"), Some(0)).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(store.list_profiles().unwrap(), vec![first.clone()]);

        let mut changed = first.profile.clone();
        changed.name = "Changed".into();
        changed.custom_rules.push(CustomRuleDraft {
            id: "block-test".into(),
            enabled: true,
            action: RouteAction::Block,
            kind: CustomRuleKind::DomainExact,
            pattern: "blocked.example".into(),
        });
        let second = store
            .upsert_profile(&changed, Some(first.revision))
            .unwrap();
        assert_eq!(second.revision, 2);
        assert_eq!(second.created_at, first.created_at);

        let conn = store.lock_conn().unwrap();
        let source_links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM profile_rule_sources WHERE profile_id = 'global'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let custom_rules: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM custom_rules WHERE profile_id = 'global'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_links, 1);
        assert_eq!(custom_rules, 2);
        drop(conn);

        let stale = store
            .upsert_profile(&changed, Some(first.revision))
            .unwrap_err();
        assert!(stale.starts_with("PROFILE_REVISION_CONFLICT"));
        assert_eq!(store.get_profile("global").unwrap().unwrap(), second);
    }

    #[test]
    fn committed_config_snapshot_is_immutable_and_separate_from_drafts() {
        let store = store();
        let saved = store.upsert_profile(&profile("global"), None).unwrap();
        let first_prepared = store.prepare_config_snapshot().unwrap();
        assert_eq!(first_prepared.state, ConfigSnapshotState::Prepared);
        assert_eq!(first_prepared.profiles[0].name, "Profile global");

        let mut edited = saved.profile;
        edited.name = "Edited after prepare".into();
        store.upsert_profile(&edited, Some(saved.revision)).unwrap();
        let first_committed = store
            .commit_config_snapshot(first_prepared.revision)
            .unwrap();
        assert_eq!(first_committed.state, ConfigSnapshotState::Committed);
        assert_eq!(first_committed.profiles[0].name, "Profile global");

        let second_prepared = store.prepare_config_snapshot().unwrap();
        assert_eq!(second_prepared.profiles[0].name, "Edited after prepare");
        let second_committed = store
            .commit_config_snapshot(second_prepared.revision)
            .unwrap();
        assert_eq!(
            store.last_committed_config_snapshot().unwrap(),
            Some(second_committed.clone())
        );
        let first_state =
            load_config_snapshot(&store.lock_conn().unwrap(), first_committed.revision)
                .unwrap()
                .unwrap();
        assert_eq!(first_state.state, ConfigSnapshotState::Superseded);

        let disposable = store.prepare_config_snapshot().unwrap();
        let marker = store
            .begin_prepare(
                &["global".into()],
                disposable.revision,
                CapturePlatform::Linux,
                false,
                "linux_nft",
            )
            .unwrap();
        assert!(
            store
                .discard_prepared_config_snapshot(disposable.revision)
                .unwrap_err()
                .starts_with("CONFIG_SNAPSHOT_IN_USE")
        );
        store.complete_recovery(marker.generation).unwrap();
        store
            .discard_prepared_config_snapshot(disposable.revision)
            .unwrap();
        assert!(
            load_config_snapshot(&store.lock_conn().unwrap(), disposable.revision)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn profile_conflict_and_unknown_rule_source_leave_existing_rows_unchanged() {
        let store = store();
        let original = store.upsert_profile(&profile("one"), None).unwrap();
        let mut conflicting = profile("two");
        conflicting.priority = 20;
        let error = store.upsert_profile(&conflicting, None).unwrap_err();
        assert!(error.starts_with("PROFILE_CONFLICT"));

        let mut missing_source = original.profile.clone();
        missing_source.rule_source_ids = vec!["not-installed".into()];
        let error = store
            .upsert_profile(&missing_source, Some(original.revision))
            .unwrap_err();
        assert!(error.starts_with("RULE_SOURCE_NOT_FOUND"));
        assert_eq!(store.list_profiles().unwrap(), vec![original]);
    }

    #[test]
    fn deleting_profile_cascades_configuration_children() {
        let store = store();
        let mut app_profile = profile("apps");
        app_profile.scope = ProfileScope::Applications;
        app_profile.app_selectors = vec![AppSelector::executable_path("/usr/bin/curl")];
        let saved = store.upsert_profile(&app_profile, None).unwrap();
        store
            .delete_profile(&saved.profile.id, Some(saved.revision))
            .unwrap();
        assert!(store.list_profiles().unwrap().is_empty());
        let conn = store.lock_conn().unwrap();
        for table in ["app_selectors", "profile_rule_sources", "custom_rules"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} did not cascade");
        }
    }

    #[test]
    fn custom_rule_sources_reject_credentials_and_referenced_deletion() {
        let store = store();
        let with_credentials = RuleSourceDraft {
            id: "private-feed".into(),
            name: "Private".into(),
            enabled: true,
            kind: RuleSourceKind::CustomUrl,
            url: Some("https://alice:secret@example.com/list.txt".into()),
            refresh_interval_seconds: 3600,
        };
        assert!(
            store
                .upsert_rule_source(&with_credentials, None)
                .unwrap_err()
                .contains("credentials")
        );

        let source = RuleSourceDraft {
            url: Some("https://example.com/list.txt".into()),
            ..with_credentials
        };
        let saved = store.upsert_rule_source(&source, Some(0)).unwrap();
        let mut linked = profile("linked");
        linked.rule_source_ids = vec![source.id.clone()];
        store.upsert_profile(&linked, None).unwrap();
        let error = store
            .delete_rule_source(&source.id, Some(saved.revision))
            .unwrap_err();
        assert!(error.starts_with("RULE_SOURCE_IN_USE"));
        assert_eq!(store.list_rule_sources().unwrap().len(), 2);
    }

    #[test]
    fn recovery_journal_enforces_generation_and_ordered_cleanup() {
        let store = store();
        let clean = store.recovery_journal().unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);

        let preparing = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::Linux,
                true,
                "linux_nft",
            )
            .unwrap();
        assert_eq!(preparing.generation, 1);
        assert!(preparing.cleanup_required);
        assert_eq!(preparing.artifact_state["bindingSchemaVersion"], 1);
        assert_eq!(preparing.artifact_state["bindingState"], "adapter_selected");
        assert_eq!(preparing.artifact_state["adapter"], "linux_nft");
        assert_eq!(preparing.artifact_state["generation"], 1);
        assert!(
            store
                .begin_prepare(
                    &["global".into()],
                    8,
                    CapturePlatform::Linux,
                    false,
                    "linux_nft",
                )
                .is_err()
        );
        assert!(store.commit_active(preparing.generation).is_err());

        let installed = store
            .record_capture_installed(
                preparing.generation,
                &serde_json::json!({
                    "adapter": "linux_nft",
                    "table": "taomni_sockscap",
                    "ruleHandles": [12, 13]
                }),
            )
            .unwrap();
        assert_eq!(installed.phase, RecoveryPhase::CaptureInstalled);
        let active = store.commit_active(installed.generation).unwrap();
        assert_eq!(active.phase, RecoveryPhase::Active);
        let refreshed = store
            .update_recovery_artifact(
                active.generation,
                &serde_json::json!({"interface": "tun-refreshed"}),
            )
            .unwrap();
        assert_eq!(refreshed.phase, RecoveryPhase::Active);
        assert_eq!(
            refreshed.artifact_state,
            serde_json::json!({"interface": "tun-refreshed"})
        );
        assert!(store.complete_recovery(active.generation).is_err());
        let stopping = store.begin_stop(active.generation).unwrap();
        assert_eq!(stopping.phase, RecoveryPhase::Stopping);
        assert!(
            store
                .record_helper_heartbeat(stopping.generation + 1, 42)
                .is_err()
        );
        let clean = store.complete_recovery(stopping.generation).unwrap();
        assert_eq!(clean.phase, RecoveryPhase::Clean);
        assert!(!clean.cleanup_required);
        assert_eq!(clean.artifact_state, serde_json::json!({}));
        assert!(
            store
                .update_recovery_artifact(
                    clean.generation,
                    &serde_json::json!({"interface": "must-fail"})
                )
                .is_err()
        );
    }

    #[test]
    fn recovery_journal_rejects_an_unsafe_adapter_binding() {
        let store = store();
        let error = store
            .begin_prepare(
                &["global".into()],
                7,
                CapturePlatform::Linux,
                false,
                "linux adapter/../../foreign",
            )
            .unwrap_err();
        assert!(error.contains("recovery adapter id"));
        let journal = store.recovery_journal().unwrap();
        assert_eq!(journal.phase, RecoveryPhase::Clean);
        assert!(!journal.cleanup_required);
    }

    #[test]
    fn recovery_artifact_rejects_secrets_and_survives_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let generation = {
            let store = SockscapStore::open(directory.path()).unwrap();
            let marker = store
                .begin_prepare(
                    &["p1".into()],
                    1,
                    CapturePlatform::Linux,
                    false,
                    "linux_nft",
                )
                .unwrap();
            let error = store
                .record_capture_installed(
                    marker.generation,
                    &serde_json::json!({"proxyPassword": "must-not-land"}),
                )
                .unwrap_err();
            assert!(error.contains("forbidden sensitive field"));
            store
                .record_capture_installed(
                    marker.generation,
                    &serde_json::json!({"interface": "tun42"}),
                )
                .unwrap();
            marker.generation
        };
        let reopened = SockscapStore::open(directory.path()).unwrap();
        let journal = reopened.recovery_journal().unwrap();
        assert_eq!(journal.generation, generation);
        assert_eq!(journal.phase, RecoveryPhase::CaptureInstalled);
        assert!(journal.cleanup_required);
        assert_eq!(
            journal.artifact_state,
            serde_json::json!({"interface": "tun42"})
        );
    }

    #[test]
    fn statistics_aggregate_without_payload_or_credentials_and_can_be_cleared() {
        let store = store();
        let mut profile = profile("stats");
        profile.stats_privacy.domain_aggregation_enabled = true;
        store.upsert_profile(&profile, None).unwrap();
        let bucket = 1_800_000_000 / 60 * 60;
        let delta = traffic_delta("stats", bucket);
        assert_eq!(
            store.record_traffic_batch(&[delta.clone(), delta]).unwrap(),
            2
        );
        assert_eq!(
            store
                .record_domain_batch(&[DomainDayDelta {
                    day_start: bucket / 86_400 * 86_400,
                    profile_id: "stats".into(),
                    domain: "Exämple.COM.".into(),
                    bytes_up: 5,
                    bytes_down: 10,
                    connections: 1,
                }])
                .unwrap(),
            1
        );
        store
            .record_egress_health_batch(&[EgressHealthMinuteDelta {
                bucket_start: bucket,
                profile_id: "stats".into(),
                egress_kind: "ssh_jump".into(),
                control_state: "healthy".into(),
                active_controls_max: 1,
                active_channels_max: 4,
                channel_errors: 0,
                reconnects: 1,
                bytes_up: 20,
                bytes_down: 40,
                handshake_millis_total: 35,
                handshake_samples: 1,
                host_key_state: Some("trusted".into()),
                last_error_code: None,
            }])
            .unwrap();

        let snapshot = store
            .stats_snapshot(&StatsSnapshotQuery {
                from_unix: bucket - 60,
                to_unix: bucket + 86_400,
                include_domains: true,
                limit: 10,
            })
            .unwrap();
        assert_eq!(snapshot.totals.connections, 2);
        assert_eq!(snapshot.totals.bytes_up, 240);
        assert_eq!(snapshot.totals.bytes_down, 960);
        assert_eq!(snapshot.top_applications[0].key, "/usr/bin/curl");
        assert_eq!(snapshot.top_domains[0].key, "xn--exmple-cua.com");
        assert_eq!(
            snapshot.egress_health[0].host_key_state.as_deref(),
            Some("trusted")
        );

        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains("payload"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("username"));
        assert!(store.clear_stats().unwrap() >= 3);
        let empty = store
            .stats_snapshot(&StatsSnapshotQuery {
                from_unix: bucket - 60,
                to_unix: bucket + 86_400,
                include_domains: true,
                limit: 10,
            })
            .unwrap();
        assert_eq!(empty.totals, StatsTotals::default());
    }

    #[test]
    fn privacy_modes_prevent_persistence_and_domain_collection() {
        let store = store();
        let mut session_only = profile("session-only");
        session_only.stats_privacy.collection_mode = StatsCollectionMode::SessionOnly;
        store.upsert_profile(&session_only, None).unwrap();
        let bucket = 1_800_000_000 / 60 * 60;
        assert_eq!(
            store
                .record_traffic_batch(&[traffic_delta("session-only", bucket)])
                .unwrap(),
            0
        );

        let mut no_domains = profile("no-domains");
        no_domains.scope = ProfileScope::Applications;
        no_domains.app_selectors = vec![AppSelector::executable_path("/opt/no-domains")];
        no_domains.priority = 20;
        no_domains.stats_privacy.domain_aggregation_enabled = false;
        store.upsert_profile(&no_domains, None).unwrap();
        assert_eq!(
            store
                .record_domain_batch(&[DomainDayDelta {
                    day_start: bucket / 86_400 * 86_400,
                    profile_id: "no-domains".into(),
                    domain: "example.com".into(),
                    bytes_up: 1,
                    bytes_down: 1,
                    connections: 1,
                }])
                .unwrap(),
            0
        );
        assert_eq!(store.clear_stats().unwrap(), 0);
    }

    #[test]
    fn cleanup_rolls_expired_minutes_to_hours_and_applies_retention() {
        let store = store();
        let now = 200 * 86_400;
        let mut profile = profile("retention");
        profile.stats_privacy = StatsPrivacy {
            collection_mode: StatsCollectionMode::Persisted,
            minute_retention_days: 1,
            hourly_retention_days: 10,
            domain_aggregation_enabled: false,
            domain_retention_days: 7,
        };
        store.upsert_profile(&profile, None).unwrap();
        let old_minute = (now - 2 * 86_400) / 60 * 60;
        store
            .record_traffic_batch(&[traffic_delta("retention", old_minute)])
            .unwrap();
        let report = store.cleanup_stats(now).unwrap();
        assert!(report.rolled_up_rows >= 1);
        assert!(report.deleted_rows >= 1);

        let conn = store.lock_conn().unwrap();
        let minute_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM traffic_minute_buckets", [], |row| {
                row.get(0)
            })
            .unwrap();
        let hour_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM traffic_hour_buckets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(minute_count, 0);
        assert_eq!(hour_count, 1);
        drop(conn);

        let snapshot = store
            .stats_snapshot(&StatsSnapshotQuery {
                from_unix: old_minute - 60,
                to_unix: now,
                include_domains: false,
                limit: 10,
            })
            .unwrap();
        assert_eq!(snapshot.totals.connections, 1);
        assert_eq!(snapshot.series[0].resolution_seconds, 3600);
    }
}
