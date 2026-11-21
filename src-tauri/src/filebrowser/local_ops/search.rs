use super::model::{OpError, OpResult, OperationFailure};
use super::operation::Operation;
use crate::filebrowser::local;
use crate::filebrowser::sftp::FileEntryDto;
use globset::GlobBuilder;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_DIAGNOSTICS: usize = 20;

#[derive(Debug, Serialize)]
pub struct ExplorerSearchEntry {
    #[serde(flatten)]
    pub entry: FileEntryDto,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerSearchResults {
    pub entries: Vec<ExplorerSearchEntry>,
    pub scanned: u64,
    pub truncated: bool,
    pub cancelled: bool,
    pub failed: Vec<OperationFailure>,
}

#[derive(Clone, Copy)]
pub struct SearchOptions {
    pub recursive: bool,
    pub include_hidden: bool,
    pub max_results: usize,
}

struct SearchMatcher {
    glob: Option<globset::GlobMatcher>,
    path_glob: bool,
    plain: String,
}

impl SearchMatcher {
    fn new(query: &str) -> OpResult<Self> {
        let normalized = query.trim().replace('\\', "/");
        if normalized.is_empty() {
            return Err(OpError::new("invalid_query", "Search query is empty"));
        }
        if normalized.len() > 1024 {
            return Err(OpError::new(
                "invalid_query",
                "Search query exceeds 1024 bytes",
            ));
        }
        let glob_like = normalized
            .chars()
            .any(|value| matches!(value, '*' | '?' | '['));
        if !glob_like && !normalized.contains('/') {
            return Ok(Self {
                glob: None,
                path_glob: false,
                plain: normalized.to_lowercase(),
            });
        }
        let glob = GlobBuilder::new(&normalized)
            .case_insensitive(cfg!(windows))
            .literal_separator(true)
            .build()
            .map_err(|error| OpError::new("invalid_query", format!("Invalid glob: {error}")))?
            .compile_matcher();
        Ok(Self {
            glob: Some(glob),
            path_glob: normalized.contains('/'),
            plain: String::new(),
        })
    }

    fn matches(&self, name: &str, relative: &str) -> bool {
        if let Some(glob) = &self.glob {
            return if self.path_glob {
                glob.is_match(relative)
            } else {
                glob.is_match(name)
            };
        }
        name.to_lowercase().contains(&self.plain) || relative.to_lowercase().contains(&self.plain)
    }
}

pub fn search_entries(
    root: &Path,
    query: &str,
    options: SearchOptions,
    operation: &mut Operation,
) -> OpResult<ExplorerSearchResults> {
    let matcher = SearchMatcher::new(query)?;
    let metadata =
        fs::metadata(root).map_err(|error| OpError::io("stat search root", root, error))?;
    if !metadata.is_dir() {
        return Err(OpError::new(
            "not_directory",
            format!("Not a directory: {}", root.display()),
        ));
    }
    let mut state = SearchState {
        root,
        matcher,
        options,
        operation,
        results: ExplorerSearchResults {
            entries: Vec::new(),
            scanned: 0,
            truncated: false,
            cancelled: false,
            failed: Vec::new(),
        },
    };
    let walked = state.visit(root, true);
    if let Err(error) = walked {
        if error.code == "cancelled" {
            state.results.cancelled = true;
        } else {
            return Err(error);
        }
    }
    Ok(state.results)
}

struct SearchState<'a> {
    root: &'a Path,
    matcher: SearchMatcher,
    options: SearchOptions,
    operation: &'a mut Operation,
    results: ExplorerSearchResults,
}

