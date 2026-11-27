use super::super::{extract, list, preview};
use std::fs;
use std::io::{self, Write};
use std::path::Path;
use tar::{Builder, EntryType, Header};

fn archive(content: &[u8]) -> Vec<u8> {
    let mut builder = Builder::new(Vec::new());
    let mut root = Header::new_ustar();
    root.set_entry_type(EntryType::Directory);
    root.set_size(0);
    builder.append_data(&mut root, ".", io::empty()).unwrap();
    let mut file = Header::new_ustar();
    file.set_size(content.len() as u64);
    builder
        .append_data(&mut file, "./notes/report.txt", content)
        .unwrap();
    builder.into_inner().unwrap()
}

fn write_encoded(bytes: &[u8], path: &Path) {
    let file = fs::File::create(path).unwrap();
    match path.extension().unwrap().to_str().unwrap() {
        "tar" => (&file).write_all(bytes).unwrap(),
        "gz" | "tgz" => {
            let mut writer = flate2::write::GzEncoder::new(file, flate2::Compression::fast());
            writer.write_all(bytes).unwrap();
            writer.finish().unwrap();
        }
        "bz2" => {
            let mut writer = bzip2::write::BzEncoder::new(file, bzip2::Compression::fast());
            writer.write_all(bytes).unwrap();
            writer.finish().unwrap();
        }
        "xz" => {
            let mut writer = xz2::write::XzEncoder::new(file, 1);
            writer.write_all(bytes).unwrap();
            writer.finish().unwrap();
        }
        "zst" => zstd::stream::copy_encode(bytes, file, 1).unwrap(),
        suffix => panic!("Unexpected test format {suffix}"),
    }
}

#[test]
fn tar_variants_preview_and_publish_exact_files() {
    let content = "Quarterly report\n中文\n".as_bytes();
    let tar = archive(content);
    for suffix in ["tar", "tar.gz", "tgz", "tar.bz2", "tar.xz", "tar.zst"] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join(format!("region.2026.{suffix}"));
        write_encoded(&tar, &file);
        let source = file.to_str().unwrap();
        let destination = root.path().to_str().unwrap();
        let entries = list(source).unwrap();
        assert_eq!(entries.len(), 1, "{suffix}");
        let entry = entries[0].clone();
        assert_eq!(entry.name, "notes/report.txt", "{suffix}");
        let temp = preview(source, entry.clone()).unwrap();
        assert_eq!(fs::read(&temp.path).unwrap(), content, "{suffix}");
        super::super::super::release_temp(&temp.path).unwrap();
        extract(source, destination, None).unwrap();
        extract(source, destination, Some(entry)).unwrap();
        assert_eq!(
            fs::read(root.path().join("region.2026/notes/report.txt")).unwrap(),
            content
        );
        assert_eq!(fs::read(root.path().join("report.txt")).unwrap(), content);
        assert!(extract(source, destination, None).is_err());
    }
}

#[test]
fn changed_tars_invalidate_a_member_even_if_size_and_name_match() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("revision.tgz");
    let path = file.to_str().unwrap();
    write_encoded(&archive(b"same size 1"), &file);
    let earlier = list(path).unwrap().remove(0);
    write_encoded(&archive(b"same size 2"), &file);
    assert!(
        preview(path, earlier.clone())
            .unwrap_err()
            .contains("Archive changed")
    );
    assert!(extract(path, root.path().to_str().unwrap(), Some(earlier)).is_err());
    assert!(!root.path().join("report.txt").exists());
}

#[test]
fn standalone_compression_preserves_extensions_and_never_replaces_output() {
    let content = "Single compressed file\n中文\n".as_bytes();
    for suffix in ["gz", "bz2", "xz", "zst"] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join(format!("notes.txt.{suffix}"));
        write_encoded(content, &file);
        let source = file.to_str().unwrap();
        let destination = root.path().to_str().unwrap();
        let original = fs::read(&file).unwrap();
        let entries = list(source).unwrap();
        assert_eq!(entries.len(), 1);
        let entry = entries[0].clone();
        assert_eq!(entry.name, "notes.txt");
        let temp = preview(source, entry).unwrap();
        assert_eq!(fs::read(&temp.path).unwrap(), content);
        super::super::super::release_temp(&temp.path).unwrap();
        extract(source, destination, None).unwrap();
        let output = root.path().join("notes.txt");
        assert_eq!(fs::read(&output).unwrap(), content);
        fs::write(&output, b"edited").unwrap();
        assert!(extract(source, destination, None).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"edited");
        assert_eq!(fs::read(&file).unwrap(), original);
    }
}

#[test]
fn invalid_tar_members_never_publish_staged_output() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("bundle.tar");
    let path = file.to_str().unwrap();
    let original = archive(b"hello");
    for (kind, name, size, reason) in [
        (EntryType::Regular, "../out.txt", 0, "unsafe path"),
        (EntryType::Regular, "/out.txt", 0, "unsafe path"),
        (EntryType::Regular, "COM2.txt", 0, "unsafe path"),
        (EntryType::Symlink, "symbolic.txt", 0, "unsafe path"),
        (EntryType::Link, "hard.txt", 0, "unsafe path"),
        (
            EntryType::Regular,
            "large.bin",
            32 * 1024 * 1024 + 1,
            "size limit",
        ),
        (
            EntryType::GNULongName,
            "metadata",
            16 * 1024 + 1,
            "extended header",
        ),
    ] {
        let mut modified = original[..original.len() - 1024].to_vec();
        let mut header = Header::new_ustar();
        header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
        header.set_entry_type(kind);
        header.set_size(size);
        header.set_cksum();
        modified.extend(header.as_bytes());
        fs::write(&file, modified).unwrap();
        assert!(list(path).unwrap_err().contains(reason), "{name}");
        assert!(extract(path, root.path().to_str().unwrap(), None).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }
}

#[test]
fn tar_accepts_bounded_long_names_from_gnu_and_pax() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("long.tar");
    let long_name = format!("notes/{}.txt", "report".repeat(22));
    for pax in [false, true] {
        let mut builder = Builder::new(Vec::new());
        let mut header = Header::new_gnu();
        header.set_size(4);
        let mut name = long_name.as_str();
        if pax {
            builder
                .append_pax_extensions([("path", long_name.as_bytes())])
                .unwrap();
            name = "short.txt";
        }
        builder
            .append_data(&mut header, name, &b"data"[..])
            .unwrap();
        fs::write(&file, builder.into_inner().unwrap()).unwrap();
        assert_eq!(list(file.to_str().unwrap()).unwrap()[0].name, long_name);
    }
}

#[test]
fn damaged_compression_trailer_is_rejected_before_extracting() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("damaged.tar.gz");
    write_encoded(&archive(b"valid contents"), &file);
    let mut bytes = fs::read(&file).unwrap();
    let crc = bytes.len() - 8;
    bytes[crc] ^= 1;
    fs::write(&file, bytes).unwrap();
    assert!(list(file.to_str().unwrap()).is_err());
    assert!(extract(file.to_str().unwrap(), root.path().to_str().unwrap(), None).is_err());
    assert!(!root.path().join("damaged").exists());
}
