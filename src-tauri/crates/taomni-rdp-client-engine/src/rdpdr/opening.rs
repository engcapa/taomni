use super::backend::DirectoryCursor;
use super::backend::LocalDriveBackend;
use super::backend::MAX_DRIVE_FILE_BYTES;
use super::backend::OpenedHandle;
use super::backend::OpenedHandleKind;
use super::paths::safe_join;
use super::paths::validate_confined_path;
use super::responses::create_response;
use super::responses::io_status;
use ironrdp::pdu::PduResult;
use ironrdp::rdpdr::pdu::efs;
use ironrdp::svc::SvcMessage;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

impl LocalDriveBackend {
    pub(super) fn handle_create(
        &mut self,
        req: efs::DeviceCreateRequest,
    ) -> PduResult<Vec<SvcMessage>> {
        let path = match safe_join(&self.root, &req.path) {
            Ok(path) if validate_confined_path(&self.root, &path).is_ok() => path,
            Err(_) => {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::ACCESS_DENIED,
                    0,
                    efs::Information::empty(),
                ));
            }
            Ok(_) => {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::ACCESS_DENIED,
                    0,
                    efs::Information::empty(),
                ));
            }
        };
        let file_id = self.next_file_id();

        let mutating_open =
            wants_write(&req) || req.create_disposition != efs::CreateDisposition::FILE_OPEN;
        if self.read_only && mutating_open {
            return Ok(create_response(
                &req,
                efs::NtStatus::ACCESS_DENIED,
                file_id,
                efs::Information::empty(),
            ));
        }
        if req.allocation_size.max(0) as u64 > MAX_DRIVE_FILE_BYTES {
            return Ok(create_response(
                &req,
                efs::NtStatus::ACCESS_DENIED,
                file_id,
                efs::Information::empty(),
            ));
        }

        let wants_directory = req
            .create_options
            .contains(efs::CreateOptions::FILE_DIRECTORY_FILE);
        let forbids_directory = req
            .create_options
            .contains(efs::CreateOptions::FILE_NON_DIRECTORY_FILE);

        if wants_directory || path.is_dir() {
            return self.open_directory(req, path, file_id, forbids_directory);
        }

        if path.exists() && path.is_dir() && forbids_directory {
            return Ok(create_response(
                &req,
                efs::NtStatus::NOT_A_DIRECTORY,
                file_id,
                efs::Information::empty(),
            ));
        }

        self.open_file(req, path, file_id)
    }

    pub(super) fn open_directory(
        &mut self,
        req: efs::DeviceCreateRequest,
        path: PathBuf,
        file_id: u32,
        forbids_directory: bool,
    ) -> PduResult<Vec<SvcMessage>> {
        if forbids_directory {
            return Ok(create_response(
                &req,
                efs::NtStatus::UNSUCCESSFUL,
                file_id,
                efs::Information::empty(),
            ));
        }
        if !path.exists() {
            if req.create_disposition == efs::CreateDisposition::FILE_OPEN
                || req.create_disposition == efs::CreateDisposition::FILE_OVERWRITE
            {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::NO_SUCH_FILE,
                    file_id,
                    efs::Information::empty(),
                ));
            }
            if fs::create_dir_all(&path).is_err() {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::UNSUCCESSFUL,
                    file_id,
                    efs::Information::empty(),
                ));
            }
            if validate_confined_path(&self.root, &path).is_err() {
                return Ok(create_response(
                    &req,
                    efs::NtStatus::ACCESS_DENIED,
                    file_id,
                    efs::Information::empty(),
                ));
            }
        }
        if !path.is_dir() {
            return Ok(create_response(
                &req,
                efs::NtStatus::NOT_A_DIRECTORY,
                file_id,
                efs::Information::empty(),
            ));
        }
        self.handles.insert(
            file_id,
            OpenedHandle {
                path,
                kind: OpenedHandleKind::Directory(DirectoryCursor::default()),
            },
        );
        Ok(create_response(
            &req,
            efs::NtStatus::SUCCESS,
            file_id,
            create_information(&req.create_disposition),
        ))
    }

    pub(super) fn open_file(
        &mut self,
        req: efs::DeviceCreateRequest,
        path: PathBuf,
        file_id: u32,
    ) -> PduResult<Vec<SvcMessage>> {
        let existed = path.exists();
        let mut options = OpenOptions::new();
        options.read(true);
        if wants_write(&req) || req.create_disposition != efs::CreateDisposition::FILE_OPEN {
            options.write(true);
        }
        apply_disposition(&mut options, &req.create_disposition);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);

        match options.open(&path) {
            Ok(file) => {
                if file.metadata().map(|metadata| metadata.len()).unwrap_or(0)
                    > MAX_DRIVE_FILE_BYTES
                {
                    return Ok(create_response(
                        &req,
                        efs::NtStatus::ACCESS_DENIED,
                        file_id,
                        efs::Information::empty(),
                    ));
                }
                self.handles.insert(
                    file_id,
                    OpenedHandle {
                        path,
                        kind: OpenedHandleKind::File(file),
                    },
                );
                let information = if existed {
                    create_information(&req.create_disposition)
                } else {
                    efs::Information::FILE_SUPERSEDED
                };
                Ok(create_response(
                    &req,
                    efs::NtStatus::SUCCESS,
                    file_id,
                    information,
                ))
            }
            Err(e) => Ok(create_response(
                &req,
                io_status(&e),
                file_id,
                efs::Information::empty(),
            )),
        }
    }
}

pub(super) fn local_computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "taomni".to_owned())
}

pub(super) fn sanitize_drive_label(label: &str, root: &Path) -> String {
    let raw = label.trim();
    let fallback = root
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("taomni");
    let source = if raw.is_empty() { fallback } else { raw };
    let sanitized: String = source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(32)
        .collect();
    if sanitized.is_empty() {
        "taomni".to_owned()
    } else {
        sanitized
    }
}

pub(super) fn wants_write(req: &efs::DeviceCreateRequest) -> bool {
    req.desired_access.intersects(
        efs::DesiredAccess::FILE_WRITE_DATA_OR_FILE_ADD_FILE
            | efs::DesiredAccess::FILE_APPEND_DATA_OR_FILE_ADD_SUBDIRECTORY
            | efs::DesiredAccess::FILE_WRITE_EA
            | efs::DesiredAccess::FILE_WRITE_ATTRIBUTES
            | efs::DesiredAccess::DELETE
            | efs::DesiredAccess::GENERIC_WRITE
            | efs::DesiredAccess::GENERIC_ALL,
    )
}

pub(super) fn apply_disposition(options: &mut OpenOptions, disposition: &efs::CreateDisposition) {
    if *disposition == efs::CreateDisposition::FILE_CREATE {
        options.create_new(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_OPEN_IF {
        options.create(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_SUPERSEDE {
        options.create(true).truncate(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_OVERWRITE {
        options.truncate(true).write(true);
    } else if *disposition == efs::CreateDisposition::FILE_OVERWRITE_IF {
        options.create(true).truncate(true).write(true);
    }
}

pub(super) fn create_information(disposition: &efs::CreateDisposition) -> efs::Information {
    if *disposition == efs::CreateDisposition::FILE_OPEN
        || *disposition == efs::CreateDisposition::FILE_OPEN_IF
    {
        efs::Information::FILE_OPENED
    } else if *disposition == efs::CreateDisposition::FILE_OVERWRITE
        || *disposition == efs::CreateDisposition::FILE_OVERWRITE_IF
    {
        efs::Information::FILE_OVERWRITTEN
    } else {
        efs::Information::FILE_SUPERSEDED
    }
}
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
