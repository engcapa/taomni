//! Sockscap persistence (plan §10).
//!
//! A dedicated `sockscap.db` (WAL) keeps high-frequency stats writes off the
//! main `taomni.db` session lock. It stores routing profiles, rule sources,
//! custom rules, minute/day stat buckets, egress-health buckets and the engine
//! recovery journal. It NEVER stores secrets — SSH/Proxy sessions and their
//! credentials stay in `taomni.db` + Vault; only their `session_id` is
//! referenced (plan §10, §16.6-25). Following the repo convention (sessions'
//! `options_json`), complex records are stored as JSON blobs with a few indexed
//! scalar columns for querying.

use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::Serialize;

use super::download::GFWLIST_MIRRORS;
use super::model::{CustomRule, RoutingProfile, RuleSource, RuleSourceKind};
use super::{Action, Protocol};

/// Current `sockscap.db` schema version, stored in `PRAGMA user_version`.
/// Bump this whenever the schema below changes incompatibly.
const SCHEMA_VERSION: i64 = 1;

/// Create all tables and enable WAL. Idempotent.
///
/// Reconciles a pre-release schema change: an earlier build of this
/// (unreleased) feature stored a different, incompatible layout (json-blob
/// tables, a `schema_version` table, `settings`, `engine_recovery`). Because
/// this store holds only rebuildable config/stats and NEVER secrets (egress
/// credentials live in the Vault), we drop and recreate the tables when that
/// legacy layout is present rather than migrate a throwaway dev schema. Fresh
/// or already-current databases are left untouched and just stamped with the
/// current `user_version`.
pub fn init_db(conn: &Connection) -> SqlResult<()> {
    // WAL so stats writes don't block reads; NORMAL sync is fine for a
    // rebuildable stats/config store.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < SCHEMA_VERSION && legacy_schema_present(conn)? {
        drop_all_tables(conn)?;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS routing_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 100,
            scope TEXT NOT NULL,
            config_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rule_sources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            config_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS custom_rules (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            order_idx INTEGER NOT NULL DEFAULT 0,
            rule_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_custom_rules_profile
            ON custom_rules(profile_id, order_idx);

        CREATE TABLE IF NOT EXISTS traffic_minute_buckets (
            minute_ts INTEGER NOT NULL,
            profile_id TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            protocol TEXT NOT NULL,
            bytes_up INTEGER NOT NULL DEFAULT 0,
            bytes_down INTEGER NOT NULL DEFAULT 0,
            connections INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (minute_ts, profile_id, action, protocol)
        );
        CREATE INDEX IF NOT EXISTS idx_traffic_minute ON traffic_minute_buckets(minute_ts);

        CREATE TABLE IF NOT EXISTS domain_day_buckets (
            day_ts INTEGER NOT NULL,
            profile_id TEXT NOT NULL DEFAULT '',
            domain TEXT NOT NULL,
            bytes INTEGER NOT NULL DEFAULT 0,
            connections INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day_ts, profile_id, domain)
        );
        CREATE INDEX IF NOT EXISTS idx_domain_day ON domain_day_buckets(day_ts);

        CREATE TABLE IF NOT EXISTS egress_health_minute_buckets (
            minute_ts INTEGER NOT NULL,
            profile_id TEXT NOT NULL DEFAULT '',
            control_connections INTEGER NOT NULL DEFAULT 0,
            active_channels INTEGER NOT NULL DEFAULT 0,
            reconnects INTEGER NOT NULL DEFAULT 0,
            channel_errors INTEGER NOT NULL DEFAULT 0,
            rtt_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (minute_ts, profile_id)
        );

        CREATE TABLE IF NOT EXISTS engine_recovery_journal (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            state_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recovery_active
            ON engine_recovery_journal(active);
        ",
    )?;
    // Stamp the schema version so future runs skip reconciliation.
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    // Built-in GFWList source (plan §6.1, §16.3-10). Idempotent: only inserted
    // when missing so user edits to the row are preserved.
    seed_builtin_gfwlist(conn)?;
    Ok(())
}

