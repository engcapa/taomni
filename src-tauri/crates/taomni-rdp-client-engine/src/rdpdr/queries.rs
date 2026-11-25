use super::backend::LocalDriveBackend;
use super::backend::OpenedHandleKind;
use super::metadata::directory_info;
use super::metadata::display_name;
use super::metadata::file_attributes;
use super::metadata::metadata_time;
use super::metadata::metadata_times;
use super::metadata::query_entries;
use super::metadata::volume_serial;
use super::paths::validate_confined_path;
use super::responses::io_status;
use super::responses::query_dir_response;
use super::responses::query_info_response;
use super::responses::query_volume_response;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::pdu::efs;
use ironrdp::svc::SvcMessage;
use std::fs;
use std::io::Write;

impl LocalDriveBackend {
    pub(super) fn handle_query_information(
        &mut self,
        req: efs::ServerDriveQueryInformationRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let Some(handle) = self.handles.get(&req.device_io_request.file_id) else {
            return Ok(query_info_response(&req, efs::NtStatus::NO_SUCH_FILE, None));
        };
        if validate_confined_path(&self.root, &handle.path).is_err() {
            return Ok(query_info_response(
                &req,
                efs::NtStatus::ACCESS_DENIED,
                None,
            ));
        }
        let metadata = match fs::metadata(&handle.path) {
            Ok(metadata) => metadata,
            Err(e) => return Ok(query_info_response(&req, io_status(&e), None)),
        };
        let attrs = file_attributes(&metadata, &display_name(&handle.path, &self.label));
        let times = metadata_times(&metadata);
        let size = metadata.len().min(i64::MAX as u64) as i64;
        let buffer = match req.file_info_class_lvl {
            efs::FileInformationClassLevel::FILE_BASIC_INFORMATION => Some(
                efs::FileInformationClass::Basic(efs::FileBasicInformation {
                    creation_time: times.creation,
                    last_access_time: times.access,
                    last_write_time: times.write,
                    change_time: times.change,
                    file_attributes: attrs,
                }),
            ),
            efs::FileInformationClassLevel::FILE_STANDARD_INFORMATION => Some(
                efs::FileInformationClass::Standard(efs::FileStandardInformation {
                    allocation_size: size,
                    end_of_file: size,
                    number_of_links: 1,
                    delete_pending: efs::Boolean::False,
                    directory: if metadata.is_dir() {
                        efs::Boolean::True
                    } else {
                        efs::Boolean::False
                    },
                }),
            ),
            efs::FileInformationClassLevel::FILE_ATTRIBUTE_TAG_INFORMATION => Some(
                efs::FileInformationClass::AttributeTag(efs::FileAttributeTagInformation {
                    file_attributes: attrs,
                    reparse_tag: 0,
                }),
            ),
            _ => {
                return Ok(query_info_response(
                    &req,
                    efs::NtStatus::NOT_SUPPORTED,
                    None,
                ));
            }
        };
        Ok(query_info_response(&req, efs::NtStatus::SUCCESS, buffer))
    }

    pub(super) fn handle_query_directory(
        &mut self,
        req: efs::ServerDriveQueryDirectoryRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let Some(handle) = self.handles.get_mut(&req.device_io_request.file_id) else {
            return Ok(query_dir_response(&req, efs::NtStatus::NO_SUCH_FILE, None));
        };
        let OpenedHandleKind::Directory(cursor) = &mut handle.kind else {
            return Ok(query_dir_response(
                &req,
                efs::NtStatus::NOT_A_DIRECTORY,
                None,
            ));
        };

        if req.initial_query > 0 {
            match query_entries(&self.root, &handle.path, &req.path) {
                Ok(entries) => {
                    cursor.entries = entries;
                    cursor.index = 0;
                }
                Err(_) => return Ok(query_dir_response(&req, efs::NtStatus::NO_SUCH_FILE, None)),
            }
        }

        let Some(path) = cursor.entries.get(cursor.index).cloned() else {
            let status = if req.initial_query > 0 {
                efs::NtStatus::NO_SUCH_FILE
            } else {
                efs::NtStatus::NO_MORE_FILES
            };
            return Ok(query_dir_response(&req, status, None));
        };
        cursor.index += 1;

        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(e) => return Ok(query_dir_response(&req, io_status(&e), None)),
        };
        let name = display_name(&path, &self.label);
        let info = directory_info(&req.file_info_class_lvl, &metadata, name);
        match info {
            Some(info) => Ok(query_dir_response(&req, efs::NtStatus::SUCCESS, Some(info))),
            None => Ok(query_dir_response(&req, efs::NtStatus::NOT_SUPPORTED, None)),
        }
    }

    pub(super) fn handle_query_volume_information(
        &mut self,
        req: efs::ServerDriveQueryVolumeInformationRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let metadata = match fs::metadata(&self.root) {
            Ok(metadata) => metadata,
            Err(e) => return Ok(query_volume_response(&req, io_status(&e), None)),
        };
        let time = metadata_time(metadata.created().ok());
        let buffer = match req.fs_info_class_lvl {
            efs::FileSystemInformationClassLevel::FILE_FS_VOLUME_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsVolumeInformation(
                    efs::FileFsVolumeInformation {
                        volume_creation_time: time,
                        volume_serial_number: volume_serial(&self.root),
                        supports_objects: efs::Boolean::False,
                        volume_label: self.label.clone(),
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_SIZE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsSizeInformation(
                    efs::FileFsSizeInformation {
                        total_alloc_units: 1024 * 1024,
                        available_alloc_units: 1024 * 1024,
                        sectors_per_alloc_unit: 8,
                        bytes_per_sector: 512,
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_FULL_SIZE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsFullSizeInformation(
                    efs::FileFsFullSizeInformation {
                        total_alloc_units: 1024 * 1024,
                        caller_available_alloc_units: 1024 * 1024,
                        actual_available_alloc_units: 1024 * 1024,
                        sectors_per_alloc_unit: 8,
                        bytes_per_sector: 512,
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_ATTRIBUTE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsAttributeInformation(
                    efs::FileFsAttributeInformation {
                        file_system_attributes: efs::FileSystemAttributes::FILE_CASE_PRESERVED_NAMES
                            | efs::FileSystemAttributes::FILE_UNICODE_ON_DISK,
                        max_component_name_len: 255,
                        file_system_name: "TAOMNI".to_owned(),
                    },
                ))
            }
            efs::FileSystemInformationClassLevel::FILE_FS_DEVICE_INFORMATION => {
                Some(efs::FileSystemInformationClass::FileFsDeviceInformation(
                    efs::FileFsDeviceInformation {
                        device_type: 0x0000_0007,
                        characteristics: efs::Characteristics::FILE_REMOTE_DEVICE
                            | efs::Characteristics::FILE_DEVICE_IS_MOUNTED
                            | efs::Characteristics::FILE_VIRTUAL_VOLUME,
                    },
                ))
            }
            _ => {
                return Ok(query_volume_response(
                    &req,
                    efs::NtStatus::NOT_SUPPORTED,
                    None,
                ));
            }
        };
        Ok(query_volume_response(&req, efs::NtStatus::SUCCESS, buffer))
    }
}
