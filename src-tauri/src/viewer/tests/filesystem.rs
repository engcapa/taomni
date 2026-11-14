use super::Fixture;
use crate::viewer::*;
use crate::workspace::viewer_io::encode_text_bytes;
use std::fs;
use std::sync::{Arc, Barrier};

#[test]
fn text_default_prefix_hard_limit_and_bounded_bytes() {
    let fixture = Fixture::new("large.txt", b"");
    let file = fs::OpenOptions::new()
        .write(true)
        .open(fixture.path())
        .unwrap();
    file.set_len(HARD_TEXT_BYTES + 1).unwrap();
    // Sparse zeroes are binary; limits are rejected before decode/allocation.
    assert!(
        read_text(fixture.path(), Some(HARD_TEXT_BYTES + 1), None)
            .unwrap_err()
            .starts_with("too_large:")
    );
    assert!(
        read_bytes(fixture.path(), Some(10))
            .unwrap_err()
            .starts_with("too_large:")
    );
    assert!(
        read_bytes(fixture.path(), Some(HARD_BYTES + 1))
            .unwrap_err()
            .starts_with("too_large:")
    );
    fs::write(fixture.path(), vec![b'a'; DEFAULT_TEXT_BYTES as usize + 1]).unwrap();
    let prefix = read_text(fixture.path(), None, None).unwrap();
    assert!(prefix.truncated);
    assert!(prefix.hash.is_empty());
    assert_eq!(prefix.next_offset, DEFAULT_TEXT_BYTES);
    assert_eq!(prefix.content.len() as u64, DEFAULT_TEXT_BYTES);
    let full = read_text(fixture.path(), Some(HARD_TEXT_BYTES), None).unwrap();
    assert!(!full.truncated);
    assert_eq!(full.hash.len(), 64);
    assert_eq!(stat(fixture.path()).unwrap().size, DEFAULT_TEXT_BYTES + 1);
}

#[test]
fn exact_bom_encoding_and_mixed_eol_round_trips() {
    for encoding in ["UTF-8", "UTF-16LE", "UTF-16BE", "GBK", "windows-1252"] {
        for bom in [false, true] {
            if bom && !encoding.starts_with("UTF-") {
                continue;
            }
            let original = if encoding == "windows-1252" {
                "café\r\nsecond\rthird\n"
            } else {
                "hello 世界\r\nsecond\rthird\n"
            };
            let bytes = encode_text_bytes(original, encoding, bom).unwrap();
            let fixture = Fixture::new("note.txt", &bytes);
            let read = read_text(fixture.path(), None, Some(encoding)).unwrap();
            assert_eq!(read.content, original, "{encoding}/{bom}");
            assert_eq!(read.bom, bom);
            assert_eq!(read.eol, "mixed");
            let saved = write_text(
                fixture.path(),
                &read.content,
                &read.encoding,
                read.bom,
                &read.eol,
                &read.hash,
            )
            .unwrap();
            assert_eq!(fs::read(fixture.path()).unwrap(), bytes);
            assert_eq!(saved.hash, read.hash);
            assert_eq!(saved.size, bytes.len() as u64);
        }
    }
}

#[test]
fn explicit_eol_conversion_and_lossless_encoding_failures() {
    let fixture = Fixture::new("note.txt", b"hello\r\nworld\n");
    let read = read_text(fixture.path(), None, None).unwrap();
    write_text(
        fixture.path(),
        "café\nworld\r",
        "windows-1252",
        false,
        "CRLF",
        &read.hash,
    )
    .unwrap();
    assert_eq!(fs::read(fixture.path()).unwrap(), b"caf\xe9\r\nworld\r\n");
    let read = read_text(fixture.path(), None, Some("windows-1252")).unwrap();
    let failure = write_text(
        fixture.path(),
        "emoji 😀",
        "windows-1252",
        false,
        "LF",
        &read.hash,
    )
    .unwrap_err();
    assert!(failure.starts_with("binary:"));
    assert_eq!(fs::read(fixture.path()).unwrap(), b"caf\xe9\r\nworld\r\n");
}

