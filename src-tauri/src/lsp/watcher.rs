use super::*;

pub(super) fn local_watched_snapshot(path: &Path) -> Option<LocalWatchedSnapshot> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => sha256_hex_file(path).map(LocalWatchedSnapshot::File),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Some(LocalWatchedSnapshot::Missing)
        }
        // Directory events and unreadable files cannot establish an own-write echo.
        _ => None,
    }
}

pub(super) async fn notify_watched_file_sessions(
    sessions_registry: &LspSessionRegistry,
    workspace_id: &str,
    changes: &[LspWatchedFileChange],
) -> usize {
    let guard = sessions_registry.lock().await;
    let mut sessions = guard
        .iter()
        .filter_map(|(key, entry)| match entry {
            LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                Some((key.clone(), session.clone()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    drop(guard);
    sessions.sort_by(|left, right| left.0.cmp(&right.0));
    let mut notified = 0;
    for (_, session) in sessions {
        // A provider that holds an open document for a path already owns that
        // document's content through didOpen/didChange. Reporting a watched-file
        // change for it makes reload-prone servers (Eclipse JDT LS) re-read the
        // file from disk and discard in-memory edits that arrived after the
        // write — the user's post-save typing vanished from the provider model.
        let session_changes: Vec<LspWatchedFileChange> = {
            let opened = session.opened_documents.read().await;
            changes
                .iter()
                .filter(|change| {
                    !file_operation_uri(&change.path)
                        .map(|uri| opened.contains(&uri))
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        };
        if session_changes.is_empty() {
            continue;
        }
        let params = match session.watched_file_params(&session_changes).await {
            Ok(Some(params)) => params,
            Ok(None) => continue,
            Err(error) => {
                log::warn!(
                    "cannot prepare workspace/didChangeWatchedFiles for {}: {error}",
                    session.preset.display_name
                );
                continue;
            }
        };
        match session
            .notify("workspace/didChangeWatchedFiles", params)
            .await
        {
            Ok(()) => notified += 1,
            Err(error) => log::warn!(
                "cannot notify {} with workspace/didChangeWatchedFiles: {error}",
                session.preset.display_name
            ),
        }
    }
    notified
}

pub(super) fn file_operation_filters_from(
    server_capabilities: &Value,
    registrations: &[DynamicCapabilityRegistration],
    method: &str,
) -> Option<Vec<Value>> {
    let capability_key = file_operation_capability_key(method)?;
    let mut supported = false;
    let mut filters = Vec::new();
    if let Some(options) = server_capabilities
        .get("workspace")
        .and_then(|workspace| workspace.get("fileOperations"))
        .and_then(|operations| operations.get(capability_key))
    {
        supported = true;
        filters.extend(file_operation_filters_from_options(options));
    }
    for registration in registrations
        .iter()
        .filter(|registration| registration.method == method)
    {
        supported = true;
        filters.extend(file_operation_filters_from_options(
            &registration.register_options,
        ));
    }
    supported.then_some(filters)
}

pub(super) fn file_operation_uri(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(format!(
            "LSP workspace file operation requires an absolute path: {}",
            path.display()
        ));
    }
    url::Url::from_file_path(path)
        .map(|uri| uri.to_string())
        .map_err(|_| format!("Cannot convert path to file URI: {}", path.display()))
}

pub(super) fn normalized_file_operation_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(not(windows))]
pub(super) fn relative_file_operation_path(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(normalized_file_operation_path)
}

#[cfg(windows)]
pub(super) fn relative_file_operation_path(root: &Path, path: &Path) -> Option<String> {
    let root = normalized_file_operation_path(root);
    let path = normalized_file_operation_path(path);
    let root = root.trim_end_matches('/');
    if path.eq_ignore_ascii_case(root) {
        return Some(String::new());
    }
    let boundary = root.len();
    if path.len() <= boundary
        || !path[..boundary].eq_ignore_ascii_case(root)
        || path.as_bytes().get(boundary) != Some(&b'/')
    {
        return None;
    }
    Some(path[boundary + 1..].to_string())
}

pub(super) fn file_operation_match_paths(root_uri: &str, uri: &str) -> Option<Vec<String>> {
    let root = url::Url::parse(root_uri).ok()?.to_file_path().ok()?;
    let file_url = url::Url::parse(uri).ok()?;
    if file_url.scheme() != "file" {
        return None;
    }
    let file = file_url.to_file_path().ok()?;
    let relative = relative_file_operation_path(&root, &file)?;
    let absolute = normalized_file_operation_path(&file);
    let mut paths = Vec::new();
    for candidate in [
        relative,
        absolute.clone(),
        absolute.trim_start_matches('/').to_string(),
    ] {
        if !candidate.is_empty() && !paths.contains(&candidate) {
            paths.push(candidate);
        }
    }
    Some(paths)
}

pub(super) fn notify_change(path: &Path, change_type: u8) -> Option<LspWatchedFileChange> {
    // A directory mtime bump carries no file information: the file event that
    // caused it arrives separately on all platforms. Forwarding the directory
    // itself makes the UI report "File changed on disk: <dir>" noise that
    // clobbers real status confirmations, and pointlessly re-triggers server
    // watchers. Directory create/remove are still forwarded (tree structure).
    if change_type == 2 && path.is_dir() {
        return None;
    }
    path.is_absolute().then(|| LspWatchedFileChange {
        path: normalized_file_operation_path(path),
        change_type,
    })
}

pub(super) fn normalized_watch_path_equals(left: &str, right: &str) -> bool {
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

pub(super) fn normalized_watch_path_is_under(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return path.starts_with('/');
    }
    if normalized_watch_path_equals(root, path.trim_end_matches('/')) {
        return true;
    }
    let boundary = root.len();
    path.len() > boundary
        && path.get(..boundary).is_some_and(|prefix| {
            if cfg!(windows) {
                prefix.eq_ignore_ascii_case(root)
            } else {
                prefix == root
            }
        })
        && path.as_bytes().get(boundary) == Some(&b'/')
}

pub(super) fn workspace_watch_target_matches(targets: &[WorkspaceWatchTarget], path: &str) -> bool {
    if crate::workspace::is_workspace_write_temp_path(path) {
        return false;
    }
    targets.iter().any(|target| {
        let filter = normalized_file_operation_path(&target.filter_path);
        if target.direct_children {
            let parent = path
                .trim_end_matches('/')
                .rsplit_once('/')
                .map(|(parent, _)| parent)
                .unwrap_or("");
            return normalized_watch_path_equals(filter.trim_end_matches('/'), parent)
                || normalized_watch_path_equals(
                    filter.trim_end_matches('/'),
                    path.trim_end_matches('/'),
                );
        }
        if !target.recursive {
            // An explicitly opened loose file remains observable even when
            // its parent is normally excluded from recursive project scans.
            return normalized_watch_path_equals(
                filter.trim_end_matches('/'),
                path.trim_end_matches('/'),
            );
        }
        if !normalized_watch_path_is_under(&filter, path) {
            return false;
        }
        // Ignore generated descendants, not ancestors of the root the user
        // chose. A project under ~/.cache or build/ is still a workspace.
        let relative = &path[filter.trim_end_matches('/').len()..];
        !crate::workspace::should_skip_workspace_entry_path(relative.trim_start_matches('/'))
    })
}

pub(super) fn local_watched_event_suppressed(
    events: &StdMutex<HashMap<(String, String, u8), LocalWatchedEvent>>,
    workspace_id: &str,
    path: &str,
    change_type: u8,
    now: Instant,
) -> bool {
    let normalized_path = normalized_file_operation_path(Path::new(path));
    let mut candidates = vec![change_type];
    if change_type == 1 || change_type == 3 {
        candidates.push(2);
    }
    let owned = {
        let mut events = events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        events.retain(|_, event| now.duration_since(event.at) < Duration::from_secs(3));
        candidates
            .into_iter()
            .filter_map(|candidate| {
                events.remove(&(workspace_id.to_string(), normalized_path.clone(), candidate))
            })
            .collect::<Vec<_>>()
    };
    if owned.is_empty() {
        return false;
    }
    // A second process can rewrite or delete the file immediately after our
    // save. Timing alone does not prove an echo: suppress only identical bytes
    // (or the same absence after a delete), and fail open on read errors.
    let Some(snapshot) = local_watched_snapshot(Path::new(path)) else {
        return false;
    };
    owned.iter().any(|event| event.snapshot == snapshot)
}

pub(super) fn notify_event_changes(event: &NotifyEvent) -> Vec<LspWatchedFileChange> {
    let mut changes = match event.kind {
        EventKind::Create(_) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 1))
            .collect(),
        EventKind::Remove(_) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 3))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            let mut changes = Vec::new();
            if let Some(change) = notify_change(&event.paths[0], 3) {
                changes.push(change);
            }
            if let Some(change) = event.paths.last().and_then(|path| notify_change(path, 1)) {
                changes.push(change);
            }
            changes
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 3))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 1))
            .collect(),
        EventKind::Modify(ModifyKind::Name(_)) => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, if path.exists() { 1 } else { 3 }))
            .collect(),
        EventKind::Modify(_) | EventKind::Any => event
            .paths
            .iter()
            .filter_map(|path| notify_change(path, 2))
            .collect(),
        EventKind::Access(_) | EventKind::Other => Vec::new(),
    };
    let mut seen = HashSet::new();
    changes.retain(|change| seen.insert((change.path.clone(), change.change_type)));
    changes
}