impl SearchState<'_> {
    fn visit(&mut self, directory: &Path, is_root: bool) -> OpResult<()> {
        let read = match fs::read_dir(directory) {
            Ok(read) => read,
            Err(error) if is_root => return Err(OpError::io("read search root", directory, error)),
            Err(error) => {
                self.failure(
                    directory,
                    "io_error",
                    format!("Cannot read directory: {error}"),
                );
                return Ok(());
            }
        };
        for item in read {
            self.operation.check()?;
            let item = match item {
                Ok(item) => item,
                Err(error) => {
                    self.failure(
                        directory,
                        "io_error",
                        format!("Cannot read directory entry: {error}"),
                    );
                    continue;
                }
            };
            let path = item.path();
            let file_type = match item.file_type() {
                Ok(value) => value,
                Err(error) => {
                    self.failure(&path, "io_error", format!("Cannot read file type: {error}"));
                    continue;
                }
            };
            let name = item.file_name().to_string_lossy().into_owned();
            let hidden = name.starts_with('.');
            if hidden && !self.options.include_hidden && file_type.is_dir() {
                continue;
            }
            if hidden && !self.options.include_hidden {
                continue;
            }
            let relative = path
                .strip_prefix(self.root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            self.results.scanned = self.results.scanned.saturating_add(1);
            self.advance(&path)?;
            if self.matcher.matches(&name, &relative) {
                match local::stat(&path) {
                    Ok(entry) => self.results.entries.push(ExplorerSearchEntry {
                        entry,
                        relative_path: relative.clone(),
                    }),
                    Err(message) => self.failure(&path, "io_error", message),
                }
            }
            if self.results.entries.len() >= self.options.max_results {
                self.results.truncated = true;
                return Ok(());
            }
            if self.options.recursive && file_type.is_dir() && !file_type.is_symlink() {
                self.visit(&path, false)?;
            }
        }
        Ok(())
    }

    fn advance(&mut self, path: &Path) -> OpResult<()> {
        self.operation.advance(path, 0, 1)
    }

    fn failure(&mut self, path: &Path, code: &'static str, message: String) {
        if self.results.failed.len() < MAX_DIAGNOSTICS {
            self.results.failed.push(OperationFailure {
                path: path.to_string_lossy().into_owned(),
                code: code.into(),
                message,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation() -> Operation {
        Operation::register(None, None).unwrap()
    }

    fn options(recursive: bool) -> SearchOptions {
        SearchOptions {
            recursive,
            include_hidden: true,
            max_results: 100,
        }
    }

    #[test]
    fn glob_supports_windows_and_posix_separators_and_recursive_names() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("windows/nested")).unwrap();
        fs::write(root.path().join("windows/linux"), b"x").unwrap();
        fs::write(root.path().join("windows/nested/readme.md"), b"x").unwrap();
        fs::write(root.path().join("top.txt"), b"x").unwrap();
        for pattern in ["windows/*inux", "windows\\*inux"] {
            let result =
                search_entries(root.path(), pattern, options(true), &mut operation()).unwrap();
            assert_eq!(result.entries.len(), 1);
            assert_eq!(result.entries[0].relative_path, "windows/linux");
        }
        let result = search_entries(root.path(), "*.md", options(true), &mut operation()).unwrap();
        assert_eq!(result.entries[0].relative_path, "windows/nested/readme.md");
        let shallow =
            search_entries(root.path(), "*.md", options(false), &mut operation()).unwrap();
        assert!(shallow.entries.is_empty());
    }

    #[test]
    fn plain_text_matches_relative_paths_without_glob_syntax() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("docs")).unwrap();
        fs::write(root.path().join("docs/Notes.TXT"), b"x").unwrap();
        let result =
            search_entries(root.path(), "notes.txt", options(true), &mut operation()).unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].entry.name, "Notes.TXT");
    }

    #[test]
    fn result_limit_and_cancellation_preserve_explicit_states() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), b"x").unwrap();
        fs::write(root.path().join("b.txt"), b"x").unwrap();
        let limited = search_entries(
            root.path(),
            "*.txt",
            SearchOptions {
                recursive: true,
                include_hidden: true,
                max_results: 1,
            },
            &mut operation(),
        )
        .unwrap();
        assert!(limited.truncated);
        assert_eq!(limited.entries.len(), 1);

        let mut cancelled =
            Operation::register(Some("explorer-search-test-cancel".to_string()), None).unwrap();
        super::super::operation::cancel("explorer-search-test-cancel").unwrap();
        let result = search_entries(root.path(), "*.txt", options(true), &mut cancelled).unwrap();
        assert!(result.cancelled);
        assert!(result.entries.is_empty());
    }

    #[test]
    fn hidden_entries_follow_the_visibility_option() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), b"x").unwrap();
        fs::write(root.path().join(".hidden"), b"x").unwrap();
        let hidden = search_entries(
            root.path(),
            "*",
            SearchOptions {
                recursive: true,
                include_hidden: false,
                max_results: 100,
            },
            &mut operation(),
        )
        .unwrap();
        assert!(hidden.entries.is_empty());
        let included =
            search_entries(root.path(), ".git/*", options(true), &mut operation()).unwrap();
        assert_eq!(included.entries.len(), 1);
    }

    #[test]
    fn invalid_patterns_are_actionable_errors() {
        let root = tempfile::tempdir().unwrap();
        let error = search_entries(root.path(), "[", options(true), &mut operation()).unwrap_err();
        assert_eq!(error.code, "invalid_query");
    }

    #[test]
    fn search_does_not_follow_directory_symlinks() {
        #[cfg(unix)]
        {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            fs::write(outside.path().join("outside.txt"), b"x").unwrap();
            std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
            let result =
                search_entries(root.path(), "outside.txt", options(true), &mut operation())
                    .unwrap();
            assert!(result.entries.is_empty());
        }
    }

    #[test]
    fn missing_root_is_an_error_not_an_empty_success() {
        let root = PathBuf::from("/definitely/missing/explorer-search-root");
        let error = search_entries(&root, "*.txt", options(true), &mut operation()).unwrap_err();
        assert_eq!(error.code, "not_found");
    }
}
