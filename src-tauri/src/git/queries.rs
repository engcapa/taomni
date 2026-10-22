use super::*;

pub(super) fn parse_status(output: &str) -> (Option<String>, bool, Vec<GitChange>) {
    let mut current_branch = None;
    let mut detached = false;
    let mut changes = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            if rest.starts_with("HEAD ") || rest.starts_with("HEAD(") {
                detached = true;
            } else {
                let branch_source = rest.strip_prefix("No commits yet on ").unwrap_or(rest);
                let branch = branch_source
                    .split("...")
                    .next()
                    .unwrap_or(branch_source)
                    .trim()
                    .trim_end_matches("[gone]")
                    .trim();
                current_branch = non_empty_string(branch);
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let rest = line[3..].trim();
        let (old_path, path) = match rest.split_once(" -> ") {
            Some((old, new)) => (Some(unquote_path(old)), unquote_path(new)),
            None => (None, unquote_path(rest)),
        };
        let conflict = matches!(
            (x, y),
            ('U', 'U')
                | ('A', 'A')
                | ('D', 'D')
                | ('A', 'U')
                | ('U', 'A')
                | ('D', 'U')
                | ('U', 'D')
        );
        let staged = x != ' ' && x != '?';
        let unstaged = y != ' ' || x == '?';
        let status = if conflict {
            "conflicted"
        } else if x == '?' && y == '?' {
            "untracked"
        } else if x == 'R' || y == 'R' {
            "renamed"
        } else if x == 'D' || y == 'D' {
            "deleted"
        } else if x == 'A' || y == 'A' {
            "added"
        } else {
            "modified"
        };
        changes.push(GitChange {
            path,
            old_path,
            status: status.to_string(),
            staged,
            unstaged,
            conflict,
        });
    }
    (current_branch, detached, changes)
}

pub(super) fn unquote_path(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        trimmed.to_string()
    }
}