/// Ensure the built-in `gfwlist-official` rule source exists with the healthy
/// official mirrors. Does not overwrite an existing row.
fn seed_builtin_gfwlist(conn: &Connection) -> SqlResult<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM rule_sources WHERE id = 'gfwlist-official')",
        [],
        |r| r.get(0),
    )?;
    if exists {
        return Ok(());
    }
    let src = RuleSource {
        id: "gfwlist-official".into(),
        name: "Official GFWList".into(),
        kind: RuleSourceKind::GfwlistOfficial,
        urls: GFWLIST_MIRRORS.iter().map(|s| (*s).to_string()).collect(),
        local_path: None,
        enabled: true,
        min_refresh_secs: 6 * 60 * 60,
    };
    upsert_rule_source(conn, &src)
}

/// True when the file predates the current schema. The pre-release layout is
/// recognizable by tables the current schema never creates.
fn legacy_schema_present(conn: &Connection) -> SqlResult<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' \
         AND name IN ('schema_version', 'settings', 'engine_recovery'))",
        [],
        |r| r.get(0),
    )
}

/// Drop every user table (the file is dedicated to Sockscap) so the CREATE
/// statements start from a clean slate. Dropping a table also drops its
/// indexes; `sqlite_%` internal tables are left alone.
fn drop_all_tables(conn: &Connection) -> SqlResult<()> {
    let names: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<SqlResult<Vec<_>>>()?
    };
    for name in names {
        conn.execute_batch(&format!("DROP TABLE IF EXISTS \"{name}\";"))?;
    }
    Ok(())
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

fn scope_str(p: &RoutingProfile) -> String {
    serde_json::to_value(&p.scope)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "global".into())
}

/// Insert or replace a routing profile.
pub fn upsert_profile(conn: &Connection, profile: &RoutingProfile) -> SqlResult<()> {
    let config_json = serde_json::to_string(profile)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO routing_profiles (id, name, enabled, priority, scope, config_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, enabled=excluded.enabled, priority=excluded.priority,
            scope=excluded.scope, config_json=excluded.config_json, updated_at=excluded.updated_at",
        params![
            profile.id,
            profile.name,
            profile.enabled as i32,
            profile.priority,
            scope_str(profile),
            config_json,
            now_secs(),
        ],
    )?;
    Ok(())
}

/// List all profiles (ascending priority, then name).
pub fn list_profiles(conn: &Connection) -> SqlResult<Vec<RoutingProfile>> {
    let mut stmt = conn.prepare(
        "SELECT config_json FROM routing_profiles ORDER BY priority ASC, name ASC",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        let json = r?;
        match serde_json::from_str::<RoutingProfile>(&json) {
            Ok(p) => out.push(p),
            Err(e) => tracing::warn!("sockscap: skipping unparseable profile row: {e}"),
        }
    }
    Ok(out)
}

/// Fetch one profile by id.
pub fn get_profile(conn: &Connection, id: &str) -> SqlResult<Option<RoutingProfile>> {
    let json: Option<String> = conn
        .query_row(
            "SELECT config_json FROM routing_profiles WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json.and_then(|j| serde_json::from_str(&j).ok()))
}

/// Delete a profile and its custom rules.
pub fn delete_profile(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM custom_rules WHERE profile_id = ?1", params![id])?;
    conn.execute("DELETE FROM routing_profiles WHERE id = ?1", params![id])?;
    Ok(())
}

/* ------------------------------- rule sources ------------------------------ */

fn enum_str<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|j| j.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

pub fn upsert_rule_source(conn: &Connection, src: &RuleSource) -> SqlResult<()> {
    let config_json = serde_json::to_string(src)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
    conn.execute(
        "INSERT INTO rule_sources (id, name, kind, enabled, config_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, kind=excluded.kind, enabled=excluded.enabled,
            config_json=excluded.config_json, updated_at=excluded.updated_at",
        params![
            src.id,
            src.name,
            enum_str(&src.kind),
            src.enabled as i32,
            config_json,
            now_secs(),
        ],
    )?;
    Ok(())
}

pub fn list_rule_sources(conn: &Connection) -> SqlResult<Vec<RuleSource>> {
    let mut stmt = conn.prepare("SELECT config_json FROM rule_sources ORDER BY name ASC")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        if let Ok(src) = serde_json::from_str::<RuleSource>(&r?) {
            out.push(src);
        }
    }
    Ok(out)
}

