use crate::agent::cc_bridge::mcp_http::Flavor;
use crate::agent::cc_bridge::session_card::{self, LocalTerminalEnv};
use crate::session::models::SessionConfig;
use crate::state::AppState;
use serde::{Deserialize, Serialize};

pub const SELECTABLE_DB_OBJECT_KINDS: &[&str] = &["table", "view", "materialized_view"];
const SUPPORTED_DB_OBJECT_KINDS: &[&str] = &[
    "table",
    "view",
    "materialized_view",
    "procedure",
    "function",
    "trigger",
    "event",
    "sequence",
    "dictionary",
];
const MAX_SELECTED_DB_OBJECTS: usize = 128;
const MAX_CODE_WORKSPACE_PATHS: usize = 64;
const MAX_CODE_WORKSPACE_PATH_LEN: usize = 512;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentDbSelectedObject {
    #[serde(default)]
    pub catalog: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(alias = "table")]
    pub name: String,
    pub kind: String,
}

impl AgentDbSelectedObject {
    pub fn normalized(&self) -> Option<Self> {
        let name = self.name.trim();
        if name.is_empty() {
            return None;
        }
        let kind = self.kind.trim();
        if !SUPPORTED_DB_OBJECT_KINDS.contains(&kind) {
            return None;
        }
        Some(Self {
            catalog: clean_opt(self.catalog.as_deref()),
            schema: clean_opt(self.schema.as_deref()),
            name: name.to_string(),
            kind: kind.to_string(),
        })
    }

    pub fn is_selectable(&self) -> bool {
        SELECTABLE_DB_OBJECT_KINDS.contains(&self.kind.as_str())
    }