pub(super) fn ahead_behind(root: &Path, upstream: Option<&str>) -> (u32, u32) {
    if upstream.is_none() {
        return (0, 0);
    }
    run_git_in(
        Some(root),
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .ok()
    .and_then(|raw| {
        let mut parts = raw.split_whitespace();
        let ahead = parts.next()?.parse().ok()?;
        let behind = parts.next()?.parse().ok()?;
        Some((ahead, behind))
    })
    .unwrap_or((0, 0))
}

pub(super) fn list_remote_names(root: &Path) -> Result<Vec<String>, String> {
    Ok(run_git_in(Some(root), ["remote"])?
        .lines()
        .filter_map(non_empty_string)
        .collect())
}

pub(super) fn list_remotes(root: &Path) -> Result<Vec<GitRemote>, String> {
    let mut remotes = Vec::new();
    for name in list_remote_names(root)? {
        let fetch_url = run_git_in(Some(root), ["remote", "get-url", name.as_str()])?;
        let push_url = run_git_in(Some(root), ["remote", "get-url", "--push", name.as_str()])
            .ok()
            .and_then(|s| non_empty_string(&s))
            .filter(|url| url != fetch_url.trim());
        remotes.push(GitRemote {
            username: get_config(root, &remote_auth_key(&name, "username")),
            token_ref: get_config(root, &remote_auth_key(&name, "tokenRef")),
            name,
            fetch_url: fetch_url.trim().to_string(),
            push_url,
        });
    }
    Ok(remotes)
}

pub(super) fn remote_auth_key(remote: &str, leaf: &str) -> String {
    let safe_remote: String = remote
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    format!("{AUTH_SECTION}.{safe_remote}.{leaf}")
}

pub(super) fn load_settings(root: &Path) -> GitRepoSettings {
    GitRepoSettings {
        user_name: get_config(root, "user.name"),
        user_email: get_config(root, "user.email"),
        http_proxy: get_config(root, "http.proxy"),
        https_proxy: get_config(root, "https.proxy"),
        pull_rebase: get_config(root, "pull.rebase"),
        push_default: get_config(root, "push.default"),
        core_autocrlf: get_config(root, "core.autocrlf"),
        core_filemode: get_config(root, "core.filemode"),
        commit_gpgsign: get_config(root, "commit.gpgsign"),
    }
}

pub(super) fn get_config(root: &Path, key: &str) -> Option<String> {
    run_git_in(Some(root), ["config", "--local", "--get", key])
        .ok()
        .and_then(|value| non_empty_string(&value))
}

pub(super) fn set_optional_config(
    root: &Path,
    key: &str,
    value: Option<String>,
) -> Result<(), String> {
    match value.and_then(|s| non_empty_string(&s)) {
        Some(value) => {
            run_git_in(Some(root), ["config", "--local", key, value.as_str()]).map(|_| ())
        }
        None => unset_config(root, key),
    }
}

pub(super) fn unset_config(root: &Path, key: &str) -> Result<(), String> {
    let _ = run_git_in(Some(root), ["config", "--local", "--unset", key]);
    Ok(())
}

pub(super) fn list_branches(root: &Path) -> Result<Vec<GitBranch>, String> {
    let raw = run_git_in(
        Some(root),
        [
            "for-each-ref",
            "refs/heads",
            "refs/remotes",
            "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(HEAD)%1f%(objectname:short)%1f%(subject)%1f%(committerdate:iso-strict)",
        ],
    )?;
    let mut branches = Vec::new();
    for line in raw.lines() {
        let parts: Vec<_> = line.split('\x1f').collect();
        if parts.len() < 6 {
            continue;
        }
        let full_name = parts[0].to_string();
        if full_name.ends_with("/HEAD") {
            continue;
        }
        branches.push(GitBranch {
            name: parts[1].to_string(),
            full_name: full_name.clone(),
            current: parts[3] == "*",
            remote: full_name.starts_with("refs/remotes/"),
            upstream: non_empty_string(parts[2]),
            oid: non_empty_string(parts[4]),
            subject: non_empty_string(parts[5]),
            date: parts.get(6).and_then(|s| non_empty_string(s)),
        });
    }
    Ok(branches)
}

pub(super) fn list_log(root: &Path, filter: &GitLogFilter) -> Result<Vec<GitLogEntry>, String> {
    let limit = filter.limit.unwrap_or(120).clamp(1, 2000).to_string();
    let mut args: Vec<String> = vec![
        "log".into(),
        "--date=iso-strict".into(),
        "--pretty=format:%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D%x1f%b".into(),
        "-n".into(),
        limit,
    ];
    if let Some(skip) = filter.skip.filter(|n| *n > 0) {
        args.push("--skip".into());
        args.push(skip.to_string());
    }
    if let Some(author) = filter.author.as_deref().and_then(non_empty_string) {
        args.push("--author".into());
        args.push(author);
    }
    if let Some(grep) = filter.grep.as_deref().and_then(non_empty_string) {
        args.push("-i".into());
        args.push("--grep".into());
        args.push(grep);
    }
    if let Some(after) = filter.after.as_deref().and_then(non_empty_string) {
        args.push("--after".into());
        args.push(after);
    }
    if let Some(before) = filter.before.as_deref().and_then(non_empty_string) {
        args.push("--before".into());
        args.push(before);
    }
    if let Some(branch) = filter.branch.as_deref().and_then(non_empty_string) {
        args.push(branch);
    } else if filter.all.unwrap_or(false) {
        args.push("--all".into());
    }
    if let Some(path) = filter.path.as_deref().and_then(non_empty_string) {
        args.push("--".into());
        args.push(path);
    }
    let raw = run_git_strings(Some(root), args)?;
    Ok(parse_log_entries(&raw))
}

pub(super) fn parse_log_entries(raw: &str) -> Vec<GitLogEntry> {
    let mut entries = Vec::new();
    for record in raw.split('\x1e') {
        let record = record.trim_start_matches('\n').trim_end_matches('\n');
        if record.is_empty() {
            continue;
        }
        let parts: Vec<_> = record.splitn(9, '\x1f').collect();
        if parts.len() < 7 {
            continue;
        }
        entries.push(GitLogEntry {
            oid: parts[0].to_string(),
            short_oid: parts[1].to_string(),
            parents: parts[2]
                .split_whitespace()
                .filter_map(non_empty_string)
                .collect(),
            author_name: parts[3].to_string(),
            author_email: parts[4].to_string(),
            date: parts[5].to_string(),
            subject: parts[6].to_string(),
            refs: parts.get(7).map(|d| parse_refs(d)).unwrap_or_default(),
            body: parts.get(8).map(|d| trim_log_body(d)).unwrap_or_default(),
        });
    }
    entries
}

pub(super) fn trim_log_body(body: &str) -> String {
    body.trim_matches(|c| c == '\n' || c == '\r').to_string()
}

/// Parse a `%D` decoration string ("HEAD -> main, origin/main, tag: v1") into
/// short ref labels for chips.
pub(super) fn parse_refs(decoration: &str) -> Vec<String> {
    decoration
        .split(", ")
        .filter_map(|token| {
            let token = token.trim();
            let cleaned = token
                .strip_prefix("HEAD -> ")
                .or_else(|| token.strip_prefix("tag: "))
                .unwrap_or(token);
            non_empty_string(cleaned)
        })
        .filter(|t| t != "HEAD")
        .collect()
}

pub(super) fn parse_name_status(output: &str) -> Vec<GitChange> {
    let mut out = Vec::new();
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\t');
        let code = parts.next().unwrap_or("");
        let c0 = code.chars().next().unwrap_or(' ');
        let (old_path, path) = match c0 {
            'R' | 'C' => {
                let old = parts.next().map(unquote_path);
                let new = parts.next().map(unquote_path).or_else(|| old.clone());
                (old, new.unwrap_or_default())
            }
            _ => (None, parts.next().map(unquote_path).unwrap_or_default()),
        };
        let status = match c0 {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            _ => "modified",
        };
        out.push(GitChange {
            path,
            old_path,
            status: status.to_string(),
            staged: false,
            unstaged: false,
            conflict: false,
        });
    }
    out
}