pub fn delete_rule_source(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM rule_sources WHERE id = ?1", params![id])?;
    Ok(())
}

/* ------------------------------- custom rules ------------------------------ */

/// Replace a profile's ordered custom-rule list atomically.
pub fn replace_custom_rules(
    conn: &Connection,
    profile_id: &str,
    rules: &[CustomRule],
) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM custom_rules WHERE profile_id = ?1",
        params![profile_id],
    )?;
    for (idx, rule) in rules.iter().enumerate() {
        let rule_json = serde_json::to_string(rule)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        conn.execute(
            "INSERT INTO custom_rules (id, profile_id, order_idx, rule_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![rule.id, profile_id, idx as i64, rule_json],
        )?;
    }
    Ok(())
}

pub fn list_custom_rules(conn: &Connection, profile_id: &str) -> SqlResult<Vec<CustomRule>> {
    let mut stmt = conn.prepare(
        "SELECT rule_json FROM custom_rules WHERE profile_id = ?1 ORDER BY order_idx ASC",
    )?;
    let rows = stmt.query_map(params![profile_id], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for r in rows {
        if let Ok(rule) = serde_json::from_str::<CustomRule>(&r?) {
            out.push(rule);
        }
    }
    Ok(out)
}

/* ---------------------------------- stats ---------------------------------- */

/// Aggregate traffic totals since a timestamp.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficTotals {
    pub bytes_up: i64,
    pub bytes_down: i64,
    pub connections: i64,
    pub errors: i64,
    pub direct: i64,
    pub proxy: i64,
    pub block: i64,
}

/// Accumulate one minute bucket (called on the batch-write path, not per byte).
#[allow(clippy::too_many_arguments)]
pub fn record_traffic(
    conn: &Connection,
    minute_ts: i64,
    profile_id: &str,
    action: Action,
    protocol: Protocol,
    bytes_up: i64,
    bytes_down: i64,
    connections: i64,
    errors: i64,
) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO traffic_minute_buckets
            (minute_ts, profile_id, action, protocol, bytes_up, bytes_down, connections, errors)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(minute_ts, profile_id, action, protocol) DO UPDATE SET
            bytes_up = bytes_up + excluded.bytes_up,
            bytes_down = bytes_down + excluded.bytes_down,
            connections = connections + excluded.connections,
            errors = errors + excluded.errors",
        params![
            minute_ts,
            profile_id,
            enum_str(&action),
            enum_str(&protocol),
            bytes_up,
            bytes_down,
            connections,
            errors,
        ],
    )?;
    Ok(())
}

pub fn query_traffic_totals(conn: &Connection, since_ts: i64) -> SqlResult<TrafficTotals> {
    let mut stmt = conn.prepare(
        "SELECT action, SUM(bytes_up), SUM(bytes_down), SUM(connections), SUM(errors)
         FROM traffic_minute_buckets WHERE minute_ts >= ?1 GROUP BY action",
    )?;
    let mut totals = TrafficTotals::default();
    let rows = stmt.query_map(params![since_ts], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    for r in rows {
        let (action, up, down, conns, errs) = r?;
        totals.bytes_up += up;
        totals.bytes_down += down;
        totals.connections += conns;
        totals.errors += errs;
        match action.as_str() {
            "direct" => totals.direct += conns,
            "proxy" => totals.proxy += conns,
            "block" => totals.block += conns,
            _ => {}
        }
    }
    Ok(totals)
}

/// One minute of traffic for the Dashboard 30-minute trend (plan §11).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficMinutePoint {
    pub minute_ts: i64,
    pub bytes_up: i64,
    pub bytes_down: i64,
    pub connections: i64,
    pub direct: i64,
    pub proxy: i64,
    pub block: i64,
    pub errors: i64,
}

/// Domain aggregate row (plan §10 — only present when privacy allows).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainStatRow {
    pub domain: String,
    pub bytes: i64,
    pub connections: i64,
}

