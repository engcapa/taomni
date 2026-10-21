use super::download::FileDownload;
use super::download::Progress;
use super::files::collect_announced_files;
use super::host_content::HostContent;
use super::host_content::without_uri_list_cr;
use super::limits::MAX_CLIPBOARD_TEXT_BYTES;
use super::policy::ClipboardPolicy;
use super::policy::unicode_payload_within_limit;
use super::requests::RequestGate;
use crate::servers::rdp::clipboard_formats::ClipboardLevel;
use crate::servers::rdp::clipboard_formats::RgbaImage;
use ironrdp::cliprdr::pdu::ClipboardFileAttributes;
use ironrdp::cliprdr::pdu::FileContentsFlags;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::cliprdr::pdu::FileContentsResponse;
use ironrdp::cliprdr::pdu::FileDescriptor;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

#[test]
fn clipboard_limit_counts_encoded_unicode_payload() {
    let max_ascii_chars = (MAX_CLIPBOARD_TEXT_BYTES - 2) / 2;
    assert!(unicode_payload_within_limit(&"a".repeat(max_ascii_chars)));
    assert!(!unicode_payload_within_limit(
        &"a".repeat(max_ascii_chars + 1)
    ));
    // A supplementary character occupies a UTF-16 surrogate pair.
    assert!(!unicode_payload_within_limit(&"😀".repeat(max_ascii_chars)));
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "taomni-rdp-clipboard-test-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn request_gate_discards_answers_to_a_superseded_copy() {
    // Copy #1 asks for text; copy #2 arrives before the answer.
    let mut gate = RequestGate::default();
    assert!(gate.idle());
    gate.sent();
    gate.supersede();
    assert!(!gate.idle(), "copy #2 waits for the outstanding answer");
    assert!(!gate.answered(), "the answer belongs to copy #1");
    assert!(gate.idle());
    // Copy #2's own request and answer.
    gate.sent();
    assert!(gate.answered());
    // A new copy with nothing in flight has nothing to discard.
    gate.supersede();
    gate.sent();
    assert!(gate.answered());
}

#[test]
fn identity_ignores_paths_line_endings_and_alpha() {
    let a = temp_dir("identity-a");
    let b = temp_dir("identity-b");
    std::fs::write(a.join("report.txt"), b"12345").unwrap();
    std::fs::write(b.join("report.txt"), b"54321").unwrap();
    let files = |dir: &Path| HostContent {
        files: vec![dir.join("report.txt")],
        ..HostContent::default()
    };
    assert_eq!(files(&a).identity(), files(&b).identity());
    std::fs::write(b.join("report.txt"), b"longer").unwrap();
    assert_ne!(files(&a).identity(), files(&b).identity());

    let text = |value: &str| HostContent {
        text: Some(value.to_string()),
        ..HostContent::default()
    };
    assert_eq!(text("a\r\nb").identity(), text("a\nb").identity());
    assert_ne!(text("a").identity(), text("b").identity());

    let image = |alpha: u8| HostContent {
        image: Some(Arc::new(
            RgbaImage::new(1, 1, vec![1, 2, 3, alpha]).unwrap(),
        )),
        ..HostContent::default()
    };
    assert_eq!(image(0).identity(), image(255).identity());
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}

#[test]
fn uri_list_carriage_returns_are_not_part_of_host_paths() {
    assert_eq!(
        without_uri_list_cr(PathBuf::from("/tmp/宿主样本\r")),
        PathBuf::from("/tmp/宿主样本")
    );
    assert_eq!(
        without_uri_list_cr(PathBuf::from("/tmp/report.txt")),
        PathBuf::from("/tmp/report.txt")
    );
}

#[test]
fn announced_files_expand_directories_in_name_order() {
    let root = temp_dir("announce");
    let tree = root.join("项目");
    std::fs::create_dir_all(tree.join("sub")).unwrap();
    std::fs::write(tree.join("b.txt"), b"bb").unwrap();
    std::fs::write(tree.join("sub").join("a.bin"), b"a").unwrap();
    let (descriptors, files) = collect_announced_files(&[tree.clone()], 1024).unwrap();
    let names: Vec<String> = descriptors
        .iter()
        .map(|d| match &d.relative_path {
            Some(path) => format!("{path}\\{}", d.name),
            None => d.name.clone(),
        })
        .collect();
    assert_eq!(
        names,
        ["项目", "项目\\b.txt", "项目\\sub", "项目\\sub\\a.bin"]
    );
    assert!(files[0].is_directory && files[2].is_directory);
    assert_eq!((files[1].size, files[3].size), (2, 1));
    assert_eq!(descriptors[1].file_size, Some(2));
    assert!(
        collect_announced_files(&[tree], 2)
            .unwrap_err()
            .contains("limit")
    );
    let _ = std::fs::remove_dir_all(&root);
}

