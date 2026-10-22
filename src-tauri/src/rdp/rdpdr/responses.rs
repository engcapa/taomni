use ironrdp::rdpdr::pdu::RdpdrPdu;
use ironrdp::rdpdr::pdu::efs;
use ironrdp::svc::SvcMessage;

pub(super) fn create_response(
    req: &efs::DeviceCreateRequest,
    status: efs::NtStatus,
    file_id: u32,
    information: efs::Information,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(RdpdrPdu::DeviceCreateResponse(
        efs::DeviceCreateResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            file_id,
            information,
        },
    ))]
}

pub(super) fn read_response(
    req: &efs::DeviceReadRequest,
    status: efs::NtStatus,
    read_data: Vec<u8>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(RdpdrPdu::DeviceReadResponse(
        efs::DeviceReadResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            read_data,
        },
    ))]
}

pub(super) fn write_response(
    req: &efs::DeviceWriteRequest,
    status: efs::NtStatus,
    length: u32,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(RdpdrPdu::DeviceWriteResponse(
        efs::DeviceWriteResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            length,
        },
    ))]
}

pub(super) fn query_info_response(
    req: &efs::ServerDriveQueryInformationRequest,
    status: efs::NtStatus,
    buffer: Option<efs::FileInformationClass>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(
        RdpdrPdu::ClientDriveQueryInformationResponse(efs::ClientDriveQueryInformationResponse {
            device_io_response: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            buffer,
        }),
    )]
}

pub(super) fn query_dir_response(
    req: &efs::ServerDriveQueryDirectoryRequest,
    status: efs::NtStatus,
    buffer: Option<efs::FileInformationClass>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(
        RdpdrPdu::ClientDriveQueryDirectoryResponse(efs::ClientDriveQueryDirectoryResponse {
            device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
            buffer,
        }),
    )]
}

pub(super) fn query_volume_response(
    req: &efs::ServerDriveQueryVolumeInformationRequest,
    status: efs::NtStatus,
    buffer: Option<efs::FileSystemInformationClass>,
) -> Vec<SvcMessage> {
    vec![SvcMessage::from(
        RdpdrPdu::ClientDriveQueryVolumeInformationResponse(
            efs::ClientDriveQueryVolumeInformationResponse {
                device_io_reply: efs::DeviceIoResponse::new(req.device_io_request.clone(), status),
                buffer,
            },
        ),
    )]
}

pub(super) fn io_status(error: &std::io::Error) -> efs::NtStatus {
    match error.kind() {
        std::io::ErrorKind::NotFound => efs::NtStatus::NO_SUCH_FILE,
        std::io::ErrorKind::PermissionDenied => efs::NtStatus::ACCESS_DENIED,
        _ => efs::NtStatus::UNSUCCESSFUL,
    }
}