    pub fn display_name(&self) -> String {
        let mut parts = Vec::new();
        if let Some(catalog) = self
            .catalog
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(catalog);
        }
        if let Some(schema) = self
            .schema
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(schema);
        }
        parts.push(self.name.trim());
        parts.join(".")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodeWorkspace {
    pub repo_root: String,
    #[serde(default)]
    pub active_path: Option<String>,
    #[serde(default)]
    pub open_paths: Vec<String>,
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

impl AgentCodeWorkspace {
    pub fn normalized(&self) -> Option<Self> {
        let repo_root = self.repo_root.trim();
        if repo_root.is_empty() {
            return None;
        }
        Some(Self {
            repo_root: repo_root.to_string(),
            active_path: self
                .active_path
                .as_deref()
                .and_then(clean_code_workspace_path),
            open_paths: normalize_code_workspace_paths(&self.open_paths),
            dirty_paths: normalize_code_workspace_paths(&self.dirty_paths),
        })
    }
}

fn clean_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn clean_code_workspace_path(value: &str) -> Option<String> {
    let path = value.trim().replace('\\', "/");
    if path.is_empty()
        || path.starts_with('/')
        || path.contains(':')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.len() > MAX_CODE_WORKSPACE_PATH_LEN
    {
        return None;
    }
    Some(path)
}

fn normalize_code_workspace_paths(paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for path in paths {
        let Some(clean) = clean_code_workspace_path(path) else {
            continue;
        };
        if out.iter().any(|existing| existing == &clean) {
            continue;
        }
        out.push(clean);
        if out.len() >= MAX_CODE_WORKSPACE_PATHS {
            break;
        }
    }
    out
}

/// Per-turn execution context shared by Claude Code, Codex app-server, and
/// direct LLM providers that can use Taomni tools.
#[derive(Clone, Debug)]
pub struct AgentThreadContext {
    pub thread_id: String,
    pub linked_session_id: Option<String>,
    pub bound_session_id: Option<String>,
    pub cwd: Option<String>,
    pub local_terminal_env: Option<LocalTerminalEnv>,
    pub bound_db_connection_id: Option<String>,
    pub bound_db_selected_objects: Vec<AgentDbSelectedObject>,
    pub code_workspace: Option<AgentCodeWorkspace>,
    pub flavor: Flavor,
    pub session_card: String,
}

impl AgentThreadContext {
    pub async fn refresh_runtime_bindings(&self, state: &AppState) {
        if let Some(cwd) = self.cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            state
                .agent_thread_cwd
                .lock()
                .unwrap()
                .insert(self.thread_id.clone(), cwd.to_string());
        }

        let conn = self
            .bound_db_connection_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        let mut bindings = state.agent_db_bindings.write().await;
        match conn.as_deref() {
            Some(c) => {
                bindings.insert(self.thread_id.clone(), c.to_string());
            }
            None => {
                bindings.remove(&self.thread_id);
            }
        }
        drop(bindings);

        let selected = if conn.is_some() {
            normalize_selected_objects(&self.bound_db_selected_objects)
        } else {
            Vec::new()
        };
        let mut selected_objects = state.agent_db_selected_objects.write().await;
        if selected.is_empty() {
            selected_objects.remove(&self.thread_id);
        } else {
            selected_objects.insert(self.thread_id.clone(), selected);
        }
        drop(selected_objects);

        let workspace = self
            .code_workspace
            .as_ref()
            .and_then(AgentCodeWorkspace::normalized);
        let mut workspaces = state.agent_code_workspaces.write().await;
        match workspace {
            Some(workspace) => {
                workspaces.insert(self.thread_id.clone(), workspace);
            }
            None => {
                workspaces.remove(&self.thread_id);
            }
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct AgentThreadContextInput {
    pub thread_id: String,
    pub linked_session_id: Option<String>,
    pub bound_session_id: Option<String>,
    pub cwd: Option<String>,
    pub local_terminal_env: Option<LocalTerminalEnv>,
    pub bound_db_connection_id: Option<String>,
    pub bound_db_selected_objects: Vec<AgentDbSelectedObject>,
    pub bound_db_selected_table: Option<AgentDbSelectedObject>,
    pub code_workspace: Option<AgentCodeWorkspace>,
}

pub fn normalize_selected_objects(objects: &[AgentDbSelectedObject]) -> Vec<AgentDbSelectedObject> {
    let mut out: Vec<AgentDbSelectedObject> = Vec::new();
    for object in objects {
        let Some(normalized) = object.normalized() else {
            continue;
        };
        if out.iter().any(|existing| existing == &normalized) {
            continue;
        }
        out.push(normalized);
        if out.len() >= MAX_SELECTED_DB_OBJECTS {
            break;
        }
    }
    out
}

pub fn build_agent_thread_context(
    state: &AppState,
    input: AgentThreadContextInput,
) -> Result<AgentThreadContext, String> {
    let (session, recent) = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        let session = input
            .bound_session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|sid| crate::session::db::get_session(&db, sid).ok());
        let recent = session
            .as_ref()
            .map(|sc| {
                crate::history::db_list_recent(
                    &db,
                    &session_card::host_key_for(sc),
                    session_card::HISTORY_LIMIT,
                )
                .unwrap_or_default()
            })
            .unwrap_or_default();
        (session, recent)
    };

    let flavor = Flavor::for_session_type(session.as_ref().map(|sc| &sc.session_type));
    let session_card = render_session_card(
        session.as_ref(),
        &input.thread_id,
        input.linked_session_id.is_some(),
        &recent,
        input.local_terminal_env.as_ref(),
    );

    Ok(AgentThreadContext {
        thread_id: input.thread_id,
        linked_session_id: input.linked_session_id,
        bound_session_id: input.bound_session_id,
        cwd: input.cwd,
        local_terminal_env: input.local_terminal_env,
        bound_db_connection_id: input.bound_db_connection_id,
        bound_db_selected_objects: if input.bound_db_selected_objects.is_empty() {
            input.bound_db_selected_table.into_iter().collect()
        } else {
            input.bound_db_selected_objects
        },
        code_workspace: input
            .code_workspace
            .as_ref()
            .and_then(AgentCodeWorkspace::normalized),
        flavor,
        session_card,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_object_normalized_accepts_cross_object_selection() {
        let selected = AgentDbSelectedObject {
            catalog: Some("  hive  ".into()),
            schema: Some(" default ".into()),
            name: " orders ".into(),
            kind: "table".into(),
        }
        .normalized()
        .unwrap();

        assert_eq!(selected.catalog.as_deref(), Some("hive"));
        assert_eq!(selected.schema.as_deref(), Some("default"));
        assert_eq!(selected.name, "orders");
        assert!(selected.is_selectable());
        assert_eq!(selected.display_name(), "hive.default.orders");

        let procedure = AgentDbSelectedObject {
            catalog: None,
            schema: Some("public".into()),
            name: "sp_sync".into(),
            kind: "procedure".into(),
        }
        .normalized()
        .unwrap();
        assert!(!procedure.is_selectable());
        assert!(
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: " ".into(),
                kind: "table".into(),
            }
            .normalized()
            .is_none()
        );
        assert!(
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "orders".into(),
                kind: "unknown".into(),
            }
            .normalized()
            .is_none()
        );
    }

    #[test]
    fn selected_objects_normalized_dedupes_and_caps() {
        let objects = vec![
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "orders".into(),
                kind: "table".into(),
            },
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "orders".into(),
                kind: "table".into(),
            },
            AgentDbSelectedObject {
                catalog: None,
                schema: Some("public".into()),
                name: "sp_sync".into(),
                kind: "procedure".into(),
            },
        ];
        let normalized = normalize_selected_objects(&objects);
        assert_eq!(normalized.len(), 2);
        assert_eq!(normalized[0].name, "orders");
        assert_eq!(normalized[1].kind, "procedure");
    }

    #[test]
    fn code_workspace_normalized_keeps_repo_relative_paths() {
        let workspace = AgentCodeWorkspace {
            repo_root: "  /repo/app  ".into(),
            active_path: Some(" src/main.ts ".into()),
            open_paths: vec![
                "src/main.ts".into(),
                "src/main.ts".into(),
                "../secret".into(),
                "/tmp/file".into(),
                "src/lib.rs".into(),
            ],
            dirty_paths: vec!["src/lib.rs".into(), "C:/absolute/file.rs".into()],
        }
        .normalized()
        .unwrap();

        assert_eq!(workspace.repo_root, "/repo/app");
        assert_eq!(workspace.active_path.as_deref(), Some("src/main.ts"));
        assert_eq!(workspace.open_paths, vec!["src/main.ts", "src/lib.rs"]);
        assert_eq!(workspace.dirty_paths, vec!["src/lib.rs"]);
    }

    #[test]
    fn code_workspace_normalized_rejects_empty_repo() {
        let workspace = AgentCodeWorkspace {
            repo_root: " ".into(),
            active_path: Some("src/main.ts".into()),
            open_paths: vec![],
            dirty_paths: vec![],
        };

        assert!(workspace.normalized().is_none());
    }
}

fn render_session_card(
    session: Option<&SessionConfig>,
    thread_id: &str,
    linked: bool,
    recent: &[String],
    local_terminal_env: Option<&LocalTerminalEnv>,
) -> String {
    let raw = session_card::render_card(session, thread_id, linked, recent, local_terminal_env);
    crate::chat::redact::redact(&raw).0
}
