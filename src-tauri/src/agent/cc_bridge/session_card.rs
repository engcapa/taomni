//! Phase 3.S — the "session identity card" injected into Claude Code via
//! `--append-system-prompt-file`.
//!
//! Goal: CC reliably knows *which saved Taomni session a chat thread is bound
//! to* without having to call `list_sessions` to locate itself, and prefers the
//! remote `run_in_terminal` MCP tool over its built-in local Bash when the
//! binding is a remote host.
//!
//! Snapshot-at-spawn only: a `CcProcess`'s args are fixed for the thread's life
//! (it is spawned once and reused with `--resume`). That is fine here because
//! the binding identity is stable within a thread; the recent-command history
//! is a clearly-labelled start-of-session snapshot; and cwd — the only strongly
//! volatile field — is intentionally out of scope this round.
//!
//! This module is intentionally pure (no DB / no `AppHandle`): the caller reads
//! the `SessionConfig` and history, then redacts the rendered text. That keeps
//! it unit-testable and keeps `cc_bridge` free of `crate::vault::*` (see the
//! module warning in `cc_bridge/mod.rs`).

use crate::session::models::{SessionConfig, SessionType};

/// How many recent commands to snapshot into the card.
pub const HISTORY_LIMIT: usize = 15;

/// Replicate the frontend `makeHostKey` (`src/lib/history.ts`) so we read the
/// same `command_history` bucket the terminal wrote into. Format:
/// `ssh:{host_lowercase}:{port}:{username}` (username may be empty).
pub fn host_key_for(session: &SessionConfig) -> String {
    let user = session.username.clone().unwrap_or_default();
    format!(
        "ssh:{}:{}:{}",
        session.host.to_lowercase(),
        session.port,
        user
    )
}

/// Session types whose real work happens on a remote host, where CC should
/// prefer `run_in_terminal` / `sftp_upload` over its built-in local Bash.
fn is_remote(t: &SessionType) -> bool {
    matches!(
        t,
        SessionType::SSH | SessionType::Telnet | SessionType::SFTP | SessionType::Serial
    )
}