/// Per-minute series from `since_ts` inclusive, ordered ascending.
/// Minutes with no rows are omitted (UI fills gaps as zero).
pub fn query_traffic_series(conn: &Connection, since_ts: i64) -> SqlResult<Vec<TrafficMinutePoint>> {
    let mut stmt = conn.prepare(
        "SELECT minute_ts, action,
                SUM(bytes_up), SUM(bytes_down), SUM(connections), SUM(errors)
         FROM traffic_minute_buckets
         WHERE minute_ts >= ?1
         GROUP BY minute_ts, action
         ORDER BY minute_ts ASC",
    )?;
    let rows = stmt.query_map(params![since_ts], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;

    use std::collections::BTreeMap;
    let mut map: BTreeMap<i64, TrafficMinutePoint> = BTreeMap::new();
    for r in rows {
        let (ts, action, up, down, conns, errs) = r?;
        let p = map.entry(ts).or_insert_with(|| TrafficMinutePoint {
            minute_ts: ts,
            ..Default::default()
        });
        p.bytes_up += up;
        p.bytes_down += down;
        p.connections += conns;
        p.errors += errs;
        match action.as_str() {
            "direct" => p.direct += conns,
            "proxy" => p.proxy += conns,
            "block" => p.block += conns,
            _ => {}
        }
    }
    Ok(map.into_values().collect())
}

/// Top domains by connections for the last `days` days (plan §11 Top Domains).
pub fn query_top_domains(conn: &Connection, since_day_ts: i64, limit: i64) -> SqlResult<Vec<DomainStatRow>> {
    let mut stmt = conn.prepare(
        "SELECT domain, SUM(bytes), SUM(connections)
         FROM domain_day_buckets
         WHERE day_ts >= ?1
         GROUP BY domain
         ORDER BY SUM(connections) DESC, SUM(bytes) DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![since_day_ts, limit], |row| {
        Ok(DomainStatRow {
            domain: row.get(0)?,
            bytes: row.get(1)?,
            connections: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// Wipe all collected statistics immediately (plan §10 "立即清空统计").
pub fn clear_stats(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "DELETE FROM traffic_minute_buckets;
         DELETE FROM domain_day_buckets;
         DELETE FROM egress_health_minute_buckets;",
    )
}

/// Drop minute buckets older than `cutoff_ts` and day buckets older than
/// `day_cutoff_ts` (retention enforcement, plan §10, §16.6-24/25).
pub fn prune_stats(conn: &Connection, cutoff_ts: i64, day_cutoff_ts: i64) -> SqlResult<()> {
    conn.execute(
        "DELETE FROM traffic_minute_buckets WHERE minute_ts < ?1",
        params![cutoff_ts],
    )?;
    conn.execute(
        "DELETE FROM egress_health_minute_buckets WHERE minute_ts < ?1",
        params![cutoff_ts],
    )?;
    conn.execute(
        "DELETE FROM domain_day_buckets WHERE day_ts < ?1",
        params![day_cutoff_ts],
    )?;
    Ok(())
}

/* ----------------------------- recovery journal ---------------------------- */

/// Record an active recovery marker before installing capture rules; any older
/// active marker is deactivated first (plan §9, §16.6-23).
pub fn write_recovery_marker(conn: &Connection, state_json: &str) -> SqlResult<i64> {
    conn.execute("UPDATE engine_recovery_journal SET active = 0 WHERE active = 1", [])?;
    conn.execute(
        "INSERT INTO engine_recovery_journal (created_at, active, state_json)
         VALUES (?1, 1, ?2)",
        params![now_secs(), state_json],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The active recovery marker (id, state_json), if any — checked on startup to
/// clean up leftover capture/route state after a crash (plan §16.6-23).
pub fn read_active_recovery(conn: &Connection) -> SqlResult<Option<(i64, String)>> {
    conn.query_row(
        "SELECT id, state_json FROM engine_recovery_journal
         WHERE active = 1 ORDER BY created_at DESC LIMIT 1",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    )
    .optional()
}

/// Mark all recovery markers inactive after a clean stop / successful recovery.
pub fn clear_recovery(conn: &Connection) -> SqlResult<()> {
    conn.execute("UPDATE engine_recovery_journal SET active = 0 WHERE active = 1", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::model::{
        DnsMode, EgressFailureAction, EgressKind, LocalNetworkPolicy, RulePattern,
        RuleSourceKind, RuleDirection, Scope, StatsPrivacy, UdpPolicy,
    };
    use crate::sockscap::Action;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        c
    }

    /// The pre-release layout that shipped on this branch before the columnar
    /// schema. `init_db` must reconcile it instead of failing on
    /// "no such column: profile_id" (which left SockscapState unmanaged).
    fn legacy_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             CREATE TABLE routing_profiles (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE rule_sources (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE custom_rules (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE engine_recovery (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
             CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO schema_version (version) VALUES (0);",
        )
        .unwrap();
    }

    #[test]
    fn init_db_reconciles_legacy_schema() {
        let c = Connection::open_in_memory().unwrap();
        legacy_schema(&c);
        // Must not error on the incompatible custom_rules layout.
        init_db(&c).unwrap();
        // Version stamped, and the new columnar schema is usable.
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        upsert_profile(&c, &profile("p1")).unwrap();
        assert_eq!(list_profiles(&c).unwrap().len(), 1);
        // Legacy-only tables are gone.
        assert!(!legacy_schema_present(&c).unwrap());
    }

    #[test]
    fn init_db_is_idempotent_and_preserves_data() {
        let c = mem();
        upsert_profile(&c, &profile("keep")).unwrap();
        // A second init on an already-current db must not drop data.
        init_db(&c).unwrap();
        assert_eq!(list_profiles(&c).unwrap().len(), 1);
    }

    #[test]
    fn init_db_seeds_builtin_gfwlist() {
        let c = mem();
        let sources = list_rule_sources(&c).unwrap();
        assert!(
            sources.iter().any(|s| s.id == "gfwlist-official"),
            "expected gfwlist-official seed"
        );
        // Re-init must not duplicate or clobber a renamed row.
        let mut custom = sources
            .into_iter()
            .find(|s| s.id == "gfwlist-official")
            .unwrap();
        custom.name = "My GFWList".into();
        upsert_rule_source(&c, &custom).unwrap();
        init_db(&c).unwrap();
        let again = list_rule_sources(&c).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].name, "My GFWList");
    }

    fn profile(id: &str) -> RoutingProfile {
        RoutingProfile {
            id: id.into(),
            name: format!("profile {id}"),
            enabled: true,
            priority: 100,
            scope: Scope::Global,
            app_selectors: vec![],
            runtime_processes: vec![],
            include_children: true,
            egress_kind: EgressKind::ProxySession,
            egress_ref_id: "proxy-1".into(),
            egress_failure_action: EgressFailureAction::FailOpen,
            rule_source_ids: vec!["gfwlist-official".into()],
            default_action: Action::Direct,
            dns_mode: DnsMode::SystemCapture,
            unknown_domain_action: Action::Direct,
            udp_policy: UdpPolicy::Block,
            local_network_policy: LocalNetworkPolicy::Direct,
            ssh_pool_options: None,
            stats_privacy: StatsPrivacy::default(),
        }
    }

    #[test]
    fn profile_crud_round_trips() {
        let c = mem();
        let mut p = profile("p1");
        upsert_profile(&c, &p).unwrap();
        assert_eq!(list_profiles(&c).unwrap().len(), 1);
        // Update.
        p.name = "renamed".into();
        upsert_profile(&c, &p).unwrap();
        assert_eq!(get_profile(&c, "p1").unwrap().unwrap().name, "renamed");
        // Delete.
        delete_profile(&c, "p1").unwrap();
        assert!(get_profile(&c, "p1").unwrap().is_none());
    }

    #[test]
    fn rule_source_crud() {
        let c = mem();
        let src = RuleSource {
            id: "gfwlist-official".into(),
            name: "GFWList".into(),
            kind: RuleSourceKind::GfwlistOfficial,
            urls: vec!["https://example/gfwlist.txt".into()],
            local_path: None,
            enabled: true,
            min_refresh_secs: 21600,
        };
        upsert_rule_source(&c, &src).unwrap();
        let all = list_rule_sources(&c).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "gfwlist-official");
        delete_rule_source(&c, "gfwlist-official").unwrap();
        assert!(list_rule_sources(&c).unwrap().is_empty());
    }

    #[test]
    fn custom_rules_ordered_replace() {
        let c = mem();
        upsert_profile(&c, &profile("p1")).unwrap();
        let rules = vec![
            CustomRule {
                id: "r1".into(),
                order: 0,
                pattern: RulePattern::DomainSuffix("a.com".into()),
                action: RuleDirection::Direct,
                note: None,
                enabled: true,
            },
            CustomRule {
                id: "r2".into(),
                order: 1,
                pattern: RulePattern::Cidr("10.0.0.0/8".into()),
                action: RuleDirection::Proxy,
                note: None,
                enabled: true,
            },
        ];
        replace_custom_rules(&c, "p1", &rules).unwrap();
        let loaded = list_custom_rules(&c, "p1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "r1");
        assert_eq!(loaded[1].id, "r2");
        // Deleting the profile cascades its custom rules.
        delete_profile(&c, "p1").unwrap();
        assert!(list_custom_rules(&c, "p1").unwrap().is_empty());
    }

    #[test]
    fn traffic_buckets_accumulate_and_aggregate() {
        let c = mem();
        record_traffic(&c, 1000, "p1", Action::Proxy, Protocol::Tcp, 100, 200, 1, 0).unwrap();
        record_traffic(&c, 1000, "p1", Action::Proxy, Protocol::Tcp, 50, 25, 1, 1).unwrap();
        record_traffic(&c, 1060, "p1", Action::Direct, Protocol::Tcp, 10, 10, 1, 0).unwrap();
        let totals = query_traffic_totals(&c, 0).unwrap();
        assert_eq!(totals.bytes_up, 160);
        assert_eq!(totals.bytes_down, 235);
        assert_eq!(totals.connections, 3);
        assert_eq!(totals.errors, 1);
        assert_eq!(totals.proxy, 2);
        assert_eq!(totals.direct, 1);
    }

    #[test]
    fn traffic_series_groups_by_minute() {
        let c = mem();
        record_traffic(&c, 1000, "p1", Action::Proxy, Protocol::Tcp, 10, 20, 2, 0).unwrap();
        record_traffic(&c, 1000, "p1", Action::Direct, Protocol::Tcp, 5, 5, 1, 0).unwrap();
        record_traffic(&c, 1060, "p1", Action::Block, Protocol::Tcp, 0, 0, 3, 1).unwrap();
        let series = query_traffic_series(&c, 1000).unwrap();
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].minute_ts, 1000);
        assert_eq!(series[0].proxy, 2);
        assert_eq!(series[0].direct, 1);
        assert_eq!(series[0].bytes_up, 15);
        assert_eq!(series[1].block, 3);
        assert_eq!(series[1].errors, 1);
    }

    #[test]
    fn prune_and_clear_stats() {
        let c = mem();
        record_traffic(&c, 100, "p1", Action::Proxy, Protocol::Tcp, 1, 1, 1, 0).unwrap();
        record_traffic(&c, 999_999, "p1", Action::Proxy, Protocol::Tcp, 1, 1, 1, 0).unwrap();
        prune_stats(&c, 1000, 0).unwrap();
        assert_eq!(query_traffic_totals(&c, 0).unwrap().connections, 1);
        clear_stats(&c).unwrap();
        assert_eq!(query_traffic_totals(&c, 0).unwrap().connections, 0);
    }

    #[test]
    fn recovery_journal_single_active() {
        let c = mem();
        assert!(read_active_recovery(&c).unwrap().is_none());
        write_recovery_marker(&c, "{\"state\":\"active\"}").unwrap();
        write_recovery_marker(&c, "{\"state\":\"active2\"}").unwrap();
        // Only the latest marker is active.
        let (_, state) = read_active_recovery(&c).unwrap().unwrap();
        assert!(state.contains("active2"));
        clear_recovery(&c).unwrap();
        assert!(read_active_recovery(&c).unwrap().is_none());
    }
}
