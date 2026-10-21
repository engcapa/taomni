use super::backend::DEFAULT_DRIVE_ID;
use super::backend::LocalDriveBackend;
use super::backend::MAX_DRIVE_SESSION_WRITE_BYTES;
use super::backend::build_drive_channel;
use super::paths::safe_join;
use super::protocol::AnnouncedDevice;
use super::protocol::DeviceIoRequestHeader;
use super::protocol::IRP_MJ_READ;
use super::protocol::PAKID_CORE_DEVICE_IOREQUEST;
use super::protocol::PAKID_CORE_DEVICELIST_ANNOUNCE;
use super::protocol::RDPDR_CTYP_CORE;
use super::protocol::RDPDR_DTYP_FILESYSTEM;
use super::protocol::RdpdrHeader;
use super::protocol::build_client_name;
use super::protocol::build_device_list_announce;
use crate::rdp::DriveRedirectOpt;
use crate::rdp::session::SessionOutput;
use ironrdp::rdpdr::pdu::efs;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

#[test]
fn header_round_trip() {
    let h = RdpdrHeader {
        component: RDPDR_CTYP_CORE,
        packet_id: PAKID_CORE_DEVICE_IOREQUEST,
    };
    let buf = h.encode();
    let h2 = RdpdrHeader::parse(&buf).unwrap();
    assert_eq!(h, h2);
}

#[test]
fn client_name_carries_utf16() {
    let buf = build_client_name("HostName");
    // Unicode flag = 1
    assert_eq!(u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]), 1);
    // Length includes null terminator (HostName == 8 chars + NUL == 18 bytes).
    let name_len = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    assert_eq!(name_len as usize, "HostName".chars().count() * 2 + 2);
}

#[test]
fn device_list_round_trip_one_filesystem() {
    let dev = AnnouncedDevice {
        device_id: 1,
        device_type: RDPDR_DTYP_FILESYSTEM,
        preferred_dos_name: "TAOMNI".into(),
        device_data: b"shared\0".to_vec(),
    };
    let buf = build_device_list_announce(&[dev.clone()]).unwrap();
    let header = RdpdrHeader::parse(&buf).unwrap();
    assert_eq!(header.packet_id, PAKID_CORE_DEVICELIST_ANNOUNCE);
    let count = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]);
    assert_eq!(count, 1);
    let dtype = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]);
    assert_eq!(dtype, RDPDR_DTYP_FILESYSTEM);
}

#[test]
fn device_list_rejects_long_dos_name() {
    let dev = AnnouncedDevice {
        device_id: 1,
        device_type: RDPDR_DTYP_FILESYSTEM,
        preferred_dos_name: "TOOLONGNAME".into(),
        device_data: vec![],
    };
    assert!(build_device_list_announce(&[dev]).is_err());
}

#[test]
fn io_request_header_round_trip() {
    let h = DeviceIoRequestHeader {
        device_id: 1,
        file_id: 0xCAFE,
        completion_id: 99,
        major: IRP_MJ_READ,
        minor: 0,
    };
    let buf = h.encode();
    let h2 = DeviceIoRequestHeader::parse(&buf).unwrap();
    assert_eq!(h, h2);
}

#[test]
fn io_request_header_rejects_truncated() {
    assert!(DeviceIoRequestHeader::parse(&[0u8; 10]).is_err());
}

#[test]
fn safe_join_blocks_dot_dot() {
    let root = Path::new("/var/lib/taomni");
    assert!(safe_join(root, "../etc/passwd").is_err());
    assert!(safe_join(root, "/../etc/passwd").is_err());
    assert!(safe_join(root, "subdir/../../escape").is_err());
}

#[test]
fn safe_join_allows_internal_traversal() {
    let root = Path::new("/data");
    let p = safe_join(root, "/sub/dir/file.txt").unwrap();
    assert_eq!(p, PathBuf::from("/data/sub/dir/file.txt"));
    let p2 = safe_join(root, "sub/../sub/x").unwrap();
    assert_eq!(p2, PathBuf::from("/data/sub/x"));
}

#[test]
fn safe_join_normalizes_backslashes() {
    let root = Path::new("/data");
    let p = safe_join(root, r"sub\dir\file").unwrap();
    assert_eq!(p, PathBuf::from("/data/sub/dir/file"));
}

fn io_request(
    file_id: u32,
    completion_id: u32,
    major_function: efs::MajorFunction,
) -> efs::DeviceIoRequest {
    efs::DeviceIoRequest {
        device_id: DEFAULT_DRIVE_ID,
        file_id,
        completion_id,
        major_function,
        minor_function: efs::MinorFunction::from(0),
    }
}

