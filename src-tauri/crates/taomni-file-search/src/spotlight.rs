//! Spotlight uses case-insensitive filename predicates and native metadata.
#[cfg(target_os = "macos")]
use crate::providers::{Indexed, collect};
#[cfg(target_os = "macos")]
use crate::{Provider, check_cancelled};
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicBool;
#[cfg(target_os = "macos")]
use std::time::Duration;
#[cfg(target_os = "macos")]
use tokio::process::Command;

fn name_contains(query: &str) -> String {
    let mut pattern = String::with_capacity(query.len() + 28);
    pattern.push_str("kMDItemFSName == \"*");
    for ch in query.chars() {
        if matches!(ch, '\\' | '"' | '*' | '?') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push_str("*\"c");
    pattern
}

/// Spotlight can apply independent basename predicates before Rust verifies
/// the full subsequence. Two anchors cut down candidate counts for long input.
/// Trying progressively shorter anchors covers separated terms and initials.
fn anchor_predicates(query: &str) -> Vec<String> {
    let boundaries: Vec<_> = query
        .char_indices()
        .map(|(offset, _)| offset)
        .chain([query.len()])
        .collect();
    let len = boundaries.len() - 1;
    let mid = len.div_ceil(2);
    let mut predicates = Vec::with_capacity(2);
    if len >= 4 {
        predicates.push(format!(
            "{} && {}",
            name_contains(&query[..boundaries[mid]]),
            name_contains(&query[boundaries[mid]..])
        ));
    }
    // Use at most eight distinct characters, sampled from both ends and the
    // middle. Every subsequence match satisfies these independent predicates.
    let mut characters: Vec<_> = query.chars().collect();
    characters.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    let last = characters.len() - 1;
    let count = characters.len().min(8);
    let mut partial = Vec::with_capacity(count);
    for slot in 0..count {
        let ch = characters[slot * last / (count - 1).max(1)];
        let predicate = name_contains(ch.encode_utf8(&mut [0; 4]));
        if !partial.contains(&predicate) {
            partial.push(predicate);
        }
    }
    predicates.push(partial.join(" && "));
    predicates
}

#[cfg(target_os = "macos")]
pub(super) async fn lookup(query: &str, cancelled: &AtomicBool) -> Result<Indexed, String> {
    use std::collections::HashSet;

    check_cancelled(cancelled)?;
    let mut indexed = Indexed::unavailable();
    let mut seen = HashSet::new();
    let matches = crate::matching::Matches::new(query);
    let search = std::iter::once(name_contains(query)).chain(anchor_predicates(query));
    let deadline = tokio::time::Instant::now() + Duration::from_millis(450);
    for predicate in search {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() || indexed.paths.len() >= crate::matching::RESULT_LIMIT {
            indexed.limited = true;
            break;
        }
        let mut cmd = Command::new("/usr/bin/mdfind");
        cmd.arg("-0").arg(predicate);
        let page = collect(cmd, Provider::Spotlight, remaining, cancelled).await?;
        indexed.limited |= page.limited;
        if page.provider == Provider::BoundedScan {
            if indexed.provider == Provider::Spotlight {
                indexed.limited = true;
            }
            break;
        }
        indexed.provider = Provider::Spotlight;
        for path in page.paths {
            // Filtering before sharing the cap prevents unrelated basename
            // candidates from crowding out subsequent ranked results.
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| matches.rank(name).is_some())
                && seen.insert(path.clone())
            {
                indexed.paths.push(path);
                if indexed.paths.len() >= crate::providers::MAX_CANDIDATES {
                    indexed.limited = true;
                    return Ok(indexed);
                }
            }
        }
    }
    Ok(indexed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotlight_predicates_use_mdfind_case_and_literal_syntax() {
        assert_eq!(name_contains("a\"b?"), "kMDItemFSName == \"*a\\\"b\\?*\"c");
        assert_eq!(
            anchor_predicates("ct"),
            ["kMDItemFSName == \"*c*\"c && kMDItemFSName == \"*t*\"c"]
        );
        assert_eq!(
            anchor_predicates("目录草稿")[0],
            "kMDItemFSName == \"*目录*\"c && kMDItemFSName == \"*草稿*\"c"
        );
    }
}
