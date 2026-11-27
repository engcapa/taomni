use super::super::{Entry, extract, list, preview};
use std::fs;
use std::path::Path;

const MODERN: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../qa-ui-auto-tests/fixtures/taoffice/records.RAR"
));
const LEGACY: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../qa-ui-auto-tests/fixtures/taoffice/legacy.rar"
));
const LOCKED: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../qa-ui-auto-tests/fixtures/taoffice/locked.rar"
));

fn bytes() -> Vec<u8> {
    "File open original\nSecond line\n中文\n"
        .repeat(32)
        .into_bytes()
}

#[test]
fn reads_solid_rar4_and_rar5_and_publishes_only_verified_output() {
    let root = tempfile::tempdir().unwrap();
    for (name, input) in [("modern.RAR", MODERN), ("legacy.rar", LEGACY)] {
        let path = root.path().join(name);
        fs::write(&path, input).unwrap();
        let source = path.to_str().unwrap();
        let entries = list(source).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "notes/first.txt");
        assert_eq!(entries[1].name, "notes/second.txt");

        let current = entries[1].clone();
        let temporary = preview(source, current.clone()).unwrap();
        assert_eq!(fs::read(&temporary.path).unwrap(), bytes());
        super::super::super::release_temp(&temporary.path).unwrap();
        let stale = Entry {
            crc: current.crc.wrapping_add(1),
            ..current
        };
        assert!(
            preview(source, stale)
                .unwrap_err()
                .contains("Archive changed")
        );

        let destination = root.path().to_str().unwrap();
        let output = extract(source, destination, None).unwrap();
        assert_eq!(
            fs::read(Path::new(&output).join("notes/first.txt")).unwrap(),
            bytes()
        );
        assert_eq!(
            fs::read(Path::new(&output).join("notes/second.txt")).unwrap(),
            bytes()
        );
        assert!(extract(source, destination, None).is_err());
        assert_eq!(fs::read(&path).unwrap(), input);
    }
}

#[test]
fn rejects_encrypted_headers_and_leaves_the_destination_empty() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("encrypted.rar");
    fs::write(&path, LOCKED).unwrap();
    let dest = root.path().join("output");
    fs::create_dir(&dest).unwrap();
    for error in [
        list(path.to_str().unwrap()).unwrap_err(),
        extract(path.to_str().unwrap(), dest.to_str().unwrap(), None).unwrap_err(),
    ] {
        assert!(error.contains("Password-protected"), "{error}");
    }
    assert_eq!(fs::read_dir(dest).unwrap().count(), 0);
}
