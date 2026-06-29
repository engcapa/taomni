//! Phase 3.S — the "session identity card" injected into Claude Code via
//! `--append-system-prompt-file`.
//!
//! Goal: CC reliably knows *which saved Taomni session a chat thread is bound
//! to* without having to call `list_sessions` to locate itself, and treats that
//! bound session as the sole target of all its work — routing every operation
//! through the terminal MCP tools instead of its built-in local Bash / file
//! tools, which only ever touch the unrelated Taomni host.
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
use serde::{Deserialize, Serialize};

/// How many recent commands to snapshot into the card.
pub const HISTORY_LIMIT: usize = 15;

/// Facts the frontend knows about a live local terminal tab. This is separate
/// from `SessionConfig`: ad-hoc local terminals often have no saved session,
/// and the backend only learns the actually launched shell id after PTY spawn.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTerminalEnv {
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub shell_id: Option<String>,
    #[serde(default)]
    pub shell_name: Option<String>,
    #[serde(default)]
    pub shell_args: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
}

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
/// prefer `run_in_terminal` / SFTP tools over its built-in local Bash.
fn is_remote(t: &SessionType) -> bool {
    matches!(
        t,
        SessionType::SSH
            | SessionType::Telnet
            | SessionType::Rlogin
            | SessionType::FTP
            | SessionType::SFTP
            | SessionType::Serial
            | SessionType::Mosh
    )
}

/// Which DB MCP flavor (if any) a bound session uses — drives the routing block
/// so a DB thread is steered to its SQL/Redis tools, not the terminal tools its
/// `.mcp.json` doesn't even expose (Phase 6).
enum DbRouting {
    /// MySQL / PostgreSQL / SQL Server / StarRocks / ClickHouse / Presto — the `taomni_sql` tools.
    Sql,
    /// Redis — the `taomni_redis` tools.
    Redis,
    /// Not a DB session — use the terminal routing.
    None,
}

fn db_routing(t: &SessionType) -> DbRouting {
    match t {
        SessionType::MySQL
        | SessionType::PostgreSQL
        | SessionType::SQLServer
        | SessionType::StarRocks
        | SessionType::ClickHouse
        | SessionType::Presto => DbRouting::Sql,
        SessionType::Redis => DbRouting::Redis,
        _ => DbRouting::None,
    }
}

/// Routing block for a thread bound to a SQL database session. CC's `.mcp.json`
/// for this thread exposes *only* the `taomni_sql` tools, so steer every "look
/// at the data / schema / run a query" intent through them — never CC's built-in
/// local Bash / Read (which only touch the unrelated Taomni host), and never the
/// terminal tools (which this thread doesn't have).
fn push_sql_routing(s: &mut String, engine: &str) {
    s.push_str(&format!(
        "本线程绑定的是一个 {engine} 数据库连接。你的一切操作都针对这个连接,\
         用 SQL MCP 工具完成,不要用你内置的本地 Bash/Read/Glob,也没有终端工具。\n"
    ));
    s.push_str(
        "查看结构:list_schemas / list_tables / describe_table / list_indexes / list_objects / \
         object_ddl / table_stats(Presto 还有 list_catalogs)。\n",
    );
    s.push_str(
        "执行查询:run_sql(返回有界结果,只读语句自动放行,写/DDL 会停下等用户确认)。\
         结果很大时用 run_sql_captured 完整捕获、再用 read_result(op=head/tail/range/grep/stats)\
         按需检索,需要落盘用 export_result;不要为了再看一遍而重跑查询。\n",
    );
    s.push_str(
        "你自带的 <env>(工作目录 / git / 操作系统)只描述运行 Taomni 的宿主沙箱,与这个数据库无关;\
         「有哪些表 / 这列什么类型 / 数据长什么样」一律用上面的工具查,不要据本地 <env> 作答。\n",
    );
}

