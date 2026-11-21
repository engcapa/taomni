use super::backend::LocalDriveBackend;
use super::backend::MAX_DRIVE_FILE_BYTES;
use super::backend::MAX_DRIVE_IO_CHUNK;
use super::backend::MAX_DRIVE_SESSION_WRITE_BYTES;
use super::backend::OpenedHandleKind;
use super::responses::io_status;
use super::responses::read_response;
use super::responses::write_response;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::rdpdr::pdu::efs;
use ironrdp::svc::SvcMessage;
use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;

impl LocalDriveBackend {
    pub(super) fn handle_read(
        &mut self,
        req: efs::DeviceReadRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Ok(read_response(&req, efs::NtStatus::NO_SUCH_FILE, Vec::new()));
        };
        let OpenedHandleKind::File(file) = &mut handle.kind else {
            return Ok(read_response(&req, efs::NtStatus::UNSUCCESSFUL, Vec::new()));
        };
        let requested = usize::try_from(req.length)
            .unwrap_or(usize::MAX)
            .min(MAX_DRIVE_IO_CHUNK);
        let mut data = vec![0; requested];
        let status = match file
            .seek(SeekFrom::Start(req.offset))
            .and_then(|_| file.read(&mut data))
        {
            Ok(len) => {
                data.truncate(len);
                efs::NtStatus::SUCCESS
            }
            Err(e) => {
                data.clear();
                io_status(&e)
            }
        };
        Ok(read_response(&req, status, data))
    }

    pub(super) fn handle_write(
        &mut self,
        req: efs::DeviceWriteRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let write_len = u64::try_from(req.write_data.len()).unwrap_or(u64::MAX);
        if self.read_only
            || req.write_data.len() > MAX_DRIVE_IO_CHUNK
            || req.offset.saturating_add(write_len) > MAX_DRIVE_FILE_BYTES
            || self.written_bytes.saturating_add(write_len) > MAX_DRIVE_SESSION_WRITE_BYTES
        {
            return Ok(write_response(&req, efs::NtStatus::ACCESS_DENIED, 0));
        }
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Ok(write_response(&req, efs::NtStatus::NO_SUCH_FILE, 0));
        };
        let OpenedHandleKind::File(file) = &mut handle.kind else {
            return Ok(write_response(&req, efs::NtStatus::UNSUCCESSFUL, 0));
        };
        let mut length = 0u32;
        let status = match file
            .seek(SeekFrom::Start(req.offset))
            .and_then(|_| file.write_all(&req.write_data))
            .and_then(|_| file.flush())
        {
            Ok(()) => {
                length = u32::try_from(req.write_data.len()).unwrap_or(u32::MAX);
                self.written_bytes = self.written_bytes.saturating_add(write_len);
                efs::NtStatus::SUCCESS
            }
            Err(e) => io_status(&e),
        };
        Ok(write_response(&req, status, length))
    }

    pub(super) fn handle_close(
        &mut self,
        req: efs::DeviceCloseRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        self.handles.remove(&req.device_io_request.file_id);
        Ok(vec![SvcMessage::from(RdpdrPdu::DeviceCloseResponse(
            efs::DeviceCloseResponse {
                device_io_response: efs::DeviceIoResponse::new(
                    req.device_io_request,
                    efs::NtStatus::SUCCESS,
                ),
            },
        ))])
    }
}