pub(super) fn watch_kind_for_change(change_type: u8) -> Option<u8> {
    match change_type {
        1 => Some(WATCH_KIND_CREATE),
        2 => Some(WATCH_KIND_CHANGE),
        3 => Some(WATCH_KIND_DELETE),
        _ => None,
    }
}

pub(super) fn relative_pattern_base_path(pattern: &Value) -> Option<PathBuf> {
    let base = pattern.get("baseUri")?;
    let uri = base
        .as_str()
        .or_else(|| base.get("uri").and_then(Value::as_str))?;
    url::Url::parse(uri).ok()?.to_file_path().ok()
}

pub(super) fn watched_file_match_paths(
    root_uri: &str,
    uri: &str,
    relative_base: Option<&Path>,
) -> Option<Vec<String>> {
    if let Some(base) = relative_base {
        let file_url = url::Url::parse(uri).ok()?;
        if file_url.scheme() != "file" {
            return None;
        }
        let file = file_url.to_file_path().ok()?;
        let relative = relative_file_operation_path(base, &file)?;
        let absolute = normalized_file_operation_path(&file);
        let mut paths = vec![relative];
        if !absolute.is_empty() && !paths.contains(&absolute) {
            paths.push(absolute.clone());
        }
        let trimmed = absolute.trim_start_matches('/').to_string();
        if !trimmed.is_empty() && !paths.contains(&trimmed) {
            paths.push(trimmed);
        }
        return Some(paths);
    }
    file_operation_match_paths(root_uri, uri)
}