/// Routing block for a thread bound to a Redis session — only the
/// `taomni_redis` tools are exposed.
fn push_redis_routing(s: &mut String) {
    s.push_str(
        "本线程绑定的是一个 Redis 连接。你的一切操作都针对这个连接,用 Redis MCP 工具完成,\
         不要用你内置的本地 Bash/Read,也没有终端工具。\n",
    );
    s.push_str(
        "扫描键:redis_list_keys(按 pattern 分页);读值:redis_get_key;\
         写/删:redis_set_key / redis_del_key(写动作,会停下等用户确认);\
         其他命令:redis_exec(读命令自动放行,写命令需确认)。\n",
    );
    s.push_str(
        "你自带的 <env> 只描述运行 Taomni 的宿主沙箱,与这个 Redis 实例无关;\
         「有哪些键 / 某键的值」一律用上面的工具查。\n",
    );
}

fn push_control_plane_guidance(s: &mut String) {
    s.push_str(
        "Taomni 还提供独立的 taomni_control MCP 控制面,用于操作 Taomni UI、已保存会话和标签页。\
         它不受当前终端/数据库绑定限制;绑定限制只适用于终端、SQL、Redis 等领域工具。\n",
    );
    s.push_str(
        "当用户要求打开/切换到某个已保存会话、打开会话编辑器、复制/关闭/重命名/切换标签页时,\
         你必须调用 taomni_control 的 session_open / session_open_editor / tab_* 工具完成,\
         不要只告诉用户去侧边栏双击或手动操作。找不到唯一目标时先用 session_list 查询并让用户澄清。\n",
    );
}

/// Shared guidance for any thread bound to a terminal — saved-remote,
/// saved-local, or a live tab with no saved session. It states one *uniform*
/// operating principle (not a per-field hint): every operation in this thread
/// targets the bound session, so "current dir / files / processes / env"
/// questions are all about that session and are answered through the terminal
/// MCP tools. Two jobs fall out of that:
///
/// ① Routing: steer execution through the bound terminal's MCP tools
///    (`run_in_terminal` / `read_terminal_tail`) instead of CC's built-in local
///    Bash / file tools. `remote` adds the remote-only extras
///    (`sftp_upload` / `sftp_download`).
/// ② Env demotion: CC's native `<env>` (cwd / git / OS) only ever describes the
///    local host process that runs Taomni, never the bound session. Without this
///    note an un-anchored turn slides back to that local `<env>` + built-in Bash
///    (they sit in CC's higher-authority primary prompt and carry less friction)
///    — observed in practice: a bare "查询当前目录" was answered by running `ls`
///    on the Taomni host. So we relabel the native `<env>` as a host sandbox and
///    point every "where am I / what's here" question at the bound terminal.
///
/// Not emitted for truly unbound threads: there the local `<env>` genuinely is
/// the working environment, so we leave CC's defaults alone.
fn push_terminal_routing(s: &mut String, remote: bool) {
    // Uniform principle first, so CC doesn't treat "查询当前目录 / 看文件 / 看进程"
    // as inspecting its own (local) environment and reach for built-in Bash.
    s.push_str(
        "本线程的一切操作都针对上面这个绑定的会话:你遇到的任何「当前目录 / 文件 / 进程 / 环境」\
         问题都是指这个会话,而不是运行 Taomni 的本机。\n",
    );
    if remote {
        s.push_str(
            "统一用 MCP 工具操作它:执行命令用 run_in_terminal、读回显用 read_terminal_tail、\
             上传文件用 sftp_upload(单个用 local_path,多个用 local_paths;危险动作会停下等用户确认),下载文件用 sftp_download;\
             它们作用于这个绑定终端、\
             继承其真实当前目录。\n",
        );
    } else {
        s.push_str(
            "统一用 MCP 工具操作它:执行命令用 run_in_terminal、读回显用 read_terminal_tail\
             (危险动作会停下等用户确认);它们作用于这个绑定终端、继承其真实当前目录。\n",
        );
    }
    s.push_str(
        "不要用你内置的本地 Bash / Read / Glob / Grep 去访问本机文件系统来回答这些问题——\
         那是另一个执行环境(运行 Taomni / Claude Code 的宿主沙箱),不是这个绑定终端会话。\n",
    );
    s.push_str(
        "你自带的 <env>(工作目录 / git 状态 / 操作系统)只描述那台宿主沙箱;判断\
         「我在哪 / 当前目录是什么」一律以绑定终端的实际状态(用 run_in_terminal 查)\
         或每轮提供的「当前工作目录」为准,不要据本地 <env> 作答。\n",
    );
    // 方案4 — output-volume discipline. run_in_terminal is fire-and-forget and
    // read_terminal_tail only returns a scrollback *tail*, so large output
    // loses its head/middle. Steer big-output work to run_captured (full
    // capture) + read_capture (grep/page) instead of dumping + tailing.
    s.push_str(
        "当命令可能产生大量输出(日志、扫描、跑脚本等),不要用 run_in_terminal 直接 dump 再 \
         read_terminal_tail 取尾巴——那样会丢失开头和中间。改用 run_captured 运行并完整捕获,\
         再用 read_capture(op=grep/head/tail/range/jq/stats)按需检索,不要为了再看一遍而重跑命令。\n",
    );
}