/// Render the (pre-redaction) card text.
///
/// - `session`: resolved bound session, or `None` for an unbound / local /
///   unsaved-tab thread (the card then states it is a local workspace thread).
/// - `thread_id`: the chat thread id, surfaced so CC can name itself.
/// - `linked`: whether the thread is bound to a live terminal tab — drives the
///   Strict-trust note, kept in sync with `mcp_http::provision_for_thread`
///   (linked ⇒ Strict ⇒ dangerous actions pause for confirmation).
/// - `recent`: newest-first recent commands on the session's host (may be empty).
pub fn render_card(
    session: Option<&SessionConfig>,
    thread_id: &str,
    linked: bool,
    recent: &[String],
) -> String {
    let mut s = String::from("[Taomni 会话绑定 / session binding]\n");
    match session {
        Some(sc) => {
            let user = sc.username.as_deref().unwrap_or("");
            let at = if user.is_empty() {
                String::new()
            } else {
                format!("{user}@")
            };
            s.push_str(&format!(
                "你当前绑定到已保存会话「{}」:{}{}:{}(类型 {},认证 {})。\n",
                sc.name,
                at,
                sc.host,
                sc.port,
                sc.session_type.as_str(),
                sc.auth_method.as_str()
            ));
            s.push_str(&format!(
                "SessionConfig id = {};聊天线程 thread = {};信任级 = {}。\n",
                sc.id,
                thread_id,
                if linked { "Strict" } else { "Lenient" }
            ));
            if is_remote(&sc.session_type) {
                s.push_str(
                    "这是远端会话:操作远端请用 MCP 工具 run_in_terminal / sftp_upload\
                     (危险动作会停下等用户确认),读回显用 read_terminal_tail;\
                     不要用本地 Bash 执行面向远端的命令。\n",
                );
            }
        }
        None => {
            // We could not resolve a saved SessionConfig. Be honest about what
            // we know rather than guessing remote-vs-local: a linked thread is
            // bound to a live terminal tab that simply was not opened from a
            // saved session (local shell or ad-hoc connect); an unlinked thread
            // is a global / workspace chat with no terminal at all.
            if linked {
                s.push_str(&format!(
                    "本线程已绑定到一个终端标签(thread = {thread_id}),但它未关联到已保存会话\
                     (可能是本地 shell 或临时连接),无法展示会话名 / 主机详情。\n"
                ));
            } else {
                s.push_str(&format!(
                    "本线程未绑定任何终端(全局 / 本地工作区线程;thread = {thread_id})。\n"
                ));
            }
        }
    }
    if !recent.is_empty() {
        s.push_str("该主机最近命令(会话开始时快照,新→旧):\n");
        for cmd in recent {
            s.push('-');
            s.push(' ');
            s.push_str(cmd);
            s.push('\n');
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::models::{AuthMethod, SessionType};

    fn sample(session_type: SessionType, username: Option<&str>, auth: AuthMethod) -> SessionConfig {
        SessionConfig {
            id: "sess-123".into(),
            name: "prod-db".into(),
            session_type,
            group_path: None,
            host: "Prod.Example.COM".into(),
            port: 2222,
            username: username.map(|s| s.to_string()),
            auth_method: auth,
            options_json: "{}".into(),
            created_at: 0,
            updated_at: 0,
            last_connected_at: None,
            sort_order: 0,
        }
    }

    #[test]
    fn host_key_matches_frontend_format() {
        let sc = sample(SessionType::SSH, Some("deploy"), AuthMethod::Agent);
        // lowercased host, raw port, raw username — mirrors makeHostKey().
        assert_eq!(host_key_for(&sc), "ssh:prod.example.com:2222:deploy");
    }

    #[test]
    fn host_key_empty_username() {
        let sc = sample(SessionType::SSH, None, AuthMethod::Password);
        assert_eq!(host_key_for(&sc), "ssh:prod.example.com:2222:");
    }

    #[test]
    fn card_bound_remote_has_identity_routing_and_history() {
        let sc = sample(
            SessionType::SSH,
            Some("deploy"),
            AuthMethod::PrivateKey {
                key_path: "/home/u/.ssh/id_ed25519".into(),
            },
        );
        let recent = vec!["systemctl status nginx".to_string(), "df -h".to_string()];
        let card = render_card(Some(&sc), "thread-9", true, &recent);

        // Identity: name, user@host:port, type, auth label.
        assert!(card.contains("「prod-db」"));
        assert!(card.contains("deploy@Prod.Example.COM:2222"));
        assert!(card.contains("类型 SSH"));
        assert!(card.contains("认证 PrivateKey"));
        // Self-identification.
        assert!(card.contains("SessionConfig id = sess-123"));
        assert!(card.contains("thread = thread-9"));
        // linked ⇒ Strict.
        assert!(card.contains("信任级 = Strict"));
        // Tool-routing disambiguation (folds in old "执行目标消歧").
        assert!(card.contains("run_in_terminal"));
        assert!(card.contains("不要用本地 Bash"));
        // History snapshot, newest first.
        assert!(card.contains("- systemctl status nginx"));
        assert!(card.contains("- df -h"));
        // The key_path secret must NOT leak (we only emit the label).
        assert!(!card.contains("id_ed25519"));
    }

    #[test]
    fn card_unbound_not_linked_is_global_local() {
        let card = render_card(None, "thread-local", false, &[]);
        assert!(card.contains("未绑定任何终端"));
        assert!(card.contains("thread = thread-local"));
        // No remote routing note when there is no remote session.
        assert!(!card.contains("run_in_terminal"));
    }

    #[test]
    fn card_linked_but_unsaved_is_honest() {
        // Bound to a live tab but no saved SessionConfig — don't claim local,
        // don't claim remote.
        let card = render_card(None, "t-quick", true, &[]);
        assert!(card.contains("未关联到已保存会话"));
        assert!(!card.contains("run_in_terminal"));
    }

    #[test]
    fn card_lenient_when_not_linked() {
        let sc = sample(SessionType::SSH, Some("u"), AuthMethod::Agent);
        let card = render_card(Some(&sc), "t", false, &[]);
        assert!(card.contains("信任级 = Lenient"));
    }

    #[test]
    fn card_local_session_type_omits_remote_routing() {
        let sc = sample(SessionType::LocalShell, None, AuthMethod::None);
        let card = render_card(Some(&sc), "t", false, &[]);
        assert!(!card.contains("run_in_terminal"));
    }
}
