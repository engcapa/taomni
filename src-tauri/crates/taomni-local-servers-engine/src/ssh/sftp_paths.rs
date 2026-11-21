use russh_sftp::protocol::StatusCode;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

/// Resolve a client SFTP path against the export `root`, treating the client's
/// view as rooted at "/" and rejecting any traversal that would climb above the
/// root. Pulled out as a free function so it can be unit-tested without an
/// `AppHandle`/`LogEmitter`.
pub(super) fn confine_path(root: &Path, requested: &str) -> Result<PathBuf, StatusCode> {
    let rel = Path::new(requested);
    let mut out = root.to_path_buf();
    let mut depth: i32 = 0;
    for comp in rel.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {
                // Reset to root; the export root is the client's "/".
                out = root.to_path_buf();
                depth = 0;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return Err(StatusCode::PermissionDenied);
                }
                depth -= 1;
                out.pop();
            }
            Component::Normal(seg) => {
                depth += 1;
                out.push(seg);
            }
        }
    }
    Ok(out)
}

/// Render a real path back to the client-visible absolute path (rooted at "/").
pub(super) fn canonical_client_path(root: &Path, resolved: &Path) -> String {
    match resolved.strip_prefix(root) {
        Ok(rel) => {
            let s = rel.to_string_lossy().replace('\\', "/");
            if s.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", s)
            }
        }
        Err(_) => "/".to_string(),
    }
}
