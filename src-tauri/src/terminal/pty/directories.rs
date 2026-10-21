use std::path::Path;
use std::path::PathBuf;

pub(crate) fn directory_from_history_command(
    command: &str,
    home: Option<&Path>,
) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (keyword, mut rest) = leading_directory_command(trimmed)?;
    if keyword.eq_ignore_ascii_case("cd") && rest.is_empty() {
        return home.map(PathBuf::from);
    }
    if cfg!(windows)
        && (keyword.eq_ignore_ascii_case("cd") || keyword.eq_ignore_ascii_case("chdir"))
    {
        let lower = rest.to_ascii_lowercase();
        if lower == "/d" {
            return home.map(PathBuf::from);
        }
        if lower.starts_with("/d ") || lower.starts_with("/d\t") {
            rest = rest[2..].trim_start();
        }
    }

    let arg = first_shell_argument(rest)?;
    expand_common_directory_path(&arg, home)
}

pub(super) fn leading_directory_command(command: &str) -> Option<(&str, &str)> {
    for keyword in ["set-location", "pushd", "chdir", "cd", "sl"] {
        let Some(head) = command.get(..keyword.len()) else {
            continue;
        };
        let Some(tail) = command.get(keyword.len()..) else {
            continue;
        };
        if !head.eq_ignore_ascii_case(keyword) {
            continue;
        }
        if tail.is_empty() || tail.chars().next().is_some_and(char::is_whitespace) {
            return Some((head, tail.trim_start()));
        }
    }
    None
}

pub(super) fn first_shell_argument(input: &str) -> Option<String> {
    let mut chars = input.trim_start().chars().peekable();
    let mut out = String::new();
    let quote = match chars.peek().copied() {
        Some('"') | Some('\'') => chars.next(),
        _ => None,
    };

    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == q {
                break;
            }
            if ch == '\\' {
                if let Some(next) = chars.peek().copied() {
                    if next == q || next == '\\' {
                        out.push(next);
                        chars.next();
                        continue;
                    }
                }
            }
            out.push(ch);
            continue;
        }

        if ch.is_whitespace() || ch == ';' {
            break;
        }
        if ch == '&' && chars.peek() == Some(&'&') {
            break;
        }
        if ch == '\\' {
            if let Some(next) = chars.peek().copied() {
                if next.is_whitespace() || next == '\\' || next == '\'' || next == '"' {
                    out.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(ch);
    }

    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) fn expand_common_directory_path(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    let path = raw.trim();
    if path.is_empty() || path == "-" || path == "." || path == ".." {
        return None;
    }
    if path == "~" {
        return home.map(PathBuf::from);
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home.map(|home| home.join(rest));
    }
    if let Some(rest) = path
        .strip_prefix("$HOME/")
        .or_else(|| path.strip_prefix("$HOME\\"))
        .or_else(|| path.strip_prefix("${HOME}/"))
        .or_else(|| path.strip_prefix("${HOME}\\"))
    {
        return home.map(|home| home.join(rest));
    }

    let candidate = PathBuf::from(path);
    // `/tmp/...` is absolute on Unix; on Windows Path::is_absolute is false for
    // that form, but history lines from remote shells still use it.
    if candidate.is_absolute() || looks_like_windows_absolute_path(path) || path.starts_with('/') {
        Some(candidate)
    } else {
        None
    }
}

pub(super) fn looks_like_windows_absolute_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    (bytes.len() >= 3
        && bytes[1] == b':'
        && bytes[0].is_ascii_alphabetic()
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || path.starts_with("\\\\")
        || path.starts_with("//")
}
