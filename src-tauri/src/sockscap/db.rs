//! sockscap.db persistence: profiles, rule sources, recovery journal, stats hooks.
//!
//! Design plan §10 / §13 Phase 3. Kept separate from taomni.db so high-frequency
//! stats writes cannot lock the main session store.

use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::{Deserialize, Serialize};

use crate::sockscap::types::{
    DnsMode, EgressFailureAction, EgressKind, ProfileScope, RouteAction, RoutingProfileDraft,
    UdpPolicy,
};

pub fn init_db(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS routing_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 100,
            scope TEXT NOT NULL,
            app_selectors_json TEXT NOT NULL DEFAULT '[]',
            include_children INTEGER NOT NULL DEFAULT 1,
            egress_kind TEXT,
            egress_ref_id TEXT,
            egress_failure_action TEXT NOT NULL DEFAULT 'fail_open',
            default_action TEXT NOT NULL DEFAULT 'direct',
            dns_mode TEXT NOT NULL DEFAULT 'system_capture',
            unknown_domain_action TEXT NOT NULL DEFAULT 'direct',
            udp_policy TEXT NOT NULL DEFAULT 'block',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rule_sources (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            url TEXT,
            last_good_path TEXT,
            last_success_unix INTEGER,
            last_mirror TEXT,
            last_sha256 TEXT,
            last_error TEXT,
            parse_stats_json TEXT
        );

        CREATE TABLE IF NOT EXISTS profile_rule_sources (
            profile_id TEXT NOT NULL,
            source_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (profile_id, source_id),
            FOREIGN KEY (profile_id) REFERENCES routing_profiles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS custom_rules (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            action TEXT NOT NULL,
            kind TEXT NOT NULL,
            pattern TEXT NOT NULL,
            original TEXT NOT NULL,
            FOREIGN KEY (profile_id) REFERENCES routing_profiles(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS engine_recovery_journal (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            marker TEXT NOT NULL,
            state TEXT NOT NULL,
            detail TEXT,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS traffic_minute_buckets (
            bucket_unix INTEGER NOT NULL,
            profile_id TEXT NOT NULL,
            action TEXT NOT NULL,
            protocol TEXT NOT NULL,
            bytes_up INTEGER NOT NULL DEFAULT 0,
            bytes_down INTEGER NOT NULL DEFAULT 0,
            connections INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (bucket_unix, profile_id, action, protocol)
        );
        "#,
    )?;

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))?;
    if count == 0 {
        conn.execute("INSERT INTO schema_version (version) VALUES (?1)", params![1i64])?;
    }
    Ok(())
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn scope_str(s: ProfileScope) -> &'static str {
    match s {
        ProfileScope::Global => "global",
        ProfileScope::Applications => "applications",
        ProfileScope::RuntimeProcesses => "runtime_processes",
    }
}

fn scope_parse(s: &str) -> ProfileScope {
    match s {
        "global" => ProfileScope::Global,
        "runtime_processes" => ProfileScope::RuntimeProcesses,
        _ => ProfileScope::Applications,
    }
}

fn action_str(a: RouteAction) -> &'static str {
    match a {
        RouteAction::Direct => "direct",
        RouteAction::Proxy => "proxy",
        RouteAction::Block => "block",
    }
}

fn action_parse(s: &str) -> RouteAction {
    match s {
        "proxy" => RouteAction::Proxy,
        "block" => RouteAction::Block,
        _ => RouteAction::Direct,
    }
}

fn egress_kind_str(k: Option<EgressKind>) -> Option<&'static str> {
    k.map(|k| match k {
        EgressKind::ProxySession => "proxy_session",
        EgressKind::SshJump => "ssh_jump",
    })
}

fn egress_kind_parse(s: Option<String>) -> Option<EgressKind> {
    match s.as_deref() {
        Some("proxy_session") => Some(EgressKind::ProxySession),
        Some("ssh_jump") => Some(EgressKind::SshJump),
        _ => None,
    }
}

pub fn upsert_profile(conn: &Connection, p: &RoutingProfileDraft) -> SqlResult<()> {
    let now = now_unix();
    let selectors = serde_json::to_string(&p.app_selectors).unwrap_or_else(|_| "[]".into());
    conn.execute(
        r#"
        INSERT INTO routing_profiles (
            id, name, enabled, priority, scope, app_selectors_json, include_children,
            egress_kind, egress_ref_id, egress_failure_action, default_action,
            dns_mode, unknown_domain_action, udp_policy, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7,
            ?8, ?9, ?10, ?11,
            ?12, ?13, ?14, ?15, ?15
        )
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            enabled=excluded.enabled,
            priority=excluded.priority,
            scope=excluded.scope,
            app_selectors_json=excluded.app_selectors_json,
            include_children=excluded.include_children,
            egress_kind=excluded.egress_kind,
            egress_ref_id=excluded.egress_ref_id,
            egress_failure_action=excluded.egress_failure_action,
            default_action=excluded.default_action,
            dns_mode=excluded.dns_mode,
            unknown_domain_action=excluded.unknown_domain_action,
            udp_policy=excluded.udp_policy,
            updated_at=excluded.updated_at
        "#,
        params![
            p.id,
            p.name,
            p.enabled as i64,
            p.priority as i64,
            scope_str(p.scope),
            selectors,
            p.include_children as i64,
            egress_kind_str(p.egress_kind),
            p.egress_ref_id,
            match p.egress_failure_action {
                EgressFailureAction::FailOpen => "fail_open",
                EgressFailureAction::FailClosed => "fail_closed",
            },
            action_str(p.default_action),
            match p.dns_mode {
                DnsMode::SystemCapture => "system_capture",
                DnsMode::VirtualDns => "virtual_dns",
                DnsMode::StrictProxy => "strict_proxy",
            },
            action_str(p.unknown_domain_action),
            match p.udp_policy {
                UdpPolicy::ProxyIfSupported => "proxy_if_supported",
                UdpPolicy::Direct => "direct",
                UdpPolicy::Block => "block",
            },
            now,
        ],
    )?;
    Ok(())
}

