use super::*;
use crate::providers::Indexed;
use std::fs;

fn fallback() -> Indexed {
    Indexed {
        provider: Provider::BoundedScan,
        paths: Vec::new(),
        limited: false,
    }
}

#[test]
fn validation_counts_unicode_and_rejects_controls_and_oversize_queries() {
    assert_eq!(validate("  档案  ").unwrap(), "档案");
    assert!(validate("档").is_err());
    assert!(validate("a\nb").is_err());
    assert!(validate(&"🦀".repeat(96)).is_ok());
    assert!(validate(&"🦀".repeat(97)).is_err());
}

#[test]
fn ranked_results_cross_directories_and_recheck_stale_index_entries() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    let nested = root.join("files");
    fs::create_dir(&nested).unwrap();
    for name in ["AC", "Acorn", "zzz-ac", "abc", ".hiddenac"] {
        fs::write(nested.join(name), "not accessed").unwrap();
    }
    fs::create_dir(root.join("archive")).unwrap();
    fs::create_dir(root.join("node_modules")).unwrap();
    fs::write(root.join("node_modules").join("AC"), "").unwrap();
    let indexed = Indexed {
        provider: Provider::Spotlight,
        paths: vec![nested.join("AC"), nested.join("removedAC")],
        limited: false,
    };
    let result = scan::finish(
        "ac",
        indexed,
        vec![root.to_path_buf(), root.to_path_buf()],
        &AtomicBool::new(false),
    )
    .unwrap();
    let pairs: Vec<_> = result
        .entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.is_directory))
        .collect();
    assert_eq!(
        pairs,
        [
            ("AC", false),
            ("Acorn", false),
            ("zzz-ac", false),
            ("abc", false),
            ("archive", true)
        ]
    );
    assert_eq!(result.scanned_roots.len(), 1);
    assert!(!result.truncated);
}

#[test]
fn bounded_walk_caps_results_and_reports_unreadable_roots() {
    let root = tempfile::tempdir().unwrap();
    for i in 0..102 {
        fs::write(root.path().join(format!("hit-{i}")), "").unwrap()
    }
    let result = scan::finish(
        "hi",
        fallback(),
        vec![root.path().into()],
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(result.truncated);
    assert_eq!(result.entries.len(), matching::RESULT_LIMIT);
    let error = scan::finish(
        "hi",
        fallback(),
        vec![root.path().join("missing")],
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert!(error.starts_with("unavailable:"));
}

#[test]
fn cancellation_also_stops_the_unindexed_walk() {
    assert!(
        scan::finish("cancel", fallback(), vec![], &AtomicBool::new(true))
            .unwrap_err()
            .starts_with("cancelled:")
    );
}

#[cfg(unix)]
#[test]
fn directory_links_and_symlink_loops_are_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    fs::write(other.path().join("external"), "").unwrap();
    std::os::unix::fs::symlink(root.path(), root.path().join("loop")).unwrap();
    std::os::unix::fs::symlink(other.path(), root.path().join("other")).unwrap();
    let result = scan::finish(
        "external",
        fallback(),
        vec![root.path().into()],
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(result.entries.is_empty());
    assert!(!result.truncated);
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "opt-in measurement against the host plocate database and an indexed public system file"]
async fn indexed_linux_performance() {
    use std::time::Instant;
    let expected = "/usr/bin/dpkg-architecture";
    for query in ["dpkg-architecture", "dpkgarch"] {
        let mut samples = Vec::new();
        for _ in 0..15 {
            let start = Instant::now();
            let result = search(query, None, Arc::new(AtomicBool::new(false)))
                .await
                .unwrap();
            samples.push(start.elapsed().as_millis());
            assert_eq!(result.provider, Provider::Plocate);
            assert!(
                result.entries.iter().any(|entry| entry.path == expected),
                "missing indexed {expected} for {query}"
            );
        }
        let mut ordered = samples.clone();
        ordered.sort();
        println!(
            "{query}: milliseconds={samples:?}, p50={}, p95={}",
            ordered[7], ordered[14]
        );
    }
}