fn clean_opt(value: Option<&String>) -> Option<&str> {
    value.map(|s| s.trim()).filter(|s| !s.is_empty())
}

fn shell_syntax_hint(shell_id: Option<&str>, shell_name: Option<&str>) -> Option<&'static str> {
    let mut haystack = String::new();
    if let Some(id) = shell_id {
        haystack.push_str(id);
    }
    haystack.push(' ');
    if let Some(name) = shell_name {
        haystack.push_str(name);
    }
    let lower = haystack.to_lowercase();
    if lower.contains("powershell") || lower.contains("pwsh") {
        Some("命令语法按 PowerShell 生成;不要默认使用 POSIX bash 语法。")
    } else if lower.contains("command-prompt") || lower.contains("cmd") {
        Some("命令语法按 Windows cmd.exe 生成;不要默认使用 POSIX bash 语法。")
    } else if lower.contains("wsl") {
        Some("这是 WSL 入口;终端内命令语法通常按该 WSL Linux 发行版的 shell 生成。")
    } else if lower.contains("git-bash")
        || lower.contains("bash")
        || lower.contains("zsh")
        || lower.contains("sh")
    {
        Some("命令语法可按 POSIX shell 生成。")
    } else {
        None
    }
}

fn push_local_terminal_environment(s: &mut String, env: &LocalTerminalEnv) {
    let platform = clean_opt(env.platform.as_ref());
    let shell_id = clean_opt(env.shell_id.as_ref());
    let shell_name = clean_opt(env.shell_name.as_ref());
    let cwd = clean_opt(env.cwd.as_ref());
    let has_args = env
        .shell_args
        .as_ref()
        .map(|args| args.iter().any(|arg| !arg.trim().is_empty()))
        .unwrap_or(false);

    if platform.is_none()
        && shell_id.is_none()
        && shell_name.is_none()
        && cwd.is_none()
        && !has_args
    {
        return;
    }

    s.push_str("[本地终端环境 / local terminal environment]\n");
    s.push_str("这个绑定目标是用户本机上的 live local terminal,不是远程 SSH 会话。\n");
    if let Some(platform) = platform {
        s.push_str(&format!("宿主平台: {platform}。\n"));
    }
    match (shell_name, shell_id) {
        (Some(name), Some(id)) => s.push_str(&format!("Shell: {name}(id={id})。\n")),
        (Some(name), None) => s.push_str(&format!("Shell: {name}。\n")),
        (None, Some(id)) => s.push_str(&format!("Shell id: {id}。\n")),
        (None, None) => {}
    }
    if has_args {
        let args = env
            .shell_args
            .as_ref()
            .map(|args| {
                args.iter()
                    .map(|arg| arg.trim())
                    .filter(|arg| !arg.is_empty())
                    .take(8)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        if !args.is_empty() {
            s.push_str(&format!("启动参数: {args}。\n"));
        }
    }
    if let Some(cwd) = cwd {
        s.push_str(&format!(
            "当前工作目录快照: {cwd};若每轮消息另有「当前工作目录」,以每轮值为准。\n"
        ));
    }
    if let Some(hint) = shell_syntax_hint(shell_id, shell_name) {
        s.push_str(hint);
        s.push('\n');
    }
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
    local_env: Option<&LocalTerminalEnv>,
) -> String {
    let mut s = String::from("[Taomni 会话绑定 / session binding]\n");
    push_control_plane_guidance(&mut s);
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
            // Routing depends on the session kind: DB sessions (Phase 6) get
            // their SQL/Redis MCP tools, everything else routes through the
            // terminal MCP tools. In all cases CC's native local <env> is
            // demoted to "the host sandbox", not the work target.
            match db_routing(&sc.session_type) {
                DbRouting::Sql => push_sql_routing(&mut s, sc.session_type.as_str()),
                DbRouting::Redis => push_redis_routing(&mut s),
                DbRouting::None => {
                    let remote = is_remote(&sc.session_type);
                    if !remote {
                        if let Some(env) = local_env {
                            push_local_terminal_environment(&mut s, env);
                        }
                    }
                    push_terminal_routing(&mut s, remote);
                }
            }
        }
        None => {
            // We could not resolve a saved SessionConfig. Be honest about what
            // we know rather than guessing remote-vs-local: a linked thread is
            // bound to a live terminal tab that simply was not opened from a
            // saved session (local shell or ad-hoc connect); an unlinked thread
            // is a global / workspace chat with no terminal at all.
            if linked {
                if local_env.is_some() {
                    s.push_str(&format!(
                        "本线程已绑定到一个本地终端标签(thread = {thread_id}),但它未关联到已保存会话。\n"
                    ));
                } else {
                    s.push_str(&format!(
                        "本线程已绑定到一个终端标签(thread = {thread_id}),但它未关联到已保存会话\
                         (可能是本地 shell 或临时连接),无法展示会话名 / 主机详情。\n"
                    ));
                }
                if let Some(env) = local_env {
                    push_local_terminal_environment(&mut s, env);
                }
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

    fn sample(
        session_type: SessionType,
        username: Option<&str>,
        auth: AuthMethod,
    ) -> SessionConfig {
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
        let card = render_card(Some(&sc), "thread-9", true, &recent, None);

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
        assert!(card.contains("内置的本地 Bash"));
        // Uniform operating principle (not just one field).
        assert!(card.contains("本线程的一切操作都针对"));
        assert!(card.contains("当前目录 / 文件 / 进程 / 环境"));
        // ② Native <env> is demoted to a host sandbox.
        assert!(card.contains("宿主沙箱"));
        // 方案4 — large-output discipline steers to run_captured + read_capture.
        assert!(card.contains("run_captured"));
        assert!(card.contains("read_capture"));
        // History snapshot, newest first.
        assert!(card.contains("- systemctl status nginx"));
        assert!(card.contains("- df -h"));
        // The key_path secret must NOT leak (we only emit the label).
        assert!(!card.contains("id_ed25519"));
    }

    #[test]
    fn card_unbound_not_linked_is_global_local() {
        let card = render_card(None, "thread-local", false, &[], None);
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
        let card = render_card(None, "t-quick", true, &[], None);
        assert!(card.contains("未关联到已保存会话"));
        assert!(card.contains("run_in_terminal"));
        assert!(!card.contains("sftp_upload"));
        assert!(card.contains("宿主沙箱"));
    }

    #[test]
    fn card_unsaved_local_includes_local_terminal_environment() {
        let env = LocalTerminalEnv {
            platform: Some("windows".into()),
            shell_id: Some("powershell".into()),
            shell_name: Some("PowerShell".into()),
            shell_args: Some(vec!["-NoLogo".into()]),
            cwd: Some("C:\\Users\\zhyha".into()),
        };
        let card = render_card(None, "t-local", true, &[], Some(&env));
        assert!(card.contains("本地终端标签"));
        assert!(card.contains("live local terminal"));
        assert!(card.contains("宿主平台: windows"));
        assert!(card.contains("Shell: PowerShell(id=powershell)"));
        assert!(card.contains("启动参数: -NoLogo"));
        assert!(card.contains("C:\\Users\\zhyha"));
        assert!(card.contains("命令语法按 PowerShell"));
        assert!(card.contains("run_in_terminal"));
        assert!(!card.contains("sftp_upload"));
    }

    #[test]
    fn card_remote_session_ignores_local_terminal_environment() {
        let sc = sample(SessionType::SSH, Some("deploy"), AuthMethod::Agent);
        let env = LocalTerminalEnv {
            platform: Some("windows".into()),
            shell_id: Some("powershell".into()),
            shell_name: Some("PowerShell".into()),
            shell_args: None,
            cwd: Some("C:\\Users\\zhyha".into()),
        };
        let card = render_card(Some(&sc), "t-ssh", true, &[], Some(&env));
        assert!(card.contains("deploy@Prod.Example.COM:2222"));
        assert!(card.contains("sftp_upload"));
        assert!(!card.contains("live local terminal"));
        assert!(!card.contains("PowerShell(id=powershell)"));
        assert!(!card.contains("C:\\Users\\zhyha"));
    }

    #[test]
    fn card_lenient_when_not_linked() {
        let sc = sample(SessionType::SSH, Some("u"), AuthMethod::Agent);
        let card = render_card(Some(&sc), "t", false, &[], None);
        assert!(card.contains("信任级 = Lenient"));
    }

    #[test]
    fn card_local_bound_session_routes_to_terminal() {
        // ① Local-bound saved session now gets routing too (previously silent),
        // via the generic variant — run_in_terminal but no remote sftp_upload —
        // and ② the native <env> demotion.
        let sc = sample(SessionType::LocalShell, None, AuthMethod::None);
        let card = render_card(Some(&sc), "t", false, &[], None);
        assert!(card.contains("run_in_terminal"));
        assert!(!card.contains("sftp_upload"));
        assert!(card.contains("宿主沙箱"));
    }

    #[test]
    fn card_sql_session_routes_to_sql_tools_not_terminal() {
        // A SQL DB session's thread only has the taomni_sql tools, so the card
        // must steer to them and must NOT mention the terminal tools (which the
        // thread's .mcp.json doesn't expose).
        for engine in [
            SessionType::MySQL,
            SessionType::PostgreSQL,
            SessionType::SQLServer,
            SessionType::StarRocks,
            SessionType::ClickHouse,
            SessionType::Presto,
        ] {
            let label = engine.as_str().to_string();
            let sc = sample(engine, Some("dba"), AuthMethod::Password);
            let card = render_card(Some(&sc), "t-sql", true, &[], None);
            assert!(card.contains(&label), "card should name the engine {label}");
            assert!(card.contains("run_sql"), "{label}: should mention run_sql");
            assert!(card.contains("describe_table"), "{label}: schema tools");
            assert!(
                card.contains("run_sql_captured"),
                "{label}: big-result guidance"
            );
            assert!(
                !card.contains("run_in_terminal"),
                "{label}: no terminal tool"
            );
            assert!(!card.contains("sftp_upload"), "{label}: no sftp");
            assert!(card.contains("宿主沙箱"), "{label}: <env> still demoted");
        }
    }

    #[test]
    fn card_redis_session_routes_to_redis_tools() {
        let sc = sample(SessionType::Redis, None, AuthMethod::Password);
        let card = render_card(Some(&sc), "t-redis", true, &[], None);
        assert!(card.contains("Redis"));
        assert!(card.contains("redis_list_keys"));
        assert!(card.contains("redis_get_key"));
        assert!(!card.contains("run_in_terminal"));
        assert!(!card.contains("run_sql"));
    }
}