pub(super) fn parse_blame_porcelain(output: &str) -> Vec<GitBlameLine> {
    #[derive(Default)]
    struct PendingLine {
        commit: String,
        line: Option<u32>,
        author: String,
        author_mail: Option<String>,
        author_time: i64,
        summary: String,
    }

    let mut pending = PendingLine::default();
    let mut result = Vec::new();
    for line in output.lines() {
        if line.starts_with('\t') {
            if let Some(line_number) = pending.line.take() {
                result.push(GitBlameLine {
                    line: line_number,
                    commit: std::mem::take(&mut pending.commit),
                    author: std::mem::take(&mut pending.author),
                    author_mail: pending.author_mail.take(),
                    author_time: pending.author_time,
                    summary: std::mem::take(&mut pending.summary),
                });
            }
            pending = PendingLine::default();
            continue;
        }

        let mut header = line.split_whitespace();
        let maybe_commit = header.next().unwrap_or_default();
        let maybe_original = header.next().and_then(|value| value.parse::<u32>().ok());
        let maybe_final = header.next().and_then(|value| value.parse::<u32>().ok());
        if maybe_commit.len() >= 8 && maybe_original.is_some() && maybe_final.is_some() {
            pending.commit = maybe_commit.to_string();
            pending.line = maybe_final;
            continue;
        }
        if let Some(value) = line.strip_prefix("author ") {
            pending.author = value.to_string();
        } else if let Some(value) = line.strip_prefix("author-mail ") {
            pending.author_mail = non_empty_string(value.trim_matches(['<', '>']));
        } else if let Some(value) = line.strip_prefix("author-time ") {
            pending.author_time = value.parse().unwrap_or_default();
        } else if let Some(value) = line.strip_prefix("summary ") {
            pending.summary = value.to_string();
        }
    }
    result
}

pub(super) fn list_tags(root: &Path) -> Result<Vec<GitTag>, String> {
    let raw = run_git_in(
        Some(root),
        [
            "for-each-ref",
            "refs/tags",
            "--sort=-creatordate",
            "--format=%(refname:short)%1f%(objectname:short)%1f%(objecttype)%1f%(contents:subject)%1f%(creatordate:iso-strict)",
        ],
    )?;
    let mut tags = Vec::new();
    for line in raw.lines() {
        let parts: Vec<_> = line.split('\x1f').collect();
        if parts.len() < 4 {
            continue;
        }
        tags.push(GitTag {
            name: parts[0].to_string(),
            oid: parts[1].to_string(),
            annotated: parts[2] == "tag",
            subject: non_empty_string(parts[3]),
            date: parts.get(4).and_then(|s| non_empty_string(s)),
        });
    }
    Ok(tags)
}

pub(super) fn list_stashes(root: &Path) -> Result<Vec<GitStashEntry>, String> {
    let raw = run_git_in(
        Some(root),
        [
            "stash",
            "list",
            "--date=iso-strict",
            "--pretty=format:%gd%x1f%H%x1f%cr%x1f%gs",
        ],
    )?;
    let mut stashes = Vec::new();
    for line in raw.lines() {
        let parts: Vec<_> = line.split('\x1f').collect();
        if parts.len() < 4 {
            continue;
        }
        stashes.push(GitStashEntry {
            selector: parts[0].to_string(),
            oid: parts[1].to_string(),
            date: parts[2].to_string(),
            message: parts[3].to_string(),
        });
    }
    Ok(stashes)
}