#[test]
fn expected_hash_is_mandatory_and_conflicts_never_overwrite() {
    let fixture = Fixture::new("note.txt", b"one");
    let read = read_text(fixture.path(), None, None).unwrap();
    for hash in ["", "bad"] {
        assert!(
            write_text(fixture.path(), "new", "UTF-8", false, "LF", hash)
                .unwrap_err()
                .starts_with("conflict:")
        );
    }
    fs::write(fixture.path(), b"external").unwrap();
    assert!(
        write_text(fixture.path(), "mine", "UTF-8", false, "LF", &read.hash)
            .unwrap_err()
            .starts_with("conflict:")
    );
    assert_eq!(fs::read(fixture.path()).unwrap(), b"external");
    assert!(
        write_text(
            fixture.path(),
            &"x".repeat(HARD_TEXT_BYTES as usize + 1),
            "UTF-8",
            false,
            "LF",
            &read.hash
        )
        .unwrap_err()
        .starts_with("too_large:")
    );
    let missing = format!("{}-missing", fixture.path());
    assert!(write_text(&missing, "new", "UTF-8", false, "LF", &read.hash).is_err());
    assert!(!std::path::Path::new(&missing).exists());
}

#[test]
fn simultaneous_saves_with_one_expected_hash_allow_exactly_one_commit() {
    let fixture = Fixture::new("race.txt", b"initial");
    let hash = read_text(fixture.path(), None, None).unwrap().hash;
    let barrier = Arc::new(Barrier::new(3));
    let threads = ["first", "second"]
        .into_iter()
        .map(|content| {
            let barrier = barrier.clone();
            let path = fixture.path().to_string();
            let hash = hash.clone();
            std::thread::spawn(move || {
                barrier.wait();
                write_text(&path, content, "UTF-8", false, "LF", &hash)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.starts_with("conflict:"))
    );
    let final_bytes = fs::read(fixture.path()).unwrap();
    assert!(final_bytes == b"first" || final_bytes == b"second");
    assert_eq!(
        fs::read_dir(fixture.path.parent().unwrap())
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn chunks_preserve_utf_boundaries_boms_and_embedded_feff() {
    let content = "a😀世界\u{feff}\r\nnext";
    for encoding in ["UTF-8", "UTF-16LE", "UTF-16BE"] {
        let bytes = encode_text_bytes(content, encoding, true).unwrap();
        let fixture = Fixture::new("chunk.txt", &bytes);
        let first = read_text(fixture.path(), Some(7), Some(encoding)).unwrap();
        assert!(first.truncated);
        let mut combined = first.content;
        let mut offset = first.next_offset;
        loop {
            let chunk = read_text_chunk(fixture.path(), offset, Some(7), Some(encoding)).unwrap();
            assert!(chunk.next_offset > offset || chunk.eof);
            combined.push_str(&chunk.content);
            offset = chunk.next_offset;
            if chunk.eof {
                break;
            }
        }
        assert_eq!(combined, content, "{encoding}");
        assert_eq!(offset as usize, bytes.len());
        let eof = read_text_chunk(fixture.path(), offset, Some(4), Some(encoding)).unwrap();
        assert!(eof.eof);
        assert_eq!(eof.content, "");
    }
}

#[test]
fn chunk_refuses_invalid_offsets_and_tiny_budgets() {
    let fixture = Fixture::new("chunk.txt", "😀end".as_bytes());
    assert!(
        read_text_chunk(fixture.path(), 1, Some(4), Some("UTF-8"))
            .unwrap_err()
            .starts_with("binary:")
    );
    assert!(
        read_text_chunk(fixture.path(), 0, Some(1), Some("UTF-8"))
            .unwrap_err()
            .starts_with("too_large:")
    );
    assert!(
        read_text_chunk(fixture.path(), 100, None, None)
            .unwrap_err()
            .starts_with("permission:")
    );
    let binary = Fixture::new("binary.txt", &[0, 1, 2, 3]);
    assert!(
        read_text(binary.path(), None, None)
            .unwrap_err()
            .starts_with("binary:")
    );
    assert!(
        read_text("relative.txt", None, None)
            .unwrap_err()
            .starts_with("permission:")
    );
}

#[test]
fn pasted_assets_use_relative_paths_and_unique_exclusive_names() {
    let fixture = Fixture::new("doc.md", b"# doc");
    let first = save_pasted_image(fixture.path(), "assets/nested", "中 文.png", b"image").unwrap();
    let second = save_pasted_image(fixture.path(), "assets/nested", "中 文.png", b"next").unwrap();
    assert_ne!(first.path, second.path);
    assert_eq!(
        first.relative_path,
        "assets/nested/%E4%B8%AD%20%E6%96%87.png"
    );
    let percent = save_pasted_image(fixture.path(), "assets", "50% literal%20.png", b"x").unwrap();
    assert_eq!(percent.relative_path, "assets/50%25%20literal%2520.png");
    assert_eq!(fs::read(first.path).unwrap(), b"image");
    assert_eq!(fs::read(second.path).unwrap(), b"next");
    for directory in ["../outside", "/tmp", "a/../../tmp", "C:\\tmp", "a\\..\\tmp"] {
        assert!(
            save_pasted_image(fixture.path(), directory, "x.png", b"x")
                .unwrap_err()
                .starts_with("permission:")
        );
    }
    assert!(
        save_pasted_image(fixture.path(), "assets", "../x.png", b"x")
            .unwrap_err()
            .starts_with("permission:")
    );
}

#[cfg(unix)]
#[test]
fn pasted_assets_keep_private_file_and_directory_modes() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new("doc.md", b"doc");
    let saved =
        save_pasted_image(fixture.path(), "assets/nested", "private.png", b"image").unwrap();
    let file_mode = fs::metadata(&saved.path).unwrap().permissions().mode();
    assert_eq!(file_mode & 0o777 & !0o600, 0);
    assert_eq!(fs::read(&saved.path).unwrap(), b"image");
    for directory in ["assets", "assets/nested"] {
        let mode = fs::metadata(fixture.path.parent().unwrap().join(directory))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777 & !0o700, 0, "{directory}");
    }
}

#[cfg(unix)]
#[test]
fn pasted_asset_symlink_escape_and_fifo_reads_are_rejected() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new("doc.md", b"doc");
    let outside = tempfile::tempdir().unwrap();
    symlink(
        outside.path(),
        fixture.path.parent().unwrap().join("assets"),
    )
    .unwrap();
    assert!(
        save_pasted_image(fixture.path(), "assets", "pasted.png", b"x")
            .unwrap_err()
            .starts_with("permission:")
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    let fifo = fixture.path.parent().unwrap().join("fifo");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(
        read_bytes(fifo.to_str().unwrap(), None)
            .unwrap_err()
            .starts_with("permission:")
    );
}

#[test]
fn temporary_copy_release_never_accepts_arbitrary_paths() {
    let original = Fixture::new("original.txt", b"untouched");
    let temp = create_temp("copy.txt", b"copy").unwrap();
    assert_eq!(fs::read(&temp.path).unwrap(), b"copy");
    assert!(
        release_temp(original.path())
            .unwrap_err()
            .starts_with("permission:")
    );
    release_temp(&temp.path).unwrap();
    assert!(!std::path::Path::new(&temp.path).exists());
    assert_eq!(fs::read(original.path()).unwrap(), b"untouched");
    let allocated = allocate_temp("stream.txt").unwrap();
    assert_eq!(fs::metadata(&allocated.path).unwrap().len(), 0);
    fs::write(&allocated.path, b"downloaded").unwrap();
    release_temp_token(&allocated.token).unwrap();
    assert!(!std::path::Path::new(&allocated.path).exists());
    assert!(create_temp("../outside", &[]).is_err());
}

#[test]
fn temporary_copies_remain_read_only_even_with_a_full_expected_hash() {
    let temporary = create_temp("remote.txt", b"remote content").unwrap();
    let read = read_text(&temporary.path, None, None).unwrap();
    let failure = write_text(
        &temporary.path,
        "local overwrite",
        "UTF-8",
        false,
        "LF",
        &read.hash,
    )
    .unwrap_err();
    assert!(failure.starts_with("permission:"));
    assert!(failure.contains("read-only"));
    assert_eq!(fs::read(&temporary.path).unwrap(), b"remote content");
    #[cfg(unix)]
    {
        let alias = tempfile::tempdir().unwrap();
        let path = alias.path().join("aliased.txt");
        std::os::unix::fs::symlink(&temporary.path, &path).unwrap();
        assert!(
            write_text(
                path.to_str().unwrap(),
                "alias overwrite",
                "UTF-8",
                false,
                "LF",
                &read.hash
            )
            .unwrap_err()
            .starts_with("permission:")
        );
    }
    release_temp(&temporary.path).unwrap();
}

#[test]
fn truncated_chunks_do_not_hide_invalid_interior_bytes() {
    let invalid = Fixture::new("invalid.txt", b"a\xffbmore");
    assert!(
        read_text(invalid.path(), Some(2), Some("UTF-8"))
            .unwrap_err()
            .starts_with("binary:")
    );
    assert!(
        read_text_chunk(invalid.path(), 0, Some(2), Some("UTF-8"))
            .unwrap_err()
            .starts_with("binary:")
    );
    let gbk = Fixture::new("gbk.txt", &[0xd6, 0xd0, 0xce, 0xc4, b'!']);
    let first = read_text_chunk(gbk.path(), 0, Some(3), Some("GBK")).unwrap();
    assert_eq!(first.content, "中");
    assert_eq!(first.next_offset, 2);
    let second = read_text_chunk(gbk.path(), first.next_offset, Some(3), Some("GBK")).unwrap();
    assert_eq!(second.content, "文!");
    assert!(second.eof);
}
