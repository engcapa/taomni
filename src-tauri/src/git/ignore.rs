use super::*;

pub(super) fn normalize_git_ignore_target(path: &str) -> Result<String, String> {
    let normalized = path.trim().replace('\\', "/");
    let normalized = normalized.trim_start_matches("./").trim_start_matches('/');
    if normalized.is_empty() {
        return Err("Git ignore path is required".into());
    }
    if normalized.contains('\0') {
        return Err("Git ignore path contains an invalid null byte".into());
    }
    if normalized
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err("Git ignore path must stay within the repository".into());
    }
    Ok(normalized.to_string())
}

pub(super) fn escape_git_ignore_literal(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len() + 1);
    for ch in path.chars() {
        if matches!(ch, '\\' | '!' | '*' | '?' | '[' | ']' | '#' | ' ') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

pub(super) fn git_path_matches_ignore(root: &Path, path: &str) -> Result<bool, String> {
    let mut command = new_git_command();
    command
        .current_dir(root)
        .arg("check-ignore")
        .arg("--quiet")
        .arg("--")
        .arg(path);
    apply_stable_locale(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    if output.status.success() {
        return Ok(true);
    }
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    command_output(output).map(|_| false)
}

pub(super) fn git_file_is_tracked(root: &Path, path: &str) -> Result<bool, String> {
    let mut command = new_git_command();
    command
        .current_dir(root)
        .arg("ls-files")
        .arg("--error-unmatch")
        .arg("--")
        .arg(path);
    apply_stable_locale(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    if output.status.success() {
        return Ok(true);
    }
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    command_output(output).map(|_| false)
}

pub(super) fn add_git_ignore_rule(
    root: &Path,
    path: &str,
    directory: bool,
) -> Result<GitIgnoreResult, String> {
    ensure_repo(root)?;
    let target = normalize_git_ignore_target(path)?;
    if !directory && git_file_is_tracked(root, &target)? {
        return Err(format!(
            "Tracked path cannot be ignored until it is removed from the Git index: {target}"
        ));
    }
    let mut rule = format!("/{}", escape_git_ignore_literal(&target));
    if directory {
        rule.push('/');
    }
    let gitignore = root.join(".gitignore");
    if git_path_matches_ignore(root, &target)? {
        return Ok(GitIgnoreResult {
            rule,
            gitignore_path: gitignore.to_string_lossy().to_string(),
            added: false,
        });
    }

    let existing = match fs::read_to_string(&gitignore) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("read {}: {error}", gitignore.display())),
    };
    if existing
        .lines()
        .any(|line| line.trim_end_matches('\r') == rule)
    {
        return Ok(GitIgnoreResult {
            rule,
            gitignore_path: gitignore.to_string_lossy().to_string(),
            added: false,
        });
    }

    let eol = if existing.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut addition = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') && !existing.ends_with('\r') {
        addition.push_str(eol);
    }
    addition.push_str(&rule);
    addition.push_str(eol);
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gitignore)
        .map_err(|error| format!("open {}: {error}", gitignore.display()))?;
    file.write_all(addition.as_bytes())
        .map_err(|error| format!("write {}: {error}", gitignore.display()))?;
    file.sync_all()
        .map_err(|error| format!("sync {}: {error}", gitignore.display()))?;

    Ok(GitIgnoreResult {
        rule,
        gitignore_path: gitignore.to_string_lossy().to_string(),
        added: true,
    })
}
