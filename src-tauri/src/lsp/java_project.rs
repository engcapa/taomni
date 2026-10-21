use super::*;

pub(super) fn sha256_hex_string(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn sha256_hex_file(path: &Path) -> Option<String> {
    // Chunked read: Sha256's io::Write impl is feature-gated upstream.
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Some(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub(super) const BUILD_DESCRIPTOR_NAMES: &[&str] = &[
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
];
pub(super) const BUILD_FILE_SCAN_DEPTH: usize = 3;
pub(super) const BUILD_FILE_MAX_BYTES: u64 = 1024 * 1024;

/// Collect build descriptors under the root (depth-limited, size-capped) with
/// content hashes — the build-model half of the project fingerprint.
pub(super) fn scan_build_file_hashes(root: &Path) -> Vec<LspBuildFileHash> {
    let mut found: Vec<LspBuildFileHash> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Build tool output and VCS metadata never carry descriptors.
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if matches!(name, "target" | "build" | ".git" | "node_modules") {
                    continue;
                }
                if depth + 1 < BUILD_FILE_SCAN_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !BUILD_DESCRIPTOR_NAMES.contains(&name) {
                continue;
            }
            if entry
                .metadata()
                .map(|m| m.len() > BUILD_FILE_MAX_BYTES)
                .unwrap_or(true)
            {
                continue;
            }
            if let Some(hash) = sha256_hex_file(&path) {
                found.push(LspBuildFileHash {
                    path: path.to_string_lossy().into_owned(),
                    sha256: hash,
                });
            }
        }
    }
    found.sort_by(|left, right| left.path.cmp(&right.path));
    found.dedup_by(|left, right| left.path == right.path);
    found
}

/// Tolerant parser for `java.project.list` results. vscode-java returns an
/// array of `{ uri }` objects (older builds returned bare strings); anything
/// else parses to an empty list rather than guessing.
pub(super) fn parse_java_project_list(value: &Value) -> Vec<LspJavaProjectModule> {
    let items = match value {
        Value::Array(items) => Some(items.clone()),
        Value::Object(map) => map.get("projects").and_then(Value::as_array).cloned(),
        _ => None,
    };
    (items.unwrap_or_default())
        .into_iter()
        .filter_map(|item| match item {
            Value::String(uri) => Some(LspJavaProjectModule {
                root_uri: Some(uri.clone()),
                id: uri,
            }),
            Value::Object(map) => {
                let uri = map
                    .get("uri")
                    .or_else(|| map.get("root"))
                    .or_else(|| map.get("rootUri"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let id = uri.clone().unwrap_or_default();
                (!id.is_empty()).then_some(LspJavaProjectModule { id, root_uri: uri })
            }
            _ => None,
        })
        .collect()
}

/// Tolerant parser for `java.project.getClasspaths`: vscode-java answers
/// `{ root, classpaths: [...] }`; accept a raw array too. Returns None when
/// the shape is unrecognizable so the caller records an honest reason.
pub(super) fn parse_java_classpath_probe(value: &Value) -> Option<LspJavaClasspathProbe> {
    let entries: Vec<String> = match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|entry| entry.as_str().map(str::to_owned))
            .collect(),
        Value::Object(map) => map
            .get("classpaths")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|entry| entry.as_str().map(str::to_owned))
                    .collect()
            })?,
        _ => return None,
    };
    let root_uri = value
        .get("root")
        .or_else(|| value.get("projectRoot"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut sorted = entries.clone();
    sorted.sort();
    Some(LspJavaClasspathProbe {
        root_uri,
        entry_count: sorted.len() as u64,
        entries_sha256: sha256_hex_string(&sorted.join("\n")),
    })
}

/// §8.20.3 W2: provider-owned Project Analysis facts for the language server
/// session that serves this file. Never rejects — unavailability is reported
/// inside the payload so UI states stay explainable.
#[tauri::command]
pub async fn lsp_java_project_model(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    document_uri: Option<String>,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspJavaProjectModelResult, String> {
    let mut document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    if let Some(uri) = document_uri
        .as_deref()
        .map(str::trim)
        .filter(|uri| !uri.is_empty())
    {
        document.uri = uri.to_string();
    }
    Ok(state
        .workspace
        .lsp
        .java_project_model(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await)
}
