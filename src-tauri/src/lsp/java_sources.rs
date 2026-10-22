use super::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ServerVirtualDocument {
    pub(super) text: String,
    pub(super) title: String,
    pub(super) container: Option<String>,
    pub(super) language_id: String,
    pub(super) decompiled: bool,
}

pub(super) fn source_extension_for_language(language_id: &str) -> &'static str {
    match language_id {
        "kotlin" => "kt",
        "scala" => "scala",
        "csharp" => "cs",
        "swift" => "swift",
        "cpp" | "c" => "cpp",
        "python" => "py",
        "rust" => "rs",
        "go" => "go",
        "typescript" | "typescriptreact" => "ts",
        "javascript" | "javascriptreact" => "js",
        _ => "java",
    }
}

pub(super) fn title_from_virtual_uri(uri: &str, language_id: &str) -> String {
    let clean = uri
        .split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .trim_end_matches('/');
    let name = clean
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Library");
    if name.to_ascii_lowercase().ends_with(".class") {
        return format!(
            "{}.{}",
            &name[..name.len() - ".class".len()],
            source_extension_for_language(language_id)
        );
    }
    name.to_string()
}

pub(super) fn response_string<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

pub(super) async fn read_server_virtual_document(
    session: &Arc<LspSession>,
    uri: &str,
) -> Result<ServerVirtualDocument, String> {
    match session.key.preset_id.as_str() {
        "java" if is_virtual_class_uri(uri) => {
            let result = session
                .request_with_timeout(
                    "java/classFileContents",
                    json!({ "uri": uri }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to load Java class contents: {error}"))?;
            let text = result
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "Java language server returned no source for {}: attach a sources JAR or install a decompiler",
                        title_from_class_uri(uri)
                    )
                })?
                .to_string();
            Ok(ServerVirtualDocument {
                title: title_from_class_uri(uri),
                container: container_from_class_uri(uri),
                language_id: "java".into(),
                decompiled: is_decompiled_contents(&text),
                text,
            })
        }
        "kotlin" if uri.to_ascii_lowercase().starts_with("kls:") => {
            let result = session
                .request_with_timeout(
                    "kotlin/jarClassContents",
                    json!({ "uri": uri }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to load Kotlin library contents: {error}"))?;
            let text = result
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "Kotlin language server returned no library source".to_string())?
                .to_string();
            let language_id = language_id_from_uri(uri);
            Ok(ServerVirtualDocument {
                title: title_from_virtual_uri(uri, &language_id),
                container: archive_document_uri(uri).and_then(|document| {
                    document
                        .archive_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                }),
                language_id,
                // This provider may decompile, but only jdtls supports Taomni's
                // on-demand source attachment action.
                decompiled: false,
                text,
            })
        }
        "kotlin" => {
            let result = session
                .request_with_timeout(
                    "workspace/executeCommand",
                    json!({ "command": "decompile", "arguments": [uri] }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to decompile Kotlin library source: {error}"))?;
            let text = response_string(&result, &["code", "Code"])
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "Kotlin language server returned no decompiled source".to_string())?
                .to_string();
            let language_id = response_string(&result, &["language", "Language"])
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("kotlin")
                .to_ascii_lowercase();
            Ok(ServerVirtualDocument {
                title: title_from_virtual_uri(uri, &language_id),
                container: archive_document_uri(uri).and_then(|document| {
                    document
                        .archive_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                }),
                language_id,
                decompiled: false,
                text,
            })
        }
        "scala" => {
            let result = session
                .request_with_timeout(
                    "workspace/executeCommand",
                    json!({ "command": "file-decode", "arguments": [uri] }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to decode Scala library source: {error}"))?;
            let text = response_string(&result, &["value", "Value"])
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| {
                    response_string(&result, &["error", "Error"])
                        .unwrap_or("Metals returned no library source")
                        .to_string()
                })?
                .to_string();
            Ok(ServerVirtualDocument {
                title: title_from_virtual_uri(uri, "scala"),
                container: archive_document_uri(uri).and_then(|document| {
                    document
                        .archive_path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                }),
                language_id: "scala".into(),
                decompiled: false,
                text,
            })
        }
        "csharp" if uri.to_ascii_lowercase().starts_with("csharp:") => {
            let result = session
                .request_with_timeout(
                    "csharp/metadata",
                    json!({ "textDocument": { "uri": uri } }),
                    REQUEST_TIMEOUT_SECS.max(20),
                )
                .await
                .map_err(|error| format!("Failed to load C# metadata source: {error}"))?;
            let text = response_string(&result, &["source", "Source"])
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "C# language server returned no metadata source".to_string())?
                .to_string();
            let assembly = response_string(&result, &["assemblyName", "AssemblyName"]);
            let project = response_string(&result, &["projectName", "ProjectName"]);
            let title = response_string(&result, &["symbolName", "SymbolName"])
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!("{value}.cs"))
                .unwrap_or_else(|| title_from_virtual_uri(uri, "csharp"));
            let container = match (assembly, project) {
                (Some(assembly), Some(project)) => Some(format!("{assembly} · {project}")),
                (Some(assembly), None) => Some(assembly.to_string()),
                (None, Some(project)) => Some(project.to_string()),
                (None, None) => None,
            };
            Ok(ServerVirtualDocument {
                title,
                container,
                language_id: "csharp".into(),
                decompiled: false,
                text,
            })
        }
        preset => Err(format!(
            "{preset} language server returned an unsupported virtual document URI: {uri}"
        )),
    }
}