fn create_request(path: &str) -> efs::DeviceCreateRequest {
    efs::DeviceCreateRequest {
        device_io_request: io_request(0, 1, efs::MajorFunction::Create),
        desired_access: efs::DesiredAccess::GENERIC_READ | efs::DesiredAccess::GENERIC_WRITE,
        allocation_size: 0,
        file_attributes: efs::FileAttributes::empty(),
        shared_access: efs::SharedAccess::FILE_SHARE_READ
            | efs::SharedAccess::FILE_SHARE_WRITE
            | efs::SharedAccess::FILE_SHARE_DELETE,
        create_disposition: efs::CreateDisposition::FILE_OPEN_IF,
        create_options: efs::CreateOptions::FILE_NON_DIRECTORY_FILE,
        path: path.to_owned(),
    }
}

#[test]
fn local_drive_backend_writes_inside_mapped_root() {
    let dir = tempfile::tempdir().unwrap();
    let mut backend = LocalDriveBackend::new(dir.path(), "shared").unwrap();

    backend
        .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
            create_request("hello.txt"),
        ))
        .unwrap();
    backend
        .handle_drive_io_request(efs::ServerDriveIoRequest::DeviceWriteRequest(
            efs::DeviceWriteRequest {
                device_io_request: io_request(DEFAULT_DRIVE_ID, 2, efs::MajorFunction::Write),
                offset: 0,
                write_data: b"abc".to_vec(),
            },
        ))
        .unwrap();

    assert_eq!(fs::read(dir.path().join("hello.txt")).unwrap(), b"abc");
}

#[test]
fn local_drive_backend_rejects_path_escape() {
    let dir = tempfile::tempdir().unwrap();
    let mut backend = LocalDriveBackend::new(dir.path(), "shared").unwrap();

    backend
        .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
            create_request("../escape.txt"),
        ))
        .unwrap();

    assert!(backend.handles.is_empty());
    assert!(!dir.path().parent().unwrap().join("escape.txt").exists());
}

#[cfg(unix)]
#[test]
fn local_drive_backend_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), root.path().join("outside")).unwrap();
    let mut backend = LocalDriveBackend::new(root.path(), "shared").unwrap();

    backend
        .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
            create_request("outside/escape.txt"),
        ))
        .unwrap();

    assert!(backend.handles.is_empty());
    assert!(!outside.path().join("escape.txt").exists());
}

#[test]
fn local_drive_backend_read_only_policy_denies_mutating_open() {
    let dir = tempfile::tempdir().unwrap();
    let mut backend = LocalDriveBackend::new_with_policy(dir.path(), "shared", None, true).unwrap();

    backend
        .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
            create_request("blocked.txt"),
        ))
        .unwrap();

    assert!(backend.handles.is_empty());
    assert!(!dir.path().join("blocked.txt").exists());
}

#[test]
fn local_drive_backend_enforces_session_write_quota() {
    let dir = tempfile::tempdir().unwrap();
    let mut backend = LocalDriveBackend::new(dir.path(), "shared").unwrap();
    backend
        .handle_drive_io_request(efs::ServerDriveIoRequest::ServerCreateDriveRequest(
            create_request("quota.txt"),
        ))
        .unwrap();
    backend.written_bytes = MAX_DRIVE_SESSION_WRITE_BYTES;

    backend
        .handle_drive_io_request(efs::ServerDriveIoRequest::DeviceWriteRequest(
            efs::DeviceWriteRequest {
                device_io_request: io_request(DEFAULT_DRIVE_ID, 2, efs::MajorFunction::Write),
                offset: 0,
                write_data: b"blocked".to_vec(),
            },
        ))
        .unwrap();

    assert_eq!(fs::read(dir.path().join("quota.txt")).unwrap(), b"");
}

#[test]
fn build_drive_channel_ignores_disabled_option() {
    let options = DriveRedirectOpt {
        enabled: false,
        label: "shared".into(),
        path: String::new(),
        read_only: true,
    };
    assert!(build_drive_channel(&options, None).unwrap().is_none());
}

#[tokio::test]
async fn local_drive_backend_reports_server_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let (mut handle, tx, _ctrl_rx) = crate::rdp::session::RdpSessionHandle::new();
    let mut backend = LocalDriveBackend::new_with_status(dir.path(), "shared", Some(tx)).unwrap();

    backend
        .handle_server_device_announce_response(efs::ServerDeviceAnnounceResponse {
            device_id: DEFAULT_DRIVE_ID,
            result_code: efs::NtStatus::SUCCESS,
        })
        .unwrap();

    match handle.next_outgoing().await.unwrap() {
        SessionOutput::Text(text) => {
            assert!(text.contains(r#""stage":"drive-ready""#));
            assert!(text.contains("accepted by server"));
        }
        SessionOutput::Channel { .. } => panic!("expected drive status text"),
    }
}
use ironrdp::rdpdr::RdpdrBackend;
