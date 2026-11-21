//! Progress parsing for `git clone --progress`.
//!
//! Git writes progress to stderr using carriage returns. The clone runner reads
//! that stream, splits it into lines, and forwards the parsed phase/percent to
//! the renderer. This module stays pure so the mapping is unit tested without a
//! Git process or network.

#[derive(Debug, Clone, PartialEq)]
pub(super) struct ProgressUpdate {
    pub phase: &'static str,
    /// Overall percent (0..100), already mapped from the phase-local percent.
    pub percent: Option<f64>,
    pub objects_done: Option<u64>,
    pub objects_total: Option<u64>,
    pub message: String,
}

/// Remove the ANSI escape sequences Git may emit when it believes stderr is a
/// terminal. `--progress` with a pipe normally omits them, but a user's
/// `color.ui=always` must not corrupt percentages.
fn strip_ansi(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

fn percent_in(line: &str) -> Option<f64> {
    let marker = line.find('%')?;
    let bytes = line[..marker].as_bytes();
    let mut start = bytes.len();
    while start > 0 {
        let ch = bytes[start - 1];
        if ch.is_ascii_digit() || ch == b'.' {
            start -= 1;
        } else {
            break;
        }
    }
    if start == bytes.len() {
        return None;
    }
    line[start..marker]
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn object_counts(line: &str) -> (Option<u64>, Option<u64>) {
    let Some(open) = line.find('(') else {
        return (None, None);
    };
    let Some(close) = line[open..].find(')') else {
        return (None, None);
    };
    let inside = &line[open + 1..open + close];
    let Some((done, total)) = inside.split_once('/') else {
        return (None, None);
    };
    (
        done.trim().parse::<u64>().ok(),
        total.trim().parse::<u64>().ok(),
    )
}

fn mapped(local: f64, base: f64, span: f64) -> f64 {
    (base + (local.clamp(0.0, 100.0) / 100.0) * span).clamp(0.0, 100.0)
}

/// Parse one stderr line. Returns `None` for lines that are not a recognized
/// progress phase (callers keep them only for final error text).
pub(super) fn parse_progress_line(raw: &str) -> Option<ProgressUpdate> {
    let cleaned = strip_ansi(raw);
    let line = cleaned.trim_matches(|ch: char| ch == '\r' || ch == '\n' || ch == ' ');
    if line.is_empty() {
        return None;
    }
    let line = line.strip_prefix("remote: ").unwrap_or(line);
    let (phase, base, span) = if line.starts_with("Cloning into") {
        ("connecting", 0.0, 0.0)
    } else if line.starts_with("Enumerating objects") || line.starts_with("Counting objects") {
        ("counting", 0.0, 5.0)
    } else if line.starts_with("Compressing objects") {
        ("counting", 5.0, 5.0)
    } else if line.starts_with("Receiving objects") {
        ("receiving", 10.0, 80.0)
    } else if line.starts_with("Resolving deltas") {
        ("resolving", 90.0, 8.0)
    } else if line.starts_with("Updating files") || line.starts_with("Checking out files") {
        ("updating", 98.0, 2.0)
    } else {
        return None;
    };
    let (objects_done, objects_total) = object_counts(line);
    let percent = percent_in(line)
        .map(|local| mapped(local, base, span))
        .map(|value| {
            // Avoid noisy float tails in JSON and UI.
            (value * 10.0).round() / 10.0
        });
    Some(ProgressUpdate {
        phase,
        percent,
        objects_done,
        objects_total,
        message: line.chars().take(500).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_counting_line_with_objects() {
        let update = parse_progress_line("remote: Counting objects: 100% (12/12), done.\r")
            .expect("counting line");
        assert_eq!(update.phase, "counting");
        assert_eq!(update.percent, Some(5.0));
        assert_eq!(
            (update.objects_done, update.objects_total),
            (Some(12), Some(12))
        );
    }

    #[test]
    fn maps_receiving_progress_into_the_overall_range() {
        let update =
            parse_progress_line("Receiving objects:  45% (450/1000), 1.20 MiB | 3.00 MiB/s")
                .expect("receiving line");
        assert_eq!(update.phase, "receiving");
        assert_eq!(update.percent, Some(46.0));
        assert_eq!(
            (update.objects_done, update.objects_total),
            (Some(450), Some(1000))
        );
    }

    #[test]
    fn clamps_resolving_and_updating_at_the_top() {
        let resolving = parse_progress_line("Resolving deltas: 100% (5/5), done.").unwrap();
        assert_eq!(resolving.phase, "resolving");
        assert_eq!(resolving.percent, Some(98.0));
        let updating = parse_progress_line("Updating files: 100% (9/9), done.").unwrap();
        assert_eq!(updating.phase, "updating");
        assert_eq!(updating.percent, Some(100.0));
    }

    #[test]
    fn keeps_indeterminate_phases_and_ignores_unrelated_lines() {
        let cloning = parse_progress_line("Cloning into 'demo'...").unwrap();
        assert_eq!(cloning.phase, "connecting");
        assert_eq!(cloning.percent, None);
        assert!(parse_progress_line("fatal: repository not found").is_none());
        assert!(parse_progress_line("   ").is_none());
    }

    #[test]
    fn strips_ansi_sequences_before_matching() {
        let update =
            parse_progress_line("\u{1b}[32mReceiving objects: 10% (1/10)\u{1b}[m").unwrap();
        assert_eq!(update.percent, Some(18.0));
    }
}