/// Open library / virtual LSP locations. Real files cover most SDKs (Rust,
/// TypeScript, Python, Go, clangd, Swift). Archive and server-owned documents
/// cover Kotlin, Scala, C#, and Java dependency/JDK definitions.
#[tauri::command]
pub async fn lsp_read_uri_contents(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    uri: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspUriContentsResult, String> {
    let uri = uri.trim().to_string();
    if uri.is_empty() {
        return Err("Missing document URI".into());
    }
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let status = state
        .workspace
        .lsp
        .document_status(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await;

    // Real file on disk (workspace sources, cargo registry, jdt extracted sources, …).
    if let Some(path) = path_from_uri(&uri) {
        let target = PathBuf::from(&path);
        if target.is_file() {
            let text = std::fs::read_to_string(&target)
                .map_err(|e| format!("read {}: {e}", target.display()))?;
            let language = detect_language_for_path(&target)
                .map(|detected| detected.language_id)
                .unwrap_or_else(|| language_id_from_uri(&uri));
            return Ok(LspUriContentsResult {
                status,
                uri,
                path: Some(path.clone()),
                title: target
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone()),
                container: target
                    .parent()
                    .map(|parent| parent.to_string_lossy().into_owned()),
                language_id: language,
                decompiled: is_decompiled_contents(&text),
                text,
                read_only: true,
            });
        }
    }

    // Attached sources in JAR/ZIP files need no server-specific extension.
    // Keep a read error as context, then let the server decompile/fetch instead.
    let archive_error = match read_archive_source_contents(&uri) {
        Ok(Some(contents)) => {
            return Ok(LspUriContentsResult {
                status,
                uri,
                path: None,
                title: contents.title,
                container: contents.container,
                language_id: contents.language_id,
                text: contents.text,
                read_only: true,
                decompiled: false,
            });
        }
        Ok(None) => None,
        Err(error) => Some(error),
    };

    let session = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            archive_error.clone().unwrap_or_else(|| {
                "No language server session is active for this file; cannot open library source"
                    .to_string()
            })
        })?;
    let contents = read_server_virtual_document(&session, &uri)
        .await
        .map_err(|error| match archive_error {
            Some(archive_error) => {
                format!("{error}; direct archive read also failed: {archive_error}")
            }
            None => error,
        })?;
    Ok(LspUriContentsResult {
        status,
        uri,
        path: None,
        title: contents.title,
        container: contents.container,
        language_id: contents.language_id,
        text: contents.text,
        read_only: true,
        decompiled: contents.decompiled,
    })
}

/// Result of an on-demand source-attachment request.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspDownloadSourcesResult {
    /// True when attached (non-decompiled) source is now available for the class.
    pub attached: bool,
    /// Fresh contents for the class (attached source when `attached`, otherwise the
    /// existing decompiled text) so the caller can refresh the buffer in place.
    pub text: String,
    pub decompiled: bool,
    /// User-facing note (why nothing was attached), when `attached` is false.
    pub message: Option<String>,
}

/// FernFlower stamps a fixed banner as the first line of decompiled output; jdtls
/// serves attached source verbatim, so the banner uniquely marks decompiled text.
/// Keep in sync with FernFlowerDecompiler.DECOMPILER_HEADER upstream.
pub(super) const JDTLS_DECOMPILER_HEADER: &str =
    "// Source code is decompiled from a .class file using FernFlower decompiler";

pub(super) fn is_decompiled_contents(text: &str) -> bool {
    text.trim_start().starts_with(JDTLS_DECOMPILER_HEADER)
}

