use super::limits::MAX_CODE_WORKSPACE_LOOSE_FILES;
use super::limits::MAX_CODE_WORKSPACE_PATHS;
use super::limits::MAX_CODE_WORKSPACE_ROOTS;
use super::paths::clean_code_workspace_id;
use super::paths::clean_code_workspace_name;
use super::paths::clean_code_workspace_os_path;
use super::paths::clean_code_workspace_path;
use super::paths::code_workspace_basename;
use super::workspace_model::AgentCodeWorkspaceFile;
use super::workspace_model::AgentCodeWorkspaceLooseFile;
use super::workspace_model::AgentCodeWorkspaceRoot;

pub(super) fn normalize_code_workspace_paths(paths: &[String]) -> Vec<String> {
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

pub(super) fn normalize_code_workspace_roots(
    roots: &[AgentCodeWorkspaceRoot],
) -> Vec<AgentCodeWorkspaceRoot> {
    let mut out: Vec<AgentCodeWorkspaceRoot> = Vec::new();
    for root in roots {
        let Some(id) = clean_code_workspace_id(&root.id) else {
            continue;
        };
        let Some(path) = clean_code_workspace_os_path(&root.path) else {
            continue;
        };
        if out
            .iter()
            .any(|existing| existing.id == id || existing.path == path)
        {
            continue;
        }
        let name = clean_code_workspace_name(&root.name)
            .or_else(|| code_workspace_basename(&path))
            .unwrap_or_else(|| "Workspace".into());
        let kind = root
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|kind| matches!(*kind, "git" | "folder"))
            .map(ToString::to_string)
            .or_else(|| Some("folder".into()));
        out.push(AgentCodeWorkspaceRoot {
            id,
            name,
            path,
            kind,
        });
        if out.len() >= MAX_CODE_WORKSPACE_ROOTS {
            break;
        }
    }
    out
}

pub(super) fn normalize_code_workspace_loose_files(
    files: &[AgentCodeWorkspaceLooseFile],
) -> Vec<AgentCodeWorkspaceLooseFile> {
    let mut out: Vec<AgentCodeWorkspaceLooseFile> = Vec::new();
    for file in files {
        let Some(id) = clean_code_workspace_id(&file.id) else {
            continue;
        };
        let Some(path) = clean_code_workspace_os_path(&file.path) else {
            continue;
        };
        if out
            .iter()
            .any(|existing| existing.id == id || existing.path == path)
        {
            continue;
        }
        let name = file
            .name
            .as_deref()
            .and_then(clean_code_workspace_name)
            .or_else(|| code_workspace_basename(&path));
        out.push(AgentCodeWorkspaceLooseFile { id, name, path });
        if out.len() >= MAX_CODE_WORKSPACE_LOOSE_FILES {
            break;
        }
    }
    out
}

pub(super) fn root_file_for_path(
    root: &AgentCodeWorkspaceRoot,
    path: String,
) -> AgentCodeWorkspaceFile {
    AgentCodeWorkspaceFile {
        kind: "root".into(),
        root_id: Some(root.id.clone()),
        root_name: Some(root.name.clone()),
        root_path: Some(root.path.clone()),
        id: None,
        name: None,
        path: Some(path),
    }
}

pub(super) fn loose_file_for_path(file: &AgentCodeWorkspaceLooseFile) -> AgentCodeWorkspaceFile {
    AgentCodeWorkspaceFile {
        kind: "loose".into(),
        root_id: None,
        root_name: None,
        root_path: None,
        id: Some(file.id.clone()),
        name: file.name.clone(),
        path: Some(file.path.clone()),
    }
}

pub(super) fn normalize_code_workspace_file(
    file: &AgentCodeWorkspaceFile,
    roots: &[AgentCodeWorkspaceRoot],
    loose_files: &[AgentCodeWorkspaceLooseFile],
) -> Option<AgentCodeWorkspaceFile> {
    match file.kind.trim() {
        "root" => {
            let root = file
                .root_id
                .as_deref()
                .and_then(clean_code_workspace_id)
                .and_then(|id| roots.iter().find(|root| root.id == id))
                .or_else(|| {
                    file.root_path
                        .as_deref()
                        .and_then(clean_code_workspace_os_path)
                        .and_then(|path| roots.iter().find(|root| root.path == path))
                })?;
            let path = file.path.as_deref().and_then(clean_code_workspace_path)?;
            Some(root_file_for_path(root, path))
        }
        "loose" => {
            let by_id = file
                .id
                .as_deref()
                .and_then(clean_code_workspace_id)
                .and_then(|id| loose_files.iter().find(|item| item.id == id));
            let by_path = file
                .path
                .as_deref()
                .and_then(clean_code_workspace_os_path)
                .and_then(|path| loose_files.iter().find(|item| item.path == path));
            by_id.or(by_path).map(loose_file_for_path)
        }
        _ => None,
    }
}

pub(super) fn normalize_code_workspace_files(
    files: &[AgentCodeWorkspaceFile],
    roots: &[AgentCodeWorkspaceRoot],
    loose_files: &[AgentCodeWorkspaceLooseFile],
) -> Option<Vec<AgentCodeWorkspaceFile>> {
    if files.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for file in files {
        let Some(normalized) = normalize_code_workspace_file(file, roots, loose_files) else {
            continue;
        };
        if out.iter().any(|existing| existing == &normalized) {
            continue;
        }
        out.push(normalized);
        if out.len() >= MAX_CODE_WORKSPACE_PATHS {
            break;
        }
    }
    Some(out)
}

pub(super) fn legacy_paths_to_files(
    paths: &[String],
    roots: &[AgentCodeWorkspaceRoot],
) -> Option<Vec<AgentCodeWorkspaceFile>> {
    let root = roots.first()?;
    Some(
        paths
            .iter()
            .cloned()
            .map(|path| root_file_for_path(root, path))
            .collect(),
    )
}
