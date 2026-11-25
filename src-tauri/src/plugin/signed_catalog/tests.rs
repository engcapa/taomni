use super::*;
use crate::plugin::verify::test_support::sign;
use tempfile::tempdir;

fn payload(sequence: u64) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "coreApiVersion":"1", "sequence":sequence,
        "updatedAt":"2026-11-16T00:00:00Z", "plugins":{}
    }))
    .unwrap()
}

fn publish(root: &Path, sequence: u64) -> Result<download::ModuleCatalog, PluginError> {
    let raw = payload(sequence);
    let signature = sign(&raw, "file=modules.json");
    persist_trusted_catalog(raw, signature, root)
}

#[test]
fn cache_publishes_exact_signed_bytes_and_survives_registry_restart() {
    let root = tempdir().unwrap();
    assert_eq!(publish(root.path(), 42).unwrap().sequence, 42);
    let catalog = read_cached_catalog(root.path()).unwrap();
    assert_eq!(catalog.catalog().sequence, 42);
    let envelope: SignedCatalog =
        serde_json::from_slice(&fs::read(root.path().join(".catalog-trust/catalog.json")).unwrap())
            .unwrap();
    assert_eq!(envelope.payload.as_bytes(), payload(42));
    assert!(publish(root.path(), 41).is_err());
    assert_eq!(
        read_cached_catalog(root.path()).unwrap().catalog().sequence,
        42
    );
}

#[test]
fn concurrent_publications_leave_the_highest_signed_catalog_available() {
    let root = tempdir().unwrap();
    let workers = (1..=12)
        .map(|sequence| {
            let path = root.path().to_owned();
            std::thread::spawn(move || {
                let _ = publish(&path, sequence);
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(
        read_cached_catalog(root.path()).unwrap().catalog().sequence,
        12
    );
    let watermark: serde_json::Value = serde_json::from_slice(
        &fs::read(root.path().join(".catalog-trust/catalog-sequence.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(watermark["sequence"], 12);
}

#[test]
fn failed_authentication_never_overwrites_a_working_cache() {
    let root = tempdir().unwrap();
    publish(root.path(), 7).unwrap();
    let original = fs::read(root.path().join(".catalog-trust/catalog.json")).unwrap();
    assert!(
        persist_trusted_catalog(
            payload(8),
            sign(b"unsigned substitute", "file=modules.json"),
            root.path()
        )
        .is_err()
    );
    assert_eq!(
        fs::read(root.path().join(".catalog-trust/catalog.json")).unwrap(),
        original
    );
    assert_eq!(
        read_cached_catalog(root.path()).unwrap().catalog().sequence,
        7
    );
}

#[test]
fn oversized_or_corrupt_cache_and_watermark_fail_closed() {
    let root = tempdir().unwrap();
    publish(root.path(), 7).unwrap();
    let cache = root.path().join(".catalog-trust/catalog.json");
    OpenOptions::new()
        .write(true)
        .open(&cache)
        .unwrap()
        .set_len(MAX_CACHED_ENVELOPE_BYTES + 1)
        .unwrap();
    assert!(
        read_cached_catalog(root.path())
            .unwrap_err()
            .to_string()
            .contains("12 MiB")
    );
    fs::write(&cache, b"{corrupt").unwrap();
    assert!(read_cached_catalog(root.path()).is_err());
    let watermark = root.path().join(".catalog-trust/catalog-sequence.json");
    fs::write(&watermark, vec![b' '; 4097]).unwrap();
    assert!(
        publish(root.path(), 8)
            .unwrap_err()
            .to_string()
            .contains("4 KiB")
    );
    assert_eq!(fs::read(cache).unwrap(), b"{corrupt");
}

#[cfg(unix)]
#[test]
fn rejects_symlinked_catalog_cache_without_reading_external_bytes() {
    use std::os::unix::fs::symlink;
    let root = tempdir().unwrap();
    publish(root.path(), 7).unwrap();
    let cache = root.path().join(".catalog-trust/catalog.json");
    let external = root.path().join("external.json");
    fs::rename(&cache, &external).unwrap();
    symlink(external, cache).unwrap();
    assert!(read_cached_catalog(root.path()).is_err());
}
