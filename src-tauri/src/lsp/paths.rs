use super::*;

pub(super) fn resolve_document(
    workspace_id: String,
    root_path: Option<String>,
    file_path: String,
    language_id: Option<String>,
    version: i64,
) -> Result<ResolvedDocument, String> {
    let trimmed_workspace = workspace_id.trim();
    let workspace_id = if trimmed_workspace.is_empty() {
        "default".to_string()
    } else {
        trimmed_workspace.to_string()
    };
    let path = resolve_file_path(root_path.as_deref(), &file_path)?;
    let root_path = resolve_root_path(root_path.as_deref(), &path)?;
    let uri = url::Url::from_file_path(&path)
        .map_err(|_| format!("Cannot convert path to file URI: {}", path.display()))?
        .to_string();
    let detected = language_id
        .as_deref()
        .and_then(detect_language_id)
        .or_else(|| detect_language_for_path(&path));
    let preset = detected
        .as_ref()
        .and_then(|detected| find_preset(&detected.preset_id));
    Ok(ResolvedDocument {
        path,
        uri,
        root_path,
        workspace_id,
        preset,
        language_id: detected.map(|detected| detected.language_id),
        version,
    })
}

/// Retarget a resolved document at a virtual URI (a `jdt://` library buffer) while
/// keeping the origin file's path for session / SDK selection: library sources have
/// no project of their own, so requests must ride the origin project's session.
pub(super) fn with_document_uri(
    mut document: ResolvedDocument,
    document_uri: Option<String>,
) -> ResolvedDocument {
    if let Some(uri) = document_uri
        .map(|uri| uri.trim().to_string())
        .filter(|uri| !uri.is_empty())
    {
        document.uri = uri;
    }
    document
}

pub(super) fn resolve_file_path(
    root_path: Option<&str>,
    file_path: &str,
) -> Result<PathBuf, String> {
    let file = Path::new(file_path);
    let path = if file.is_absolute() {
        file.to_path_buf()
    } else if let Some(root) = root_path.map(str::trim).filter(|root| !root.is_empty()) {
        Path::new(root).join(file)
    } else {
        file.to_path_buf()
    };
    Ok(path)
}

pub(super) fn resolve_root_path(
    root_path: Option<&str>,
    file_path: &Path,
) -> Result<PathBuf, String> {
    if let Some(root) = root_path.map(str::trim).filter(|root| !root.is_empty()) {
        return Ok(PathBuf::from(root));
    }
    file_path.parent().map(Path::to_path_buf).ok_or_else(|| {
        format!(
            "Cannot resolve parent directory for {}",
            file_path.display()
        )
    })
}

/// Pick the directory to hand a language server as its `rootUri` / working dir.
///
/// `project_scope_path` comes from the SDK resolver, which canonicalizes the
/// workspace root (`std::fs::canonicalize`). Document URIs, however, are built
/// from `document.root_path` — the exact (often un-canonicalized) path the user
/// opened. When the workspace is reached through a symlink (e.g. the opened path
/// `/data/foo` is a link to `/data-raw-ssd/foo`), those two namespaces diverge.
///
/// rust-analyzer maps files to crates by VFS **path prefix**: if the launch root
/// is `/data-raw-ssd/foo` but a document opens as `file:///data/foo/src/main.rs`,
/// the file falls outside the workspace and gets no crate, so hover/completion/
/// goto/diagnostics all go silent even though the session initialized fine.
///
/// Re-express the scope in the opened path's namespace so the launch root shares
/// a prefix with the document URIs:
/// - scope canonically equals the opened root  → use the opened root verbatim;
/// - scope is a canonical descendant of the opened root (nested subproject) →
///   rebase that suffix onto the opened root;
/// - otherwise (unrelated / no canonical form)  → fall back to the scope as-is.
///
/// The session *key* still uses the canonical `project_scope_path`, so dedup and
/// fingerprinting remain stable regardless of which symlink alias was opened.
pub(super) fn lsp_session_root(document_root: &Path, project_scope_path: &str) -> PathBuf {
    let scope = PathBuf::from(project_scope_path);
    let canonical_root = canonicalize_or_original(document_root);
    if scope == canonical_root {
        return document_root.to_path_buf();
    }
    if let Ok(suffix) = scope.strip_prefix(&canonical_root) {
        return document_root.join(suffix);
    }
    scope
}