pub(super) fn watched_file_glob_matches(
    root_uri: &str,
    uri: &str,
    glob_pattern: &str,
    relative_base: Option<&Path>,
) -> bool {
    let glob_pattern = glob_pattern.replace('\\', "/");
    let matcher = match GlobBuilder::new(&glob_pattern)
        .case_insensitive(cfg!(windows))
        .literal_separator(true)
        .build()
    {
        Ok(glob) => glob.compile_matcher(),
        Err(error) => {
            log::warn!("ignoring invalid LSP watched-file glob '{glob_pattern}': {error}");
            return false;
        }
    };
    watched_file_match_paths(root_uri, uri, relative_base)
        .is_some_and(|paths| paths.iter().any(|path| matcher.is_match(path)))
}

pub(super) fn watched_file_registration_matches(
    registration: &DynamicCapabilityRegistration,
    root_uri: &str,
    uri: &str,
    watch_kind: u8,
) -> bool {
    let watchers = registration
        .register_options
        .get("watchers")
        .and_then(Value::as_array);
    let Some(watchers) = watchers else {
        return false;
    };
    watchers.iter().any(|watcher| {
        let Some(glob_pattern) = watcher.get("globPattern") else {
            return false;
        };
        let kind = watcher
            .get("kind")
            .and_then(Value::as_u64)
            .unwrap_or(u64::from(WATCH_KIND_ALL));
        if kind > u64::from(WATCH_KIND_ALL) || (kind as u8 & watch_kind) == 0 {
            return false;
        }
        match glob_pattern {
            Value::String(glob) => watched_file_glob_matches(root_uri, uri, glob, None),
            Value::Object(pattern) => {
                let Some(glob) = pattern.get("pattern").and_then(Value::as_str) else {
                    return false;
                };
                let relative_base = relative_pattern_base_path(&json!(pattern));
                watched_file_glob_matches(root_uri, uri, glob, relative_base.as_deref())
            }
            _ => false,
        }
    })
}

