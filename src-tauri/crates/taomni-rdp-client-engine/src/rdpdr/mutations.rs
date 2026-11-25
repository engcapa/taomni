use super::backend::LocalDriveBackend;
use super::backend::MAX_DRIVE_FILE_BYTES;
use super::backend::OpenedHandleKind;
use super::paths::safe_join;
use super::paths::validate_confined_path;
use super::responses::io_status;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::rdpdr::pdu::efs;
use ironrdp::svc::SvcMessage;
use std::fs;
use std::fs::File;

impl LocalDriveBackend {
    pub(super) fn handle_set_information(
        &mut self,
        req: efs::ServerDriveSetInformationRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let status = match self.set_information_inner(&req) {
            Ok(()) => efs::NtStatus::SUCCESS,
            Err(status) => status,
        };
        let response = efs::ClientDriveSetInformationResponse::new(&req, status)
            .expect("RDPDR set-information response length fits in u32");
        Ok(vec![SvcMessage::from(
            RdpdrPdu::ClientDriveSetInformationResponse(response),
        )])
    }

    pub(super) fn set_information_inner(
        &mut self,
        req: &efs::ServerDriveSetInformationRequest,
    ) -> Result<(), efs::NtStatus> {
        if self.read_only {
            return Err(efs::NtStatus::ACCESS_DENIED);
        }
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Err(efs::NtStatus::NO_SUCH_FILE);
        };
        match &req.set_buffer {
            efs::FileInformationClass::Disposition(info) if info.delete_pending != 0 => {
                let status = if handle.path.is_dir() {
                    fs::remove_dir(&handle.path)
                } else {
                    fs::remove_file(&handle.path)
                };
                status.map_err(|e| io_status(&e))
            }
            efs::FileInformationClass::Rename(info) => {
                let target = safe_join(&self.root, &info.file_name)
                    .map_err(|_| efs::NtStatus::ACCESS_DENIED)?;
                validate_confined_path(&self.root, &target)
                    .map_err(|_| efs::NtStatus::ACCESS_DENIED)?;
                fs::rename(&handle.path, &target).map_err(|e| io_status(&e))?;
                handle.path = target;
                Ok(())
            }
            efs::FileInformationClass::EndOfFile(info) => {
                let OpenedHandleKind::File(file) = &mut handle.kind else {
                    return Err(efs::NtStatus::UNSUCCESSFUL);
                };
                let target_len = info.end_of_file.max(0) as u64;
                if target_len > MAX_DRIVE_FILE_BYTES {
                    return Err(efs::NtStatus::ACCESS_DENIED);
                }
                file.set_len(target_len).map_err(|e| io_status(&e))
            }
            efs::FileInformationClass::Allocation(_) | efs::FileInformationClass::Basic(_) => {
                Ok(())
            }
            _ => Err(efs::NtStatus::NOT_SUPPORTED),
        }
    }
}
