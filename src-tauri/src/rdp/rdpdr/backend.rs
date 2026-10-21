use super::opening::local_computer_name;
use super::opening::sanitize_drive_label;
use crate::rdp::DriveRedirectOpt;
use crate::rdp::session::SessionOutput;
use crate::rdp::session::SessionOutputSender;
use ironrdp::core::AsAny;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::Rdpdr as IronRdpdr;
use ironrdp::rdpdr::RdpdrBackend;
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::rdpdr::pdu::efs;
use ironrdp::rdpdr::pdu::esc::ScardCall;
use ironrdp::rdpdr::pdu::esc::ScardIoCtlCode;
use ironrdp::svc::SvcMessage;
use serde_json::json;
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::path::PathBuf;

pub(super) const DEFAULT_DRIVE_ID: u32 = 1;
pub(super) const MAX_DRIVE_IO_CHUNK: usize = 16 * 1024 * 1024;
pub(super) const MAX_DRIVE_FILE_BYTES: u64 = 1024 * 1024 * 1024;
pub(super) const MAX_DRIVE_SESSION_WRITE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub struct LocalDriveBackend {
    pub(super) root: PathBuf,
    pub(super) label: String,
    pub(super) next_file_id: u32,
    pub(super) handles: HashMap<u32, OpenedHandle>,
    pub(super) status_tx: Option<SessionOutputSender>,
    pub(super) read_only: bool,
    pub(super) written_bytes: u64,
}

#[derive(Debug)]
pub(super) struct OpenedHandle {
    pub(super) path: PathBuf,
    pub(super) kind: OpenedHandleKind,
}

#[derive(Debug)]
pub(super) enum OpenedHandleKind {
    File(File),
    Directory(DirectoryCursor),
}

#[derive(Debug, Default)]
pub(super) struct DirectoryCursor {
    pub(super) entries: Vec<PathBuf>,
    pub(super) index: usize,
}

impl LocalDriveBackend {
    pub fn new(root: impl AsRef<Path>, label: impl Into<String>) -> Result<Self, String> {
        Self::new_with_status(root, label, None)
    }

    pub fn new_with_status(
        root: impl AsRef<Path>,
        label: impl Into<String>,
        status_tx: Option<SessionOutputSender>,
    ) -> Result<Self, String> {
        Self::new_with_policy(root, label, status_tx, false)
    }

    pub(super) fn new_with_policy(
        root: impl AsRef<Path>,
        label: impl Into<String>,
        status_tx: Option<SessionOutputSender>,
        read_only: bool,
    ) -> Result<Self, String> {
        let root = root.as_ref();
        if root.as_os_str().is_empty() {
            return Err("rdpdr: redirected drive path is empty".into());
        }
        let root = root.canonicalize().map_err(|e| {
            format!(
                "rdpdr: canonicalize mapped drive '{}': {}",
                root.display(),
                e
            )
        })?;
        if !root.is_dir() {
            return Err(format!(
                "rdpdr: mapped drive '{}' is not a directory",
                root.display()
            ));
        }
        Ok(Self {
            label: sanitize_drive_label(&label.into(), &root),
            root,
            next_file_id: DEFAULT_DRIVE_ID,
            handles: HashMap::new(),
            status_tx,
            read_only,
            written_bytes: 0,
        })
    }

    pub(super) fn emit_status(&self, stage: &str, detail: &str) {
        let Some(tx) = &self.status_tx else {
            return;
        };
        let _ = tx.send(SessionOutput::Text(
            json!({
                "type": "status",
                "stage": stage,
                "detail": detail,
            })
            .to_string(),
        ));
    }

    pub(super) fn next_file_id(&mut self) -> u32 {
        self.next_file_id = self
            .next_file_id
            .saturating_add(1)
            .max(DEFAULT_DRIVE_ID + 1);
        self.next_file_id - 1
    }
}

impl AsAny for LocalDriveBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl RdpdrBackend for LocalDriveBackend {
    fn handle_server_device_announce_response(
        &mut self,
        pdu: efs::ServerDeviceAnnounceResponse,
    ) -> PduResult<()> {
        if pdu.result_code == efs::NtStatus::SUCCESS {
            self.emit_status(
                "drive-ready",
                &format!(
                    "RDP drive redirection accepted by server for device {}.",
                    pdu.device_id
                ),
            );
        } else {
            self.emit_status(
                "drive-rejected",
                &format!(
                    "RDP drive redirection rejected by server for device {}: {:?}.",
                    pdu.device_id, pdu.result_code
                ),
            );
        }
        Ok(())
    }

    fn handle_scard_call(
        &mut self,
        _req: efs::DeviceControlRequest<ScardIoCtlCode>,
        _call: ScardCall,
    ) -> PduResult<()> {
        Ok(())
    }

    fn handle_drive_io_request(
        &mut self,
        req: efs::ServerDriveIoRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        match req {
            efs::ServerDriveIoRequest::ServerCreateDriveRequest(req) => self.handle_create(req),
            efs::ServerDriveIoRequest::DeviceReadRequest(req) => self.handle_read(req),
            efs::ServerDriveIoRequest::DeviceWriteRequest(req) => self.handle_write(req),
            efs::ServerDriveIoRequest::DeviceCloseRequest(req) => self.handle_close(req),
            efs::ServerDriveIoRequest::ServerDriveQueryInformationRequest(req) => {
                self.handle_query_information(req)
            }
            efs::ServerDriveIoRequest::ServerDriveQueryDirectoryRequest(req) => {
                self.handle_query_directory(req)
            }
            efs::ServerDriveIoRequest::ServerDriveQueryVolumeInformationRequest(req) => {
                self.handle_query_volume_information(req)
            }
            efs::ServerDriveIoRequest::ServerDriveSetInformationRequest(req) => {
                self.handle_set_information(req)
            }
            efs::ServerDriveIoRequest::DeviceControlRequest(req) => Ok(vec![SvcMessage::from(
                RdpdrPdu::DeviceControlResponse(efs::DeviceControlResponse {
                    device_io_reply: efs::DeviceIoResponse::new(req.header, efs::NtStatus::SUCCESS),
                    output_buffer: None,
                }),
            )]),
            efs::ServerDriveIoRequest::ServerDriveNotifyChangeDirectoryRequest(_)
            | efs::ServerDriveIoRequest::ServerDriveLockControlRequest(_) => Ok(Vec::new()),
        }
    }
}

pub fn build_drive_channel(
    options: &DriveRedirectOpt,
    status_tx: Option<SessionOutputSender>,
) -> Result<Option<IronRdpdr>, String> {
    if !options.enabled {
        return Ok(None);
    }
    let backend = LocalDriveBackend::new_with_policy(
        &options.path,
        &options.label,
        status_tx,
        options.read_only,
    )?;
    let label = backend.label.clone();
    let computer_name = local_computer_name();
    Ok(Some(
        IronRdpdr::new(Box::new(backend), computer_name)
            .with_drives(Some(vec![(DEFAULT_DRIVE_ID, label)])),
    ))
}