fn descriptor(name: &str, dir: Option<&str>, size: Option<u64>, directory: bool) -> FileDescriptor {
    let mut d = FileDescriptor::new(name).with_attributes(if directory {
        ClipboardFileAttributes::DIRECTORY
    } else {
        ClipboardFileAttributes::NORMAL
    });
    if let Some(dir) = dir {
        d = d.with_relative_path(dir);
    }
    if let Some(size) = size {
        d = d.with_file_size(size);
    }
    d
}

fn expect_request(progress: Progress) -> FileContentsRequest {
    match progress {
        Progress::Request(request) => request,
        Progress::Done => panic!("expected another request"),
    }
}

#[test]
fn download_fetches_sizes_then_ranges_into_staging() {
    let files = [
        descriptor("d", None, None, true),
        descriptor("x.txt", Some("d"), Some(3), false),
        descriptor("y.txt", None, None, false),
    ];
    let mut download = FileDownload::start(&files, Some(7), 1024).unwrap();
    let staging = download.staging.0.clone();

    let range = expect_request(download.next_request());
    assert_eq!(
        (range.index, range.position, range.requested_size),
        (1, 0, 3)
    );
    assert_eq!(range.data_id, Some(7));
    let next = download
        .accept(&FileContentsResponse::new_data_response(
            range.stream_id,
            b"abc".to_vec(),
        ))
        .unwrap();
    let size = expect_request(next);
    assert!(size.flags.contains(FileContentsFlags::SIZE));
    assert_eq!(size.index, 2);
    let next = download
        .accept(&FileContentsResponse::new_size_response(size.stream_id, 2))
        .unwrap();
    let range = expect_request(next);
    assert_eq!((range.index, range.requested_size), (2, 2));
    let done = download
        .accept(&FileContentsResponse::new_data_response(
            range.stream_id,
            b"yz".to_vec(),
        ))
        .unwrap();
    assert!(matches!(done, Progress::Done));

    assert_eq!(
        std::fs::read(staging.join("d").join("x.txt")).unwrap(),
        b"abc"
    );
    assert_eq!(std::fs::read(staging.join("y.txt")).unwrap(), b"yz");
    assert_eq!(
        download.top_level,
        vec![staging.join("d"), staging.join("y.txt")]
    );
    drop(download);
    assert!(!staging.exists(), "unpublished staging is removed");
}

#[test]
fn download_rejects_oversized_or_mismatched_data() {
    let over_quota = [descriptor("big.bin", None, Some(2048), false)];
    assert!(FileDownload::start(&over_quota, None, 1024).is_err());

    let files = [descriptor("a.txt", None, Some(2), false)];
    let mut download = FileDownload::start(&files, None, 1024).unwrap();
    let request = expect_request(download.next_request());
    let error = download
        .accept(&FileContentsResponse::new_data_response(
            request.stream_id,
            b"abc".to_vec(),
        ))
        .err()
        .unwrap();
    assert!(error.contains("exceeded"));

    let mut download = FileDownload::start(&files, None, 1024).unwrap();
    let request = expect_request(download.next_request());
    assert!(
        download
            .accept(&FileContentsResponse::new_data_response(
                request.stream_id + 1,
                b"ab".to_vec()
            ))
            .is_err()
    );
}

#[test]
fn policy_defaults_to_all_and_falls_back_to_text() {
    let (policy, warnings) = ClipboardPolicy::from_settings("", "bogus", 0);
    assert_eq!(policy.server_to_client, ClipboardLevel::All);
    assert_eq!(policy.client_to_server, ClipboardLevel::Text);
    assert_eq!(policy.file_max_bytes, 1024 * 1024);
    assert!(policy.enabled() && policy.files_enabled());
    assert_eq!(warnings.len(), 1);
    let (off, warnings) = ClipboardPolicy::from_settings("off", "OFF", 10);
    assert!(!off.enabled() && warnings.is_empty());
}
