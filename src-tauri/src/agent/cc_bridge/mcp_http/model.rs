use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

/// Which tool surface a CC thread's MCP endpoint exposes. Selected at spawn
/// from the bound session's type (E): a terminal/SSH/local thread gets `Shell`;
/// a SQL DB session (MySQL/PG/PanWeiDB/Oracle/SQL Server/ClickHouse/Presto) gets `Sql`; a Redis session
/// gets `Redis`. One listener serves all three at distinct nest paths, and a
/// thread's `.mcp.json` lists *only* its flavor's server — so a DB thread never
/// sees shell tools, and vice-versa (reduces cross-surface confusion).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    Shell,
    Sql,
    Redis,
    Control,
}

impl Flavor {
    /// Nest path this flavor's `StreamableHttpService` is mounted at. Shell keeps
    /// the legacy `/mcp` so the GUI-verified shell path is byte-for-byte
    /// unchanged.
    pub fn path(self) -> &'static str {
        match self {
            Flavor::Shell => "/mcp",
            Flavor::Sql => "/mcp/sql",
            Flavor::Redis => "/mcp/redis",
            Flavor::Control => "/mcp/control",
        }
    }

    /// Server name CC sees in `.mcp.json` (and thus in `mcp__<name>__<tool>`).
    pub fn server_name(self) -> &'static str {
        match self {
            Flavor::Shell => "taomni",
            Flavor::Sql => "taomni_sql",
            Flavor::Redis => "taomni_redis",
            Flavor::Control => "taomni_control",
        }
    }

    /// The `--permission-prompt-tool` name for this flavor's server.
    pub fn permission_prompt_tool(self) -> &'static str {
        match self {
            Flavor::Shell => "mcp__taomni__permission_prompt",
            Flavor::Sql => "mcp__taomni_sql__permission_prompt",
            Flavor::Redis => "mcp__taomni_redis__permission_prompt",
            Flavor::Control => "mcp__taomni_control__permission_prompt",
        }
    }

    /// Pick the MCP flavor for a thread from its bound session's type: SQL DB
    /// engines (MySQL/PG/PanWeiDB/Oracle/SQL Server/StarRocks/ClickHouse/Presto) →
    /// `Sql`, Redis → `Redis`, anything else (SSH/terminal/local/unbound) →
    /// `Shell`.
    pub fn for_session_type(t: Option<&crate::session::models::SessionType>) -> Flavor {
        use crate::session::models::SessionType;
        match t {
            Some(
                SessionType::MySQL
                | SessionType::PostgreSQL
                | SessionType::PanWeiDB
                | SessionType::Oracle
                | SessionType::SQLServer
                | SessionType::StarRocks
                | SessionType::ClickHouse
                | SessionType::Presto,
            ) => Flavor::Sql,
            Some(SessionType::Redis) => Flavor::Redis,
            _ => Flavor::Shell,
        }
    }
}

/// Trust tier inferred for a CC thread (D3). Local working dirs are lenient;
/// remote SSH sessions are strict. Surfaced to the UI; the safety pipeline
/// itself stays conservative regardless.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustLevel {
    Lenient,
    Strict,
}

impl TrustLevel {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            TrustLevel::Lenient => "lenient",
            TrustLevel::Strict => "strict",
        }
    }
}

/// Authorization scope bound to a single minted token (one per CC thread).
#[derive(Clone)]
pub struct TokenScope {
    pub thread_id: String,
    pub allowed_session_id: Option<String>,
    /// The saved `SessionConfig.id` of the bound session, when the thread is
    /// bound to one. Distinct from `allowed_session_id` (a terminal *tab id*):
    /// the session-identity card advertises *this* id to CC, so CC will often
    /// name it as `session_id`. Accepting it here (and normalizing it back to
    /// the canonical tab id in `fill_session_id`) keeps the card, the scope
    /// check, and the tools speaking one id space instead of three.
    pub allowed_config_id: Option<String>,
    pub trust: TrustLevel,
    /// Which tool surface this token's thread uses (Shell / Sql / Redis).
    pub flavor: Flavor,
    /// When true, read-only `Bash`/`run_in_terminal` commands still require a
    /// confirmation (3.6 noise-reduction disabled by config). Snapshotted from
    /// `CcBridgeConfig.confirm_readonly` at provision time.
    pub confirm_readonly: bool,
    /// Codex app-server calls MCP tools directly instead of using Claude
    /// Code's `--permission-prompt-tool` preflight. When this is true, write
    /// tools run the same permission pipeline inside the handler before
    /// executing.
    pub inline_permission: bool,
    /// Tools the user pre-approved for the rest of this session via the
    /// ActionCard's "allow for session" choice.
    pub session_approved: Arc<Mutex<HashSet<String>>>,
}

pub(crate) type TokenMap = Arc<Mutex<HashMap<String, TokenScope>>>;
