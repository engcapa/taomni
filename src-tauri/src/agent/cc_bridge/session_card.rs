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

/// Shared guidance for any thread bound to a terminal — saved-remote,
/// saved-local, or a live tab with no saved session. Two jobs:
///
/// ① Routing: steer execution through the bound terminal's MCP tools
///    (`run_in_terminal` / `read_terminal_tail`) instead of CC's built-in local
///    Bash. `remote` adds the remote-only extras (`sftp_upload`, remote framing).
/// ② Env demotion: CC's native `<env>` (cwd / git / OS) only ever describes the
///    local host process that runs Taomni, never the bound session. Without this
///    note an un-anchored turn slides back to that local `<env>` + built-in Bash
///    (they sit in CC's higher-authority primary prompt and carry less friction).
///    So we explicitly relabel the native `<env>` as a host sandbox and point the
///    "where am I" question at the per-turn cwd / the bound terminal.
///
/// Not emitted for truly unbound threads: there the local `<env>` genuinely is
/// the working environment, so we leave CC's defaults alone.
fn push_terminal_routing(s: &mut String, remote: bool) {
    if remote {
        s.push_str(
            "操作该会话请用 MCP 工具 run_in_terminal / sftp_upload(危险动作会停下等用户确认),\
             读回显用 read_terminal_tail;不要用内置本地 Bash 执行面向该远端会话的命令。\n",
        );
    } else {
        s.push_str(
            "操作该会话请用 MCP 工具 run_in_terminal 执行命令(危险动作会停下等用户确认),\
             读回显用 read_terminal_tail;它们作用于这个绑定的终端、会继承其真实当前目录,\
             不要用内置本地 Bash 去做面向该会话的事。\n",
        );
    }
    s.push_str(
        "注意:你自带的本地 <env>(工作目录 / git 状态 / 操作系统)只是运行 Taomni 的宿主沙箱,\
         不是你的工作对象;你的真实工作目录以每轮提供的「当前工作目录」或绑定终端的实际目录为准,\
         不要据本地 <env> 判断你身处的环境。\n",
    );
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
            // ① + ② — bound to a saved session (remote or local): route through
            // the terminal MCP tools and demote CC's native local <env>.
            push_terminal_routing(&mut s, is_remote(&sc.session_type));
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
                // ① + ② — still bound to a live terminal. We don't know
                // remote-vs-local, so use the generic routing (no sftp); both
                // run_in_terminal and read_terminal_tail act on the live tab.
                push_terminal_routing(&mut s, false);
            } else {
                // Truly unbound global / workspace thread — no terminal at all.
                // Here CC's native <env> genuinely is the environment, so we
                // intentionally emit no routing / env-demotion guidance.
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
        // ① Tool-routing disambiguation — remote variant mentions sftp_upload.
        assert!(card.contains("run_in_terminal"));
        assert!(card.contains("sftp_upload"));
        assert!(card.contains("不要用内置本地 Bash"));
        // ② Native <env> is demoted to a host sandbox.
        assert!(card.contains("宿主沙箱"));
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
        // Truly unbound: no routing and NO env-demotion — CC's native <env> is
        // the real environment here, so we leave its defaults alone.
        assert!(!card.contains("run_in_terminal"));
        assert!(!card.contains("宿主沙箱"));
    }

    #[test]
    fn card_linked_but_unsaved_routes_and_demotes_env() {
        // Bound to a live tab but no saved SessionConfig — still a terminal, so
        // ① route through it and ② demote the native <env>. Unknown remote/local
        // ⇒ generic variant (no sftp_upload).
        let card = render_card(None, "t-quick", true, &[]);
        assert!(card.contains("未关联到已保存会话"));
        assert!(card.contains("run_in_terminal"));
        assert!(!card.contains("sftp_upload"));
        assert!(card.contains("宿主沙箱"));
    }

    #[test]
    fn card_lenient_when_not_linked() {
        let sc = sample(SessionType::SSH, Some("u"), AuthMethod::Agent);
        let card = render_card(Some(&sc), "t", false, &[]);
        assert!(card.contains("信任级 = Lenient"));
    }

    #[test]
    fn card_local_bound_session_routes_to_terminal() {
        // ① Local-bound saved session now gets routing too (previously silent),
        // via the generic variant — run_in_terminal but no remote sftp_upload —
        // and ② the native <env> demotion.
        let sc = sample(SessionType::LocalShell, None, AuthMethod::None);
        let card = render_card(Some(&sc), "t", false, &[]);
        assert!(card.contains("run_in_terminal"));
        assert!(!card.contains("sftp_upload"));
        assert!(card.contains("宿主沙箱"));
    }
}
