//! Platform index results share one bounded candidate contract.
use std::path::PathBuf;
#[cfg(not(windows))]
use std::process::Stdio;
#[cfg(not(windows))]
use std::sync::atomic::AtomicBool;
#[cfg(not(windows))]
use std::time::Duration;
#[cfg(not(windows))]
use tokio::io::AsyncReadExt;
#[cfg(not(windows))]
use tokio::process::Command;

use crate::Provider;
#[cfg(not(windows))]
use crate::check_cancelled;

pub(super) const MAX_CANDIDATES: usize = 384;
#[cfg(not(windows))]
const MAX_BYTES: usize = 512 * 1024;

pub(super) struct Indexed {
    pub provider: Provider,
    pub paths: Vec<PathBuf>,
    pub limited: bool,
}

impl Indexed {
    pub(super) fn unavailable() -> Self {
        Self {
            provider: Provider::BoundedScan,
            paths: Vec::new(),
            limited: false,
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn glob_value(query: &str, literal_prefix: usize, spotlight: bool) -> String {
    let mut pattern = "*".to_owned();
    for (i, ch) in query.chars().enumerate() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']') || (spotlight && matches!(ch, '"' | '\'')) {
            pattern.push('\\');
        }
        pattern.push(ch);
        if i + 1 >= literal_prefix {
            pattern.push('*');
        }
    }
    if literal_prefix > query.chars().count() {
        pattern.push('*');
    }
    pattern
}

#[cfg(target_os = "linux")]
fn command(query: &str, literal_prefix: usize) -> Option<(Command, Provider, Duration)> {
    let mut cmd = Command::new("/usr/bin/nice");
    cmd.args(["-n", "10", "/usr/bin/plocate", "-b", "-i", "-0", "-l"])
        .arg(MAX_CANDIDATES.to_string())
        .arg("--")
        .arg(glob_value(query, literal_prefix, false));
    Some((
        cmd,
        Provider::Plocate,
        Duration::from_millis(if literal_prefix == 1 { 180 } else { 650 }),
    ))
}

#[cfg(target_os = "macos")]
fn command(query: &str, literal_prefix: usize) -> Option<(Command, Provider, Duration)> {
    let mut cmd = Command::new("/usr/bin/mdfind");
    cmd.arg("-0").arg(format!(
        "kMDItemFSName ==[c] \"{}\"",
        glob_value(query, literal_prefix, true)
    ));
    Some((cmd, Provider::Spotlight, Duration::from_millis(450)))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn command(_: &str, _: usize) -> Option<(Command, Provider, Duration)> {
    None
}

/// Drain output incrementally so a deadline or a very broad query can preserve
/// complete rows without keeping a provider alive to enumerate its entire index.
#[cfg(not(windows))]
async fn collect(
    mut command: Command,
    provider: Provider,
    timeout: Duration,
    cancelled: &AtomicBool,
) -> Result<Indexed, String> {
    let child = command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else {
        return Ok(Indexed::unavailable());
    };
    let mut stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut bytes = Vec::new();
    let diagnostic_task = tokio::spawn(async move {
        let mut diagnostic = Vec::new();
        let _ = stderr.take(512).read_to_end(&mut diagnostic).await;
        diagnostic
    });
    let mut limited = false;
    let mut records = 0;
    let mut buf = [0u8; 8192];
    let run = async {
        let read_stdout = async {
            loop {
                let count = stdout.read(&mut buf).await?;
                if count == 0 {
                    break;
                }
                records += buf[..count].iter().filter(|b| **b == 0).count();
                bytes.extend_from_slice(&buf[..count]);
                if bytes.len() >= MAX_BYTES || records >= MAX_CANDIDATES {
                    limited = true;
                    break;
                }
            }
            std::io::Result::Ok(())
        };
        // A diagnostic distinguishes plocate's exit 1 for a missing database
        // from its documented exit 1 for an empty successful search.
        read_stdout.await?;
        if limited {
            return Ok::<_, std::io::Error>(None);
        }
        Ok(Some(child.wait().await?))
    };
    let cancelled_wait = async {
        while check_cancelled(cancelled).is_ok() {
            tokio::time::sleep(Duration::from_millis(12)).await;
        }
    };
    let status = tokio::select! {
        result = run => match result {
            Ok(status) => status,
            Err(_) => {
                let _ = child.kill().await;
                return Ok(Indexed::unavailable());
            }
        },
        _ = tokio::time::sleep(timeout) => { limited = true; None },
        _ = cancelled_wait => None,
    };
    if status.is_none() {
        let _ = child.kill().await;
    }
    let diagnostic = diagnostic_task.await.unwrap_or_default();
    check_cancelled(cancelled)?;
    let no_matches = provider == Provider::Plocate
        && status.is_some_and(|s| s.code() == Some(1))
        && diagnostic.is_empty();
    if status.is_some_and(|status| !status.success()) && !no_matches {
        return Ok(Indexed::unavailable());
    }
    let paths: Vec<_> = bytes
        .split_inclusive(|b| *b == 0)
        .filter_map(|row| row.strip_suffix(&[0]))
        .filter_map(|row| std::str::from_utf8(row).ok())
        .take(MAX_CANDIDATES)
        .map(PathBuf::from)
        .collect();
    let provider = if (status.is_none() || !diagnostic.is_empty()) && paths.is_empty() {
        Provider::BoundedScan
    } else {
        provider
    };
    Ok(Indexed {
        provider,
        paths,
        limited,
    })
}

#[cfg(not(windows))]
pub(super) async fn lookup(query: &str, cancelled: &AtomicBool) -> Result<Indexed, String> {
    check_cancelled(cancelled)?;
    let Some((cmd, source, timeout)) = command(query, usize::MAX) else {
        return Ok(Indexed::unavailable());
    };
    let mut result = collect(cmd, source, timeout, cancelled).await?;
    // A contiguous prefix lets plocate skip most trigram postings. This
    // commonly catches omitted separators before the general subsequence pass.
    let prefix = query.chars().count().div_ceil(2).max(3);
    let anchor = cfg!(target_os = "linux") && query.chars().count() > 3 && result.paths.is_empty();
    for literal_prefix in anchor.then_some(prefix).into_iter().chain([1]) {
        if result.provider == Provider::BoundedScan {
            break;
        }
        if result.paths.len() >= crate::matching::RESULT_LIMIT {
            result.limited = true;
            break;
        }
        let Some((cmd, source, timeout)) = command(query, literal_prefix) else {
            break;
        };
        // A sparse abbreviation can match even when a tight hit exists. Reserve
        // a short slice to collect additional names before serving known hits.
        let timeout = if result.paths.is_empty() {
            timeout
        } else {
            timeout.min(Duration::from_millis(25))
        };
        let extra = collect(cmd, source, timeout, cancelled).await?;
        if extra.provider == Provider::BoundedScan && result.paths.is_empty() {
            return Ok(extra);
        }
        result.limited |= extra.limited || extra.provider == Provider::BoundedScan;
        result.paths.extend(extra.paths);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn helper(script: &str) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn indexed_process_distinguishes_success_empty_and_failure() {
        let flag = AtomicBool::new(false);
        let run = |script| {
            collect(
                helper(script),
                Provider::Plocate,
                Duration::from_secs(2),
                &flag,
            )
        };
        let data = run("printf '/first\\000/path with\\nnewline\\000'")
            .await
            .unwrap();
        assert_eq!(data.provider, Provider::Plocate);
        assert_eq!(
            data.paths,
            [
                PathBuf::from("/first"),
                PathBuf::from("/path with\nnewline")
            ]
        );
        let empty = run("exit 1").await.unwrap();
        assert_eq!(empty.provider, Provider::Plocate);
        assert!(empty.paths.is_empty());
        assert!(!empty.limited);
        let error = run("echo database-unreadable >&2; exit 1").await.unwrap();
        assert_eq!(error.provider, Provider::BoundedScan);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_and_reaps_an_index_helper_and_marks_partial_rows() {
        let flag = AtomicBool::new(false);
        for (script, provider, count) in [
            ("exec /bin/sleep 12", Provider::BoundedScan, 0),
            (
                "printf '/first\\000unfinished'; exec /bin/sleep 12",
                Provider::Plocate,
                1,
            ),
        ] {
            let start = std::time::Instant::now();
            let result = collect(
                helper(script),
                Provider::Plocate,
                Duration::from_millis(120),
                &flag,
            )
            .await
            .unwrap();
            assert_eq!(result.provider, provider);
            assert_eq!(result.paths.len(), count);
            assert!(result.limited);
            assert!(start.elapsed() < Duration::from_secs(3));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_interrupts_a_silent_index_helper() {
        let flag = AtomicBool::new(false);
        let search = collect(
            helper("exec /bin/sleep 12"),
            Provider::Spotlight,
            Duration::from_secs(6),
            &flag,
        );
        let stop = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        };
        let start = std::time::Instant::now();
        let (result, ()) = tokio::join!(search, stop);
        assert!(result.err().unwrap().starts_with("cancelled:"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn native_patterns_preserve_literal_metacharacters() {
        assert_eq!(glob_value("a[b?*", 1, false), "*a*\\[*b*\\?*\\**");
        assert_eq!(glob_value("a'\"b", usize::MAX, true), "*a\\'\\\"b*");
    }
}
