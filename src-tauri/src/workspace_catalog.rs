//! Durable workspace metadata. Sessions retain sole ownership of credentials.
use crate::state::AppState;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Root {
    id: String,
    name: String,
    path: String,
    kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LooseFile {
    id: String,
    name: String,
    path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Membership {
    workspace_id: String,
    session_id: String,
    role: String,
    order: i64,
    pinned: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_surface: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Navigation {
    active_surface: String,
    navigator_collapsed: bool,
    right_pane_open: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    id: String,
    name: String,
    description: String,
    roots: Vec<Root>,
    loose_files: Vec<LooseFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_recent_id: Option<String>,
    pinned: bool,
    order: i64,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    last_opened_at: i64,
    navigation: Navigation,
    memberships: Vec<Membership>,
}

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS workspace_schema_meta(version INTEGER NOT NULL);
         INSERT INTO workspace_schema_meta SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM workspace_schema_meta);
         CREATE TABLE IF NOT EXISTS workspaces(
           id TEXT PRIMARY KEY, legacy_recent_id TEXT UNIQUE, revision INTEGER NOT NULL, record_json TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS workspace_memberships(
           workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, record_json TEXT NOT NULL,
           PRIMARY KEY(workspace_id,session_id));",
    )
}

fn get(conn: &Connection, id: &str) -> Result<Workspace, String> {
    let json: String = conn
        .query_row(
            "SELECT record_json FROM workspaces WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut workspace: Workspace =
        serde_json::from_str(&json).map_err(|e| format!("workspace recovery required: {e}"))?;
    let mut statement = conn.prepare("SELECT record_json FROM workspace_memberships WHERE workspace_id=?1 ORDER BY session_id")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    workspace.memberships = rows
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    workspace.memberships.sort_by_key(|m| m.order);
    Ok(workspace)
}

fn save(conn: &mut Connection, mut workspace: Workspace) -> Result<Workspace, String> {
    if workspace.id.trim().is_empty() || workspace.name.trim().is_empty() {
        return Err("workspace id and name are required".into());
    }
    if ![
        "overview", "files", "terminal", "preview", "tao", "changes", "mail",
    ]
    .contains(&workspace.navigation.active_surface.as_str())
    {
        return Err("invalid active surface".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let current: Option<i64> = tx
        .query_row(
            "SELECT revision FROM workspaces WHERE id=?1",
            [&workspace.id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if current.unwrap_or(0) != workspace.revision {
        return Err("workspace revision conflict; reload before retrying".into());
    }
    let mut seen = std::collections::HashSet::new();
    for member in &workspace.memberships {
        if member.workspace_id != workspace.id
            || member.session_id.is_empty()
            || !["primary", "attached", "reference"].contains(&member.role.as_str())
            || !seen.insert(&member.session_id)
        {
            return Err("invalid or duplicate workspace membership".into());
        }
        // Existing unavailable references survive a save, but new references must exist.
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1) OR EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id=?2 AND session_id=?1)", params![member.session_id, workspace.id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !exists {
            return Err("missing canonical session".into());
        }
    }
    workspace.revision += 1;
    let members = std::mem::take(&mut workspace.memberships);
    let json = serde_json::to_string(&workspace).map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO workspaces(id,legacy_recent_id,revision,record_json) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET legacy_recent_id=excluded.legacy_recent_id, revision=excluded.revision, record_json=excluded.record_json", params![workspace.id, workspace.legacy_recent_id, workspace.revision, json]).map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM workspace_memberships WHERE workspace_id=?1",
        [&workspace.id],
    )
    .map_err(|e| e.to_string())?;
    for member in &members {
        tx.execute(
            "INSERT INTO workspace_memberships VALUES(?1,?2,?3)",
            params![
                workspace.id,
                member.session_id,
                serde_json::to_string(member).map_err(|e| e.to_string())?
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    workspace.memberships = members;
    Ok(workspace)
}

fn changed(app: &tauri::AppHandle, id: &str, revision: i64) {
    let _ = app.emit("workspace-state-changed", serde_json::json!({"workspaceId": id, "revision": revision, "collections": ["workspaces", "memberships", "navigation"]}));
}

#[tauri::command]
pub fn list_workspaces(state: State<'_, AppState>) -> Result<Vec<Workspace>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut statement = db
        .prepare("SELECT id FROM workspaces ORDER BY id")
        .map_err(|e| e.to_string())?;
    let ids = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    ids.iter().map(|id| get(&db, id)).collect()
}

#[tauri::command]
pub fn get_workspace(id: String, state: State<'_, AppState>) -> Result<Workspace, String> {
    get(&*state.db.lock().map_err(|e| e.to_string())?, &id)
}

#[tauri::command]
pub fn save_workspace(
    workspace: Workspace,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let result = save(&mut *state.db.lock().map_err(|e| e.to_string())?, workspace)?;
    changed(&app, &result.id, result.revision);
    Ok(result)
}

#[tauri::command]
pub fn delete_workspace(
    id: String,
    revision: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    if tx
        .execute(
            "DELETE FROM workspaces WHERE id=?1 AND revision=?2",
            params![id, revision],
        )
        .map_err(|e| e.to_string())?
        != 1
    {
        return Err("workspace revision conflict".into());
    }
    tx.execute(
        "DELETE FROM workspace_memberships WHERE workspace_id=?1",
        [&id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    changed(&app, &id, revision + 1);
    Ok(())
}

#[tauri::command]
pub fn list_workspace_memberships(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Membership>, String> {
    Ok(get(&*state.db.lock().map_err(|e| e.to_string())?, &id)?.memberships)
}

#[tauri::command]
pub fn upsert_workspace_membership(
    membership: Membership,
    revision: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let mut workspace = get(&db, &membership.workspace_id)?;
    workspace.revision = revision;
    if let Some(existing) = workspace
        .memberships
        .iter_mut()
        .find(|m| m.session_id == membership.session_id)
    {
        *existing = membership;
    } else {
        workspace.memberships.push(membership);
    }
    let result = save(&mut db, workspace)?;
    changed(&app, &result.id, result.revision);
    Ok(result)
}

#[tauri::command]
pub fn remove_workspace_membership(
    id: String,
    session_id: String,
    revision: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let mut workspace = get(&db, &id)?;
    workspace.revision = revision;
    workspace.memberships.retain(|m| m.session_id != session_id);
    let result = save(&mut db, workspace)?;
    changed(&app, &result.id, result.revision);
    Ok(result)
}

#[tauri::command]
pub fn save_workspace_navigation(
    id: String,
    navigation: Navigation,
    revision: i64,
    last_opened_at: i64,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Workspace, String> {
    let mut db = state.db.lock().map_err(|e| e.to_string())?;
    let mut workspace = get(&db, &id)?;
    workspace.revision = revision;
    workspace.navigation = navigation;
    workspace.last_opened_at = last_opened_at;
    let result = save(&mut db, workspace)?;
    changed(&app, &result.id, result.revision);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> Workspace {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": "Project", "description": "", "roots": [], "looseFiles": [],
            "pinned": false, "order": 0, "revision": 0, "createdAt": 1, "updatedAt": 1,
            "lastOpenedAt": 1, "memberships": [],
            "navigation": {"activeSurface":"overview", "navigatorCollapsed":false, "rightPaneOpen":false}
        })).unwrap()
    }

    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        crate::session::db::init_db(&db).unwrap();
        db.execute("INSERT INTO sessions(id,name,session_type,created_at,updated_at) VALUES('shared','Shared','SSH',1,1)", []).unwrap();
        db
    }

    #[test]
    fn conflict_does_not_overwrite_or_drop_references() {
        let mut db = database();
        let first = save(&mut db, record("a")).unwrap();
        let mut next = first.clone();
        next.name = "Renamed".into();
        save(&mut db, next).unwrap();
        assert!(save(&mut db, first).unwrap_err().contains("conflict"));
        assert_eq!(get(&db, "a").unwrap().name, "Renamed");
    }

    #[test]
    fn shared_references_are_unique_and_session_delete_is_atomic() {
        let mut db = database();
        for id in ["a", "b"] {
            let mut workspace = record(id);
            workspace.memberships.push(Membership {
                workspace_id: id.into(),
                session_id: "shared".into(),
                role: "reference".into(),
                order: 0,
                pinned: false,
                default_surface: None,
            });
            save(&mut db, workspace).unwrap();
        }
        let mut invalid = get(&db, "a").unwrap();
        invalid.memberships.push(invalid.memberships[0].clone());
        assert!(save(&mut db, invalid).is_err());
        assert_eq!(get(&db, "a").unwrap().memberships.len(), 1);
        crate::session::db::delete_session(&db, "shared").unwrap();
        for id in ["a", "b"] {
            let workspace = get(&db, id).unwrap();
            assert!(workspace.memberships.is_empty());
            assert_eq!(workspace.revision, 2);
        }
    }

    #[test]
    fn unknown_fields_and_new_missing_references_are_rejected() {
        let mut json = serde_json::to_value(record("a")).unwrap();
        json["password"] = serde_json::json!("must not persist");
        assert!(serde_json::from_value::<Workspace>(json).is_err());
        let mut db = database();
        let mut workspace = record("a");
        workspace.memberships.push(Membership {
            workspace_id: "a".into(),
            session_id: "missing".into(),
            role: "primary".into(),
            order: 0,
            pinned: false,
            default_surface: None,
        });
        assert!(save(&mut db, workspace).is_err());
        assert!(get(&db, "a").is_err());
    }

    #[test]
    fn durable_record_survives_reopen_and_migration_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("taomni.db");
        {
            let mut db = Connection::open(&path).unwrap();
            crate::session::db::init_db(&db).unwrap();
            let mut workspace = record("stable");
            workspace.legacy_recent_id = Some("legacy-root-hash".into());
            workspace.navigation.active_surface = "changes".into();
            save(&mut db, workspace).unwrap();
        }
        let mut db = Connection::open(path).unwrap();
        init(&db).unwrap();
        init(&db).unwrap();
        let restored = get(&db, "stable").unwrap();
        assert_eq!(restored.navigation.active_surface, "changes");
        let mut duplicate = record("other");
        duplicate.legacy_recent_id = restored.legacy_recent_id;
        assert!(save(&mut db, duplicate).is_err());
    }
}