/// IDEA-style "Download sources": enable Maven/Gradle source download for the
/// active jdtls session, trigger a project re-configuration so the build tool
/// fetches the sources JAR, then poll `java/classFileContents` until attached
/// source replaces the decompiled bytecode (or a timeout elapses).
///
/// Kept off by default (so imports stay fast); this only flips it on when the user
/// explicitly asks, matching IntelliJ's on-demand download button.
#[tauri::command]
pub async fn lsp_download_sources(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    uri: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<LspDownloadSourcesResult, String> {
    let uri = uri.trim().to_string();
    if uri.is_empty() {
        return Err("Missing class URI".into());
    }
    if !is_virtual_class_uri(&uri) {
        return Err("Download sources is only available for library class files".into());
    }
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    if document.preset.as_ref().map(|preset| preset.id.as_str()) != Some("java") {
        return Err("Download sources is only available for Java class files".into());
    }
    let session = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;

    // 1) Turn on source download for this session (Maven + Gradle + Eclipse importers).
    session
        .notify(
            "workspace/didChangeConfiguration",
            json!({
                "settings": {
                    "java": {
                        "maven": { "downloadSources": true },
                        "eclipse": { "downloadSources": true },
                        "gradle": { "wrapper": { "enabled": true } },
                        "import": {
                            "maven": { "enabled": true },
                            "gradle": { "enabled": true }
                        }
                    }
                }
            }),
        )
        .await?;

    // 2) Trigger project reconfiguration keyed on the origin project file so the
    //    build tool re-resolves the classpath and pulls the sources JAR.
    session
        .notify(
            "java/projectConfigurationUpdate",
            json!({ "uri": document.uri }),
        )
        .await?;

    // 3) Poll classFileContents until attached source shows up (no decompiler
    //    banner) or we give up. Reconfiguration + download is async in jdtls.
    let mut last_text = String::new();
    for attempt in 0..DOWNLOAD_SOURCES_POLL_ATTEMPTS {
        tokio::time::sleep(Duration::from_millis(DOWNLOAD_SOURCES_POLL_INTERVAL_MS)).await;
        let result = session
            .request_with_timeout("java/classFileContents", json!({ "uri": uri }), 20)
            .await
            .map_err(|e| format!("Failed to reload class contents: {e}"))?;
        let text = result.as_str().unwrap_or_default().to_string();
        if text.trim().is_empty() {
            continue;
        }
        last_text = text;
        if !is_decompiled_contents(&last_text) {
            return Ok(LspDownloadSourcesResult {
                attached: true,
                text: last_text,
                decompiled: false,
                message: None,
            });
        }
        log::debug!(
            "lsp: download sources poll {}/{} still decompiled for {uri}",
            attempt + 1,
            DOWNLOAD_SOURCES_POLL_ATTEMPTS
        );
    }

    Ok(LspDownloadSourcesResult {
        attached: false,
        text: last_text,
        decompiled: true,
        message: Some(
            "No sources published for this artifact (still showing decompiled bytecode). \
             The dependency may not ship a -sources JAR."
                .to_string(),
        ),
    })
}

/// Reload the Java project configuration for the active jdtls session (IDEA's
/// "Reload project"). Notifies `java/projectConfigurationUpdate` keyed on a build
/// file (pom.xml / build.gradle) so jdtls re-imports the Maven/Gradle model after
/// the user edits it. `file_path` should be the changed build file; any project
/// file works since jdtls reconfigures the owning project.
///
/// Fire-and-forget: jdtls reconfigures asynchronously (progress arrives via its
/// own status notifications), so this returns once the notify is delivered.
#[tauri::command]
pub async fn lsp_reload_project(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<(), String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;
    session
        .notify(
            "java/projectConfigurationUpdate",
            json!({ "uri": document.uri }),
        )
        .await
}

/// A Java project/module discovered by jdtls (`java.project.getAll`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JavaModule {
    /// Module name (last path segment of the project directory).
    pub name: String,
    /// Absolute filesystem path to the module root.
    pub path: String,
    /// Original project URI as reported by jdtls.
    pub uri: String,
}

/// Turn jdtls `java.project.getAll` output (an array of `file://` project URIs)
/// into module entries. Non-file / unparseable URIs are skipped; results are
/// de-duplicated and sorted by name for a stable module view.
pub(super) fn parse_java_modules(value: &Value) -> Vec<JavaModule> {
    let mut modules: Vec<JavaModule> = Vec::new();
    let Some(items) = value.as_array() else {
        return modules;
    };
    for item in items {
        let Some(uri) = item.as_str() else {
            continue;
        };
        let path = url::Url::parse(uri)
            .ok()
            .filter(|url| url.scheme() == "file")
            .and_then(|url| url.to_file_path().ok());
        let Some(path) = path else {
            continue;
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("module")
            .to_string();
        let path_str = path.to_string_lossy().into_owned();
        if modules.iter().any(|module| module.path == path_str) {
            continue;
        }
        modules.push(JavaModule {
            name,
            path: path_str,
            uri: uri.to_string(),
        });
    }
    modules.sort_by(|a, b| a.name.cmp(&b.name));
    modules
}

/// List the Java projects/modules in the workspace via jdtls
/// `workspace/executeCommand: java.project.getAll` (M7 F-4). Returns an empty
/// list when the session has no such command; errors when no session is active.
#[tauri::command]
pub async fn lsp_java_modules(
    state: State<'_, AppState>,
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    server_command_id: Option<String>,
    custom_server_command: Option<LspCustomServerCommand>,
) -> Result<Vec<JavaModule>, String> {
    let document = resolve_document(workspace_id, root_path, file_path, language_id, 0)?;
    let session = state
        .workspace
        .lsp
        .active_session(
            &document,
            server_command_id.as_deref(),
            custom_server_command.as_ref(),
        )
        .await
        .ok_or_else(|| {
            "No language server session is active for this project; open a project file first"
                .to_string()
        })?;
    let result = session
        .request(
            "workspace/executeCommand",
            json!({ "command": "java.project.getAll", "arguments": [] }),
        )
        .await
        .map_err(|e| format!("Failed to list Java modules: {e}"))?;
    Ok(parse_java_modules(&result))
}