pub fn list_profiles(conn: &Connection) -> SqlResult<Vec<RoutingProfileDraft>> {
    let mut stmt = conn.prepare(
        r#"
        SELECT id, name, enabled, priority, scope, app_selectors_json, include_children,
               egress_kind, egress_ref_id, egress_failure_action, default_action,
               dns_mode, unknown_domain_action, udp_policy
        FROM routing_profiles
        ORDER BY priority ASC, name ASC
        "#,
    )?;
    let rows = stmt.query_map([], |row| {
        let selectors_json: String = row.get(5)?;
        let selectors: Vec<String> =
            serde_json::from_str(&selectors_json).unwrap_or_default();
        let egress_kind: Option<String> = row.get(7)?;
        let fail: String = row.get(9)?;
        let dns: String = row.get(11)?;
        let udp: String = row.get(13)?;
        Ok(RoutingProfileDraft {
            id: row.get(0)?,
            name: row.get(1)?,
            enabled: row.get::<_, i64>(2)? != 0,
            priority: row.get::<_, i64>(3)? as u32,
            scope: scope_parse(&row.get::<_, String>(4)?),
            app_selectors: selectors,
            include_children: row.get::<_, i64>(6)? != 0,
            egress_kind: egress_kind_parse(egress_kind),
            egress_ref_id: row.get(8)?,
            egress_failure_action: if fail == "fail_closed" {
                EgressFailureAction::FailClosed
            } else {
                EgressFailureAction::FailOpen
            },
            default_action: action_parse(&row.get::<_, String>(10)?),
            dns_mode: match dns.as_str() {
                "virtual_dns" => DnsMode::VirtualDns,
                "strict_proxy" => DnsMode::StrictProxy,
                _ => DnsMode::SystemCapture,
            },
            unknown_domain_action: action_parse(&row.get::<_, String>(12)?),
            udp_policy: match udp.as_str() {
                "proxy_if_supported" => UdpPolicy::ProxyIfSupported,
                "direct" => UdpPolicy::Direct,
                _ => UdpPolicy::Block,
            },
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn delete_profile(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM routing_profiles WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_profile(conn: &Connection, id: &str) -> SqlResult<Option<RoutingProfileDraft>> {
    let all = list_profiles(conn)?;
    Ok(all.into_iter().find(|p| p.id == id))
}

// --- Recovery journal -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJournal {
    pub marker: String,
    pub state: String,
    pub detail: Option<String>,
    pub updated_at: i64,
}

pub fn write_recovery_journal(
    conn: &Connection,
    marker: &str,
    state: &str,
    detail: Option<&str>,
) -> SqlResult<()> {
    conn.execute(
        r#"
        INSERT INTO engine_recovery_journal (id, marker, state, detail, updated_at)
        VALUES (1, ?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET
            marker=excluded.marker,
            state=excluded.state,
            detail=excluded.detail,
            updated_at=excluded.updated_at
        "#,
        params![marker, state, detail, now_unix()],
    )?;
    Ok(())
}

pub fn read_recovery_journal(conn: &Connection) -> SqlResult<Option<RecoveryJournal>> {
    conn.query_row(
        "SELECT marker, state, detail, updated_at FROM engine_recovery_journal WHERE id = 1",
        [],
        |row| {
            Ok(RecoveryJournal {
                marker: row.get(0)?,
                state: row.get(1)?,
                detail: row.get(2)?,
                updated_at: row.get(3)?,
            })
        },
    )
    .optional()
}

pub fn clear_recovery_journal(conn: &Connection) -> SqlResult<()> {
    conn.execute("DELETE FROM engine_recovery_journal WHERE id = 1", [])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sockscap::types::{EgressKind, ProfileScope, RouteAction};

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_db(&c).unwrap();
        c
    }

    #[test]
    fn profile_roundtrip() {
        let c = mem();
        let p = RoutingProfileDraft {
            id: "p1".into(),
            name: "Apps".into(),
            enabled: true,
            priority: 10,
            scope: ProfileScope::Applications,
            app_selectors: vec!["/usr/bin/curl".into()],
            include_children: true,
            egress_kind: Some(EgressKind::ProxySession),
            egress_ref_id: Some("proxy-1".into()),
            default_action: RouteAction::Proxy,
            ..Default::default()
        };
        upsert_profile(&c, &p).unwrap();
        let list = list_profiles(&c).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].app_selectors, vec!["/usr/bin/curl".to_string()]);
        assert_eq!(list[0].egress_kind, Some(EgressKind::ProxySession));
        delete_profile(&c, "p1").unwrap();
        assert!(list_profiles(&c).unwrap().is_empty());
    }

    #[test]
    fn recovery_journal_roundtrip() {
        let c = mem();
        assert!(read_recovery_journal(&c).unwrap().is_none());
        write_recovery_journal(&c, "active", "Active", Some("installed")).unwrap();
        let j = read_recovery_journal(&c).unwrap().unwrap();
        assert_eq!(j.marker, "active");
        assert_eq!(j.state, "Active");
        clear_recovery_journal(&c).unwrap();
        assert!(read_recovery_journal(&c).unwrap().is_none());
    }
}
