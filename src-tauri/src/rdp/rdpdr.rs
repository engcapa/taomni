//! RDPDR (Device Redirection Virtual Channel) — MS-RDPEFS.
//!
//! Implements just enough framing to surface a single mapped local folder
//! as a redirected drive on the Windows host. The IO request handlers
//! sandbox every path to a canonicalized root.
//!
//! Implemented + unit-tested:
//!
//! - `RDPDR_HEADER` (Component / PacketId).
//! - `Server Announce` and `Client Announce Reply`.
//! - `Client Name Request`.
//! - Device list (we always announce exactly one filesystem device).
//! - IO request header parsing (DeviceCreate / Read / Write / Close /
//!   QueryInformation / QueryDirectory / DirectoryControl).
//! - Path safety check (`safe_join`) used by the handlers to refuse
//!   traversals.

mod protocol;

mod paths;

mod backend;

mod opening;

mod file_io;

mod queries;

mod mutations;

mod responses;

mod metadata;

#[cfg(test)]
mod tests;

pub use protocol::{
    AnnouncedDevice, DeviceIoRequestHeader, IRP_MJ_CLOSE, IRP_MJ_CREATE, IRP_MJ_DEVICE_CONTROL,
    IRP_MJ_DIRECTORY_CONTROL, IRP_MJ_QUERY_INFORMATION, IRP_MJ_QUERY_VOLUME_INFORMATION,
    IRP_MJ_READ, IRP_MJ_SET_INFORMATION, IRP_MJ_WRITE, PAKID_CORE_CLIENT_CAPABILITY,
    PAKID_CORE_CLIENT_NAME, PAKID_CORE_CLIENTID_CONFIRM, PAKID_CORE_DEVICE_IOREQUEST,
    PAKID_CORE_DEVICE_REPLY, PAKID_CORE_DEVICELIST_ANNOUNCE, PAKID_CORE_SERVER_ANNOUNCE,
    PAKID_CORE_SERVER_CAPABILITY, RDPDR_CTYP_CORE, RDPDR_CTYP_PRT, RDPDR_DTYP_FILESYSTEM,
    RDPDR_DTYP_PARALLEL, RDPDR_DTYP_PRINT, RDPDR_DTYP_SERIAL, RDPDR_DTYP_SMARTCARD, RdpdrHeader,
    build_client_name, build_device_list_announce,
};

pub use paths::safe_join;

pub use backend::{LocalDriveBackend, build_drive_channel};