pub(super) fn file_operation_filter_matches(
    filter: &Value,
    root_uri: &str,
    uri: &str,
    is_directory: bool,
) -> bool {
    let Ok(uri_value) = url::Url::parse(uri) else {
        return false;
    };
    if let Some(scheme) = filter.get("scheme").and_then(Value::as_str)
        && !uri_value.scheme().eq_ignore_ascii_case(scheme)
    {
        return false;
    }
    let Some(pattern) = filter.get("pattern") else {
        return false;
    };
    match pattern.get("matches").and_then(Value::as_str) {
        Some("file") if is_directory => return false,
        Some("folder") if !is_directory => return false,
        Some("file" | "folder") | None => {}
        Some(_) => return false,
    }
    let Some(glob) = pattern.get("glob").and_then(Value::as_str) else {
        return false;
    };
    let ignore_case = pattern
        .get("options")
        .and_then(|options| options.get("ignoreCase"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let matcher = match GlobBuilder::new(glob)
        .case_insensitive(ignore_case)
        .literal_separator(true)
        .build()
    {
        Ok(glob) => glob.compile_matcher(),
        Err(error) => {
            log::warn!("ignoring invalid LSP file operation glob '{glob}': {error}");
            return false;
        }
    };
    file_operation_match_paths(root_uri, uri)
        .is_some_and(|paths| paths.iter().any(|path| matcher.is_match(path)))
}

pub(super) fn file_operation_matches_filters(
    filters: &[Value],
    root_uri: &str,
    uri: &str,
    is_directory: bool,
) -> bool {
    filters
        .iter()
        .any(|filter| file_operation_filter_matches(filter, root_uri, uri, is_directory))
}

pub(super) fn workspace_file_operation_params(
    root_uri: &str,
    operation: &LspWorkspaceFileOperation,
    filters: &[Value],
) -> Result<Option<Value>, String> {
    let files = match operation {
        LspWorkspaceFileOperation::Create { files }
        | LspWorkspaceFileOperation::Delete { files } => files
            .iter()
            .map(|file| {
                let uri = file_operation_uri(&file.path)?;
                Ok(
                    file_operation_matches_filters(filters, root_uri, &uri, file.is_directory)
                        .then(|| json!({ "uri": uri })),
                )
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>(),
        LspWorkspaceFileOperation::Rename { files } => files
            .iter()
            .map(|file| {
                let old_uri = file_operation_uri(&file.old_path)?;
                let new_uri = file_operation_uri(&file.new_path)?;
                let matches =
                    file_operation_matches_filters(filters, root_uri, &old_uri, file.is_directory)
                        || file_operation_matches_filters(
                            filters,
                            root_uri,
                            &new_uri,
                            file.is_directory,
                        );
                Ok(matches.then(|| json!({ "oldUri": old_uri, "newUri": new_uri })))
            })
            .collect::<Result<Vec<_>, String>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>(),
    };
    Ok((!files.is_empty()).then(|| json!({ "files": files })))
}
