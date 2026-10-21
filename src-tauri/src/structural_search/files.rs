use super::model::MAX_FILE_BYTES;
use super::model::StructuralActiveFile;
use super::model::StructuralErrorCode;
use super::model::StructuralSearchRequest;
use super::model::StructuralSearchRoot;
use super::pattern::PatternError;
use ignore::WalkBuilder;
use std::collections::HashMap;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

pub(super) struct SearchFile {
    pub(super) root_index: usize,
    pub(super) relative: String,
    pub(super) absolute: PathBuf,
}

pub(super) fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(super) fn is_java_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("java"))
}

pub(super) fn scope_error(message: impl Into<String>) -> PatternError {
    PatternError {
        code: StructuralErrorCode::InvalidScope,
        message: message.into(),
    }
}

pub(super) fn file_error(
    code: StructuralErrorCode,
    path: &Path,
    detail: impl std::fmt::Display,
) -> PatternError {
    PatternError {
        code,
        message: format!("Cannot search {}: {detail}", path.display()),
    }
}

pub(super) fn buffer_path(path: &str) -> Result<String, PatternError> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty()
        || !Path::new(&normalized)
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
        || !is_java_file(Path::new(&normalized))
    {
        return Err(scope_error(format!(
            "Editor buffer must be a relative Java path: {path}"
        )));
    }
    Ok(normalized)
}

pub(super) fn collect_buffers(
    request: &StructuralSearchRequest,
) -> Result<HashMap<(usize, String), &str>, PatternError> {
    let mut buffers = HashMap::new();
    for buffer in &request.buffers {
        let index = request
            .roots
            .iter()
            .position(|root| root.id == buffer.root_id)
            .ok_or_else(|| scope_error("Editor buffer is outside the workspace"))?;
        let key = (index, buffer_path(&buffer.path)?);
        if buffers.insert(key, buffer.text.as_str()).is_some() {
            return Err(scope_error("Duplicate editor buffer path"));
        }
    }
    Ok(buffers)
}

/// Bound the read itself (not only a stat check) and never report skipped input
/// as a successful empty search. Editor snapshots take precedence over disk.
pub(super) fn read_search_source(
    path: &Path,
    buffer: Option<&str>,
) -> Result<Vec<u8>, PatternError> {
    let bytes = if let Some(text) = buffer {
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(file_error(
                StructuralErrorCode::FileTooLarge,
                path,
                "file exceeds the 2 MiB search limit",
            ));
        }
        text.as_bytes().to_vec()
    } else {
        let file = std::fs::File::open(path)
            .map_err(|error| file_error(StructuralErrorCode::FileRead, path, error))?;
        let mut bytes = Vec::new();
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| file_error(StructuralErrorCode::FileRead, path, error))?;
        bytes
    };
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(file_error(
            StructuralErrorCode::FileTooLarge,
            path,
            "file exceeds the 2 MiB search limit",
        ));
    }
    if std::str::from_utf8(&bytes).is_err() {
        return Err(file_error(
            StructuralErrorCode::UnsupportedEncoding,
            path,
            "file is not UTF-8; open it in the editor or save a UTF-8 copy before searching",
        ));
    }
    Ok(bytes)
}

/// Resolve `workspace` / `module` / `file` into an ordered Java file list.
/// `module` is the workspace root containing the active file, the closest
/// Taomni equivalent of an IDEA module until project models expose modules.
pub(super) fn collect_files(
    roots: &[StructuralSearchRoot],
    scope: &str,
    active: Option<&StructuralActiveFile>,
    buffers: &HashMap<(usize, String), &str>,
    cancelled: &AtomicBool,
) -> Result<Vec<SearchFile>, PatternError> {
    let active_root = || {
        let active =
            active.ok_or_else(|| scope_error(format!("Scope '{scope}' needs an active file")))?;
        roots
            .iter()
            .position(|root| root.id == active.root_id)
            .map(|index| (index, active))
            .ok_or_else(|| scope_error("The active file is not inside a workspace root"))
    };
    let root_indexes: Vec<usize> = match scope {
        "workspace" => (0..roots.len()).collect(),
        "module" => vec![active_root()?.0],
        "file" => {
            let (index, active) = active_root()?;
            let root = std::fs::canonicalize(&roots[index].path).map_err(|error| {
                scope_error(format!("Resolve root {}: {error}", roots[index].path))
            })?;
            let relative = buffer_path(&active.path)?;
            let absolute = if buffers.contains_key(&(index, relative.clone())) {
                root.join(&relative)
            } else {
                std::fs::canonicalize(root.join(&relative)).map_err(|error| {
                    file_error(StructuralErrorCode::FileRead, &root.join(&relative), error)
                })?
            };
            if !absolute.starts_with(&root) || !is_java_file(&absolute) {
                return Err(scope_error(
                    "Scope 'file' needs an active Java file inside the workspace",
                ));
            }
            return Ok(vec![SearchFile {
                root_index: index,
                relative: relative_path(&root, &absolute),
                absolute,
            }]);
        }
        other => return Err(scope_error(format!("Unknown scope '{other}'"))),
    };

    let mut files = Vec::new();
    for index in root_indexes {
        let root = std::fs::canonicalize(&roots[index].path)
            .map_err(|error| scope_error(format!("Resolve root {}: {error}", roots[index].path)))?;
        let mut walk = WalkBuilder::new(&root);
        walk.follow_links(false).require_git(false);
        let mut root_files = Vec::new();
        for entry in walk.build() {
            if cancelled.load(Ordering::Relaxed) {
                return Ok(files);
            }
            let entry =
                entry.map_err(|error| file_error(StructuralErrorCode::FileRead, &root, error))?;
            if !entry.file_type().is_some_and(|kind| kind.is_file()) || !is_java_file(entry.path())
            {
                continue;
            }
            let absolute = entry.into_path();
            root_files.push(SearchFile {
                root_index: index,
                relative: relative_path(&root, &absolute),
                absolute,
            });
        }
        // Include explicitly open Java documents even if ignored, newly created,
        // or deleted on disk; their loaded buffer remains the user's source.
        for (buffer_root, path) in buffers.keys() {
            if *buffer_root == index && !root_files.iter().any(|file| file.relative == *path) {
                root_files.push(SearchFile {
                    root_index: index,
                    relative: path.clone(),
                    absolute: root.join(path),
                });
            }
        }
        root_files.sort_by(|a, b| a.relative.cmp(&b.relative));
        files.extend(root_files);
    }
    Ok(files)
}
