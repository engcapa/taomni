use super::super::invalid;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub(super) struct Identity {
    volume: u64,
    index: u64,
}

impl Identity {
    #[cfg(unix)]
    pub(super) fn of(file: &File) -> io::Result<Self> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        Ok(Self {
            volume: metadata.dev(),
            index: metadata.ino(),
        })
    }

    #[cfg(windows)]
    pub(super) fn of(file: &File) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use winapi::um::fileapi::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        if unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), info.as_mut_ptr()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        if info.dwFileAttributes & 0x400 != 0 {
            return Err(io::Error::other("Archive paths cannot be reparse points"));
        }
        Ok(Self {
            volume: u64::from(info.dwVolumeSerialNumber),
            index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        })
    }

    pub(super) fn at(path: &Path) -> Result<Self, String> {
        Self::of(&open(path).map_err(invalid)?).map_err(invalid)
    }

    pub(super) fn verify(self, path: &Path, message: &str) -> Result<(), String> {
        if Self::at(path).ok() != Some(self) {
            return Err(invalid(message));
        }
        Ok(())
    }
}

fn open(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0200_0000 | 0x0020_0000);
    }
    options.open(path)
}

pub(super) fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(windows)]
    let _ = path;
    Ok(())
}

pub(super) fn directory_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.is_symlink() => Ok(true),
        Ok(_) => Err(invalid(
            "An unexpected file occupies the extraction staging path",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(invalid(error)),
    }
}
