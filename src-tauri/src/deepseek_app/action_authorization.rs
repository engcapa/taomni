//! Resolve execution targets from the persisted, explicitly bound request.
use super::{
    actions::{self, ActionKind, ActionProposal, ActionTarget},
    types::TaoRequest,
};
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

pub fn authorize(action: &mut ActionProposal, request: &TaoRequest) -> Result<String, String> {
    if request.mode != "do" {
        return Err("action: switch to Do mode and request a new proposal".into());
    }
    let context = |key: &str| request.context.get(key).and_then(Value::as_str);
    let terminal = context("terminalId").or_else(|| context("terminal"));
    let root = context("workspace");
    let level = actions::validate_action(action, terminal, root)?;
    if matches!(action.kind, ActionKind::RunSql) {
        let bound = context("databaseId")
            .or_else(|| context("database"))
            .ok_or("action: database binding required")?;
        if action
            .target
            .as_ref()
            .and_then(|target| target.database_id.as_deref())
            != Some(bound)
        {
            return Err("action: SQL target is not the bound database".into());
        }
    }
    if matches!(action.kind, ActionKind::RunCommand | ActionKind::WriteFile) {
        let root = root.ok_or("action: workspace binding required")?;
        let target = action.target.get_or_insert(ActionTarget {
            terminal_id: None,
            workspace_path: None,
            database_id: None,
            cwd: None,
        });
        // The local executor must never silently run a remote terminal command
        // on this machine. Remote execution needs its own bound-session adapter.
        if target.terminal_id.is_some() {
            return Err("action: remote terminal execution is not available; use the bound workspace or coding agent".into());
        }
        target.workspace_path = Some(root.into());
        let cwd = safe_path(
            Path::new(target.cwd.as_deref().unwrap_or(root)),
            Path::new(root),
        )?;
        if !cwd.is_dir() {
            return Err("action: working directory unavailable".into());
        }
        target.cwd = Some(cwd.to_string_lossy().into_owned());
    }
    Ok(level)
}

/// Normalize lexical parents before walking existing ancestors. Canonicalize
/// every existing prefix so links cannot redirect a new file out of the root.
pub fn safe_path(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|_| "action: workspace unavailable")?;
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let mut normalized = PathBuf::new();
    for part in candidate.components() {
        match part {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => (),
            part => normalized.push(part.as_os_str()),
        }
    }
    let mut parent = normalized.as_path();
    while !parent.exists() {
        parent = parent.parent().ok_or("action: target parent unavailable")?;
    }
    let canonical =
        std::fs::canonicalize(parent).map_err(|_| "action: target parent unavailable")?;
    if !canonical.starts_with(&root) {
        return Err("action: target escapes workspace".into());
    }
    let suffix = normalized
        .strip_prefix(parent)
        .map_err(|_| "action: invalid target")?;
    // Joining an empty suffix adds a trailing separator on Windows. For an
    // existing file that turns the valid file path into an invalid directory
    // path, losing the backup and failing verification after replacement.
    Ok(if suffix.as_os_str().is_empty() {
        canonical
    } else {
        canonical.join(suffix)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn authorization_uses_saved_mode_and_binding_and_checks_every_target() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let mut request: TaoRequest = serde_json::from_value(json!({"threadId":"t","content":"build","mode":"ask","model":"deepseek-flash","context":{"workspace":root}})).unwrap();
        let mut action: ActionProposal = serde_json::from_value(json!({"id":"a","kind":"run_command","title":"test","payload":{"command":"python -m unittest"}})).unwrap();
        assert!(authorize(&mut action, &request).is_err());
        request.mode = "do".into();
        assert!(authorize(&mut action, &request).is_ok());
        assert_eq!(
            Path::new(
                action
                    .target
                    .as_ref()
                    .unwrap()
                    .workspace_path
                    .as_ref()
                    .unwrap()
            ),
            root
        );
        action.target.as_mut().unwrap().cwd = Some(temp.path().to_string_lossy().into_owned());
        assert!(authorize(&mut action, &request).is_err());
        assert!(safe_path(Path::new("new/../../outside.txt"), &root).is_err());
        assert!(safe_path(Path::new("new/main.py"), &root).is_ok());
        std::fs::write(root.join("existing.py"), "original").unwrap();
        assert_eq!(
            safe_path(Path::new("existing.py"), &root).unwrap(),
            std::fs::canonicalize(root.join("existing.py")).unwrap()
        );
    }
}
