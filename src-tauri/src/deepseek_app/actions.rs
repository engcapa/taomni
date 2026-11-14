use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    RunCommand,
    RunSql,
    WriteFile,
    WriteNote,
    OpenTab,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionProposal {
    pub id: String,
    pub kind: ActionKind,
    pub title: String,
    #[serde(default)]
    pub target: Option<ActionTarget>,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionTarget {
    pub terminal_id: Option<String>,
    pub workspace_path: Option<String>,
    pub database_id: Option<String>,
    pub cwd: Option<String>,
}

pub fn validate_action(
    action: &ActionProposal,
    bound_terminal: Option<&str>,
    bound_workspace: Option<&str>,
) -> Result<String, String> {
    if action.id.trim().is_empty() || action.title.trim().is_empty() {
        return Err("动作缺少标识或标题".into());
    }
    let payload = action.payload.as_object();
    let required = match action.kind {
        ActionKind::RunCommand => payload
            .and_then(|value| value.get("command"))
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty()),
        ActionKind::RunSql => payload
            .and_then(|value| value.get("sql"))
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty()),
        ActionKind::WriteFile => {
            payload
                .and_then(|value| value.get("path"))
                .and_then(|value| value.as_str())
                .is_some_and(|value| !value.trim().is_empty())
                && payload.and_then(|value| value.get("content")).is_some()
        }
        ActionKind::WriteNote => payload.and_then(|value| value.get("content")).is_some(),
        ActionKind::OpenTab => payload
            .and_then(|value| value.get("tab_type"))
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty()),
    };
    if !required {
        return Err("动作缺少必要参数".into());
    }
    if let Some(target) = action
        .target
        .as_ref()
        .and_then(|target| target.terminal_id.as_deref())
    {
        if bound_terminal != Some(target) {
            return Err("动作越界：目标终端不是当前绑定终端".into());
        }
    }
    let path = payload
        .and_then(|value| value.get("path"))
        .and_then(|value| value.as_str())
        .or_else(|| {
            action
                .target
                .as_ref()
                .and_then(|target| target.workspace_path.as_deref())
        })
        .or_else(|| {
            action
                .target
                .as_ref()
                .and_then(|target| target.cwd.as_deref())
        });
    if let Some(path) = path {
        let Some(root) = bound_workspace else {
            return Err("动作越界：未绑定工作区".into());
        };
        if !is_within_path(path, root) {
            return Err("动作越界：路径不在当前绑定工作区内".into());
        }
    } else if matches!(action.kind, ActionKind::WriteFile | ActionKind::WriteNote) {
        return Err("动作缺少工作区路径".into());
    }
    let command = payload
        .and_then(|value| value.get("command").or_else(|| value.get("sql")))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let dangerous = [
        "rm",
        "del",
        "format",
        "shutdown",
        "reboot",
        "kill",
        "truncate",
        "drop",
        "delete",
        "remove-item",
    ]
    .iter()
    .any(|needle| {
        command
            .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-')
            .any(|part| part.eq_ignore_ascii_case(needle))
    });
    let level = match action.kind {
        ActionKind::RunCommand | ActionKind::RunSql if dangerous => "L2",
        ActionKind::RunCommand | ActionKind::RunSql => "L1",
        ActionKind::WriteFile | ActionKind::WriteNote | ActionKind::OpenTab => "L1",
    };
    Ok(level.into())
}

fn is_within_path(candidate: &str, root: &str) -> bool {
    fn normalize(value: &str) -> String {
        let value = value.replace('\\', "/");
        let absolute = value.starts_with('/');
        let drive = value
            .get(..2)
            .filter(|prefix| prefix.as_bytes()[1] == b':')
            .map(|prefix| prefix.to_ascii_lowercase())
            .unwrap_or_default();
        let mut stack = Vec::new();
        for part in value.split('/').filter(|part| !part.is_empty()) {
            match part {
                "." => {}
                ".." => {
                    stack.pop();
                }
                part => stack.push(part.to_ascii_lowercase()),
            }
        }
        format!(
            "{}{}{}",
            drive,
            if absolute { "/" } else { "" },
            stack.join("/")
        )
    }
    let candidate = normalize(candidate);
    let root = normalize(root);
    candidate == root || candidate.starts_with(&(root + "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> ActionProposal {
        ActionProposal {
            id: "a".into(),
            kind: ActionKind::RunCommand,
            title: "read".into(),
            target: None,
            payload: serde_json::json!({"command":"ls"}),
            level: Some("L1".into()),
        }
    }

    #[test]
    fn recalculates_level_from_kind() {
        assert_eq!(validate_action(&command(), None, None).unwrap(), "L1");
    }

    #[test]
    fn rejects_outside_workspace() {
        let mut value = command();
        value.target = Some(ActionTarget {
            terminal_id: None,
            workspace_path: Some("/tmp/outside".into()),
            database_id: None,
            cwd: None,
        });
        assert!(validate_action(&value, None, Some("/work")).is_err());
    }
}