pub(super) fn canonicalize_or_original(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub(super) fn session_key(
    document: &ResolvedDocument,
    preset: &LspServerPreset,
    command: &LspServerCommandPreset,
    sdk_environment: &WorkspaceSdkEnvironment,
) -> LspSessionKey {
    LspSessionKey {
        workspace_id: document.workspace_id.clone(),
        preset_id: preset.id.clone(),
        root_path: sdk_environment.project_scope_path.clone(),
        command_id: command.id.clone(),
        sdk_fingerprint: sdk_environment.fingerprint.clone(),
    }
}

pub(super) fn path_from_uri(uri: &str) -> Option<String> {
    let trimmed = uri.trim();
    if trimmed.is_empty() {
        return None;
    }

    // jar:file:///path/to.jar!/com/Foo.class — not a plain filesystem path.
    // Open via java/classFileContents (or fail for non-Java servers).
    if trimmed.to_ascii_lowercase().starts_with("jar:file:") {
        return None;
    }

    if trimmed.starts_with("file:") {
        return path_from_file_uri(trimmed);
    }

    // Some servers emit raw absolute paths instead of file:// URIs.
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Some(normalize_os_path_string(trimmed.to_string()));
    }
    None
}

pub(super) fn path_from_file_uri(uri: &str) -> Option<String> {
    url::Url::parse(uri)
        .ok()
        .filter(|url| url.scheme() == "file")
        .and_then(|url| url.to_file_path().ok())
        .map(|path| normalize_os_path_string(path.to_string_lossy().into_owned()))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ArchiveDocumentUri {
    pub(super) archive_path: PathBuf,
    pub(super) entry_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ArchiveSourceContents {
    pub(super) text: String,
    pub(super) title: String,
    pub(super) container: Option<String>,
    pub(super) language_id: String,
}

/// Parse the archive URI shapes emitted by Metals and Kotlin language servers:
/// `jar:file:///.../sources.jar!/pkg/Foo.scala`, `jar:///...`, and
/// `kls:file:///.../library.jar!/pkg/Foo.kt?source=true`.
pub(super) fn archive_document_uri(uri: &str) -> Option<ArchiveDocumentUri> {
    let trimmed = uri.trim();
    let scheme_end = trimmed.find(':')?;
    let scheme = trimmed[..scheme_end].to_ascii_lowercase();
    if scheme != "jar" && scheme != "kls" {
        return None;
    }
    let nested = &trimmed[scheme_end + 1..];
    let (archive_uri, entry) = nested.split_once("!/").or_else(|| nested.split_once('!'))?;
    let archive_path = if archive_uri.to_ascii_lowercase().starts_with("file:") {
        PathBuf::from(path_from_file_uri(archive_uri)?)
    } else if archive_uri.starts_with('/') {
        PathBuf::from(path_from_file_uri(&format!("file:{archive_uri}"))?)
    } else {
        let path = PathBuf::from(archive_uri);
        path.is_absolute().then_some(path)?
    };
    let encoded_entry = entry
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_start_matches('/');
    let entry_path = urlencoding::decode(encoded_entry).ok()?.replace('\\', "/");
    (!entry_path.is_empty()).then_some(ArchiveDocumentUri {
        archive_path,
        entry_path,
    })
}

pub(super) fn is_archive_source_path(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "java"
            | "kt"
            | "kts"
            | "scala"
            | "sc"
            | "sbt"
            | "groovy"
            | "clj"
            | "cs"
            | "swift"
            | "swiftinterface"
            | "c"
            | "h"
            | "cc"
            | "cpp"
            | "cxx"
            | "hpp"
            | "hh"
            | "hxx"
            | "py"
            | "pyi"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
    )
}

/// Read a source entry directly from an SDK/dependency archive. Binary `.class`,
/// `.tasty`, and JDK module entries deliberately fall through to the language
/// server's virtual-document/decompiler extension.
pub(super) fn read_archive_source_contents(
    uri: &str,
) -> Result<Option<ArchiveSourceContents>, String> {
    let Some(document) = archive_document_uri(uri) else {
        return Ok(None);
    };
    if !is_archive_source_path(&document.entry_path) {
        return Ok(None);
    }
    let file = std::fs::File::open(&document.archive_path).map_err(|error| {
        format!(
            "open source archive {}: {error}",
            document.archive_path.display()
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        format!(
            "read source archive {}: {error}",
            document.archive_path.display()
        )
    })?;
    let mut entry = archive.by_name(&document.entry_path).map_err(|error| {
        format!(
            "read {} from {}: {error}",
            document.entry_path,
            document.archive_path.display()
        )
    })?;
    if entry.size() > MAX_VIRTUAL_DOCUMENT_BYTES {
        return Err(format!(
            "Archive source {} is too large ({} bytes; limit {} bytes)",
            document.entry_path,
            entry.size(),
            MAX_VIRTUAL_DOCUMENT_BYTES
        ));
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .by_ref()
        .take(MAX_VIRTUAL_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read archive source {}: {error}", document.entry_path))?;
    if bytes.len() as u64 > MAX_VIRTUAL_DOCUMENT_BYTES {
        return Err(format!(
            "Archive source {} exceeds the {} byte limit",
            document.entry_path, MAX_VIRTUAL_DOCUMENT_BYTES
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| {
        format!(
            "Archive entry {} is not UTF-8 source text",
            document.entry_path
        )
    })?;
    let title = Path::new(&document.entry_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| document.entry_path.clone());
    let container = document
        .archive_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    Ok(Some(ArchiveSourceContents {
        language_id: language_id_from_uri(&document.entry_path),
        text,
        title,
        container,
    }))
}

pub(super) fn normalize_os_path_string(path: String) -> String {
    // Windows extended-length prefix breaks relativePathWithinRoot comparisons.
    path.strip_prefix(r"\\?\")
        .unwrap_or(path.as_str())
        .to_string()
}

pub(super) fn is_virtual_class_uri(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    lower.starts_with("jdt:")
        || lower.starts_with("jar:file:")
        || lower.contains(".class?")
        || lower.ends_with(".class")
}

pub(super) fn language_id_from_uri(uri: &str) -> String {
    let lower = uri
        .split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .to_ascii_lowercase();
    if lower.ends_with(".tsx") {
        "typescriptreact".into()
    } else if lower.ends_with(".ts") || lower.ends_with(".mts") || lower.ends_with(".cts") {
        "typescript".into()
    } else if lower.ends_with(".jsx") {
        "javascriptreact".into()
    } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
        "javascript".into()
    } else if lower.ends_with(".kt") || lower.ends_with(".kts") {
        "kotlin".into()
    } else if lower.ends_with(".scala") || lower.ends_with(".sc") {
        "scala".into()
    } else if lower.ends_with(".rs") {
        "rust".into()
    } else if lower.ends_with(".py") || lower.ends_with(".pyi") {
        "python".into()
    } else if lower.ends_with(".go") {
        "go".into()
    } else if lower.ends_with(".cs") || lower.ends_with(".csx") {
        "csharp".into()
    } else if lower.ends_with(".swift") || lower.ends_with(".swiftinterface") {
        "swift".into()
    } else if [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"]
        .iter()
        .any(|extension| lower.ends_with(extension))
    {
        "cpp".into()
    } else {
        "java".into()
    }
}

/// Best-effort display name for jdt://contents/.../String.class?=... URIs.
pub(super) fn title_from_class_uri(uri: &str) -> String {
    // jdt://contents/java.base/java.lang/String.class?=java.base/...
    if let Some(after) = uri.split("://").nth(1) {
        let path_part = after.split('?').next().unwrap_or(after);
        if let Some(name) = path_part.rsplit('/').next() {
            let clean = name.trim();
            if !clean.is_empty() {
                if clean.ends_with(".class") {
                    return clean[..clean.len() - 6].to_string() + ".java";
                }
                return clean.to_string();
            }
        }
    }
    "Library Class".into()
}

/// Where a library class came from, shown as the editor tab subtitle:
/// `java.lang · java.base` for jdt:// URIs, `com.foo · lib.jar` for jar: URIs.
pub(super) fn container_from_class_uri(uri: &str) -> Option<String> {
    let after = uri.split("://").nth(1)?;
    let path = after.split('?').next().unwrap_or(after);
    if uri.to_ascii_lowercase().starts_with("jar:file:") {
        // /path/to/lib.jar!/com/foo/Bar.class
        let (archive, entry) = path.split_once("!/")?;
        let jar = archive.rsplit('/').next().unwrap_or(archive);
        let package = entry
            .rsplit_once('/')
            .map(|(dir, _)| dir.replace('/', "."))
            .unwrap_or_default();
        return Some(if package.is_empty() {
            jar.to_string()
        } else {
            format!("{package} · {jar}")
        });
    }
    // contents/java.base/java.lang/String.class
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 4 {
        return None;
    }
    let jar = segments[1].trim();
    let package = segments[2].trim();
    let package = if package.is_empty() {
        "(default package)"
    } else {
        package
    };
    if jar.is_empty() {
        return Some(package.to_string());
    }
    Some(format!("{package} · {jar}"))
}

pub(super) fn detect_language_id(language_id: &str) -> Option<DetectedLanguage> {
    let language_id = language_id.trim();
    let preset_id = match language_id {
        "typescript" | "typescriptreact" | "javascript" | "javascriptreact" => {
            "typescript-javascript"
        }
        "rust" => "rust",
        "python" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "cpp" | "objective-c" | "objective-cpp" => "cpp",
        "kotlin" => "kotlin",
        "scala" => "scala",
        "csharp" => "csharp",
        "swift" => "swift",
        _ => return None,
    };
    Some(DetectedLanguage {
        preset_id: preset_id.to_string(),
        language_id: language_id.to_string(),
    })
}

pub(super) fn detect_language_for_path(path: &Path) -> Option<DetectedLanguage> {
    let file_name = path.file_name()?.to_string_lossy().to_lowercase();
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    let language_id = match extension.as_str() {
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "go" => "go",
        "java" => "java",
        "c" => "c",
        "h" => {
            if file_name.ends_with(".h") {
                "cpp"
            } else {
                return None;
            }
        }
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "kt" | "kts" => "kotlin",
        "scala" | "sc" => "scala",
        "cs" | "csx" => "csharp",
        "swift" => "swift",
        _ => return None,
    };
    detect_language_id(language_id)
}
