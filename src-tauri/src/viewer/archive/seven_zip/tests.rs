use super::super::{extract, list, preview};
use sevenz_rust2::{ArchiveEntry, ArchiveWriter};
use std::fs;
use std::path::Path;

fn write_7z(path: &Path, files: impl IntoIterator<Item = (ArchiveEntry, &'static [u8])>) {
    let mut archive = ArchiveWriter::new(fs::File::create(path).unwrap()).unwrap();
    for (entry, content) in files {
        archive.push_archive_entry(entry, Some(content)).unwrap();
    }
    archive.finish().unwrap();
}

#[test]
fn streams_7z_members_and_preserves_existing_output() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("bundle.7z");
    write_7z(
        &path,
        [
            (ArchiveEntry::new_directory("reports"), &b""[..]),
            (
                ArchiveEntry::new_file("reports/quarterly.txt"),
                &b"Quarterly results"[..],
            ),
            (ArchiveEntry::new_file("reports/empty.txt"), &b""[..]),
        ],
    );
    let source = path.to_str().unwrap();
    let entries = list(source).unwrap();
    assert_eq!(entries.len(), 3);
    let item = entries
        .iter()
        .find(|entry| entry.name.ends_with("quarterly.txt"))
        .unwrap();
    let temporary = preview(source, item.clone()).unwrap();
    assert_eq!(fs::read(&temporary.path).unwrap(), b"Quarterly results");
    super::super::super::release_temp(&temporary.path).unwrap();
    let dest = root.path().to_str().unwrap();
    extract(source, dest, None).unwrap();
    assert_eq!(
        fs::read(root.path().join("bundle/reports/quarterly.txt")).unwrap(),
        b"Quarterly results"
    );
    assert_eq!(
        fs::metadata(root.path().join("bundle/reports/empty.txt"))
            .unwrap()
            .len(),
        0
    );
    assert!(extract(source, dest, None).is_err());
}

#[test]
fn rejects_7z_paths_and_windows_or_unix_link_attributes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("unsafe.7z");
    let source = path.to_str().unwrap();
    let destination = root.path().to_str().unwrap();
    for (name, attributes) in [
        ("../outside.txt", 0),
        ("link.txt", 0o120777 << 16),
        ("junction.txt", 0x0400),
    ] {
        let mut unsafe_entry = ArchiveEntry::new_file(name);
        unsafe_entry.has_windows_attributes = attributes != 0;
        unsafe_entry.windows_attributes = attributes;
        write_7z(
            &path,
            [
                (ArchiveEntry::new_file("legal.txt"), &b"valid"[..]),
                (unsafe_entry, &b"content"[..]),
            ],
        );
        assert!(list(source).unwrap_err().contains("unsafe path"));
        assert!(extract(source, destination, None).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}
