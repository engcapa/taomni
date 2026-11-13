//! Root-relative access. Unix walks pinned directory descriptors with no-follow
//! openat, so replacing a checked directory with a symlink cannot escape it.
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};

pub(super) fn io_error(operation: &str, error: io::Error) -> String {
    let kind = match error.kind() {
        io::ErrorKind::NotFound => "not_found",
        _ => "permission",
    };
    format!("{kind}: {operation}: {error}")
}

pub(super) fn absolute(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err("permission: Viewer paths must be absolute".into());
    }
    path.canonicalize()
        .map_err(|error| io_error("resolve path", error))
}

pub(super) fn display(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

pub(super) fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains(['\\', ':', '\0']) || value.chars().any(char::is_control)
    {
        return Err("permission: Expected a safe relative path".into());
    }
    let path = Path::new(value);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("permission: Relative paths cannot traverse or specify a root".into());
    }
    Ok(path.to_path_buf())
}

pub(super) fn file_name(value: &str) -> Result<&str, String> {
    let path = safe_relative(value)?;
    if value == "." || path.components().count() != 1 || value.contains('/') {
        return Err("permission: Expected a single file name".into());
    }
    Ok(value)
}

#[derive(Debug)]
pub(super) struct ScopedRoot {
    pub path: PathBuf,
    directory: File,
}

impl ScopedRoot {
    pub fn new(path: &Path) -> Result<Self, String> {
        let path = path
            .canonicalize()
            .map_err(|error| io_error("resolve root", error))?;
        if !path.is_dir() {
            return Err("permission: Root is not a directory".into());
        }
        #[cfg(unix)]
        let directory = {
            use std::os::unix::fs::OpenOptionsExt;
            fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
                .map_err(|error| io_error("open root", error))?
        };
        #[cfg(windows)]
        let directory = {
            use std::os::windows::fs::OpenOptionsExt;
            // Pin each root for the session and deny directory deletion/rename.
            fs::OpenOptions::new()
                .read(true)
                .share_mode(1 | 2)
                .custom_flags(0x0200_0000 | 0x0020_0000)
                .open(&path)
                .map_err(|error| io_error("pin root directory", error))?
        };
        Ok(Self { path, directory })
    }

    pub fn open(&self, relative: &str) -> Result<File, String> {
        let relative = safe_relative(relative)?;
        #[cfg(unix)]
        let file = {
            let (parent, name) = self.parent(&relative, false)?;
            open_at(&parent, &name, libc::O_RDONLY | libc::O_NONBLOCK, 0)
                .map_err(|error| io_error("open scoped file", error))?
        };
        #[cfg(not(unix))]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            let _parents = self.pin_windows_parents(&relative, false)?;
            let target = self.checked(&relative)?;
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(0x0020_0000)
                .open(&target)
                .map_err(|error| io_error("open scoped file", error))?;
            let rechecked = self.checked(&relative)?;
            let opened = same_file::Handle::from_file(
                file.try_clone()
                    .map_err(|error| io_error("clone file", error))?,
            )
            .map_err(|error| io_error("inspect scoped file", error))?;
            let current = same_file::Handle::from_path(&rechecked)
                .map_err(|error| io_error("inspect scoped path", error))?;
            if opened != current {
                return Err("permission: Scoped file changed while opening".into());
            }
            file
        };
        if !file
            .metadata()
            .map_err(|error| io_error("stat scoped file", error))?
            .is_file()
        {
            return Err("permission: Scoped resource is not a regular file".into());
        }
        Ok(file)
    }

    /// Create exclusively; callers can never overwrite a collision or symlink.
    pub fn create(&self, relative: &str) -> Result<File, io::Error> {
        let relative = safe_relative(relative).map_err(io::Error::other)?;
        #[cfg(unix)]
        {
            let (parent, name) = self.parent(&relative, true).map_err(io::Error::other)?;
            open_at(
                &parent,
                &name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )
        }
        #[cfg(not(unix))]
        {
            let _parents = self
                .pin_windows_parents(&relative, true)
                .map_err(io::Error::other)?;
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.path.join(relative))
        }
    }

    pub fn remove_created(&self, relative: &str) {
        #[cfg(unix)]
        if let Ok(relative) = safe_relative(relative) {
            use std::os::fd::AsRawFd;
            if let Ok((parent, name)) = self.parent(&relative, false) {
                // Only removes our exclusive basename, never traverses it.
                unsafe {
                    libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0);
                }
            }
        }
        #[cfg(not(unix))]
        if let Ok(relative) = safe_relative(relative) {
            if let Ok(_parents) = self.pin_windows_parents(&relative, false) {
                if let Ok(path) = self.checked(&relative) {
                    let _ = fs::remove_file(path);
                }
            }
        }
    }

    #[cfg(windows)]
    fn pin_windows_parents(&self, relative: &Path, create: bool) -> Result<Vec<File>, String> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        let mut pinned = vec![
            self.directory
                .try_clone()
                .map_err(|error| io_error("pin root", error))?,
        ];
        let mut current = self.path.clone();
        for component in relative.parent().unwrap_or(Path::new("")).components() {
            if component == Component::CurDir {
                continue;
            }
            current.push(component);
            if create {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(io_error("create asset directory", error)),
                }
            }
            // No FILE_SHARE_DELETE: the validated directory cannot be swapped
            // for a junction/symlink between path validation and child open.
            let handle = fs::OpenOptions::new()
                .read(true)
                .share_mode(1 | 2)
                .custom_flags(0x0200_0000 | 0x0020_0000)
                .open(&current)
                .map_err(|error| io_error("pin scoped directory", error))?;
            let meta = handle
                .metadata()
                .map_err(|error| io_error("inspect pinned directory", error))?;
            if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
                return Err("permission: Scoped directories cannot be reparse points".into());
            }
            self.checked(current.strip_prefix(&self.path).unwrap())?;
            pinned.push(handle);
        }
        Ok(pinned)
    }

    #[cfg(not(unix))]
    fn checked(&self, relative: &Path) -> Result<PathBuf, String> {
        let mut target = self.path.clone();
        for part in relative.components() {
            target.push(part);
            let meta =
                fs::symlink_metadata(&target).map_err(|error| io_error("inspect path", error))?;
            // Windows junctions/reparse points are not necessarily is_symlink.
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("permission: Reparse points are not allowed in scoped paths".into());
            }
        }
        let canonical = target
            .canonicalize()
            .map_err(|error| io_error("resolve resource", error))?;
        if !canonical.starts_with(&self.path) {
            return Err("permission: Resource escapes preview root".into());
        }
        Ok(canonical)
    }

    #[cfg(unix)]
    fn parent(&self, relative: &Path, create: bool) -> Result<(File, std::ffi::CString), String> {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let mut current = self
            .directory
            .try_clone()
            .map_err(|error| io_error("clone root", error))?;
        for part in relative.parent().unwrap_or(Path::new("")).components() {
            if part == Component::CurDir {
                continue;
            }
            let name = std::ffi::CString::new(part.as_os_str().as_bytes()).unwrap();
            if create {
                // mkdirat's EEXIST is harmless: openat below still rejects links.
                let result = unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) };
                if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(io_error(
                        "create asset directory",
                        io::Error::last_os_error(),
                    ));
                }
            }
            current = open_at(&current, &name, libc::O_RDONLY | libc::O_DIRECTORY, 0)
                .map_err(|error| io_error("open scoped directory", error))?;
        }
        let name = relative
            .file_name()
            .ok_or("permission: Missing resource name")?;
        let name = std::ffi::CString::new(name.as_bytes()).unwrap();
        Ok((current, name))
    }
}

#[cfg(unix)]
fn open_at(
    parent: &File,
    name: &std::ffi::CStr,
    flags: i32,
    mode: libc::mode_t,
) -> io::Result<File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    // Each descriptor owns exactly one successful openat result; O_NOFOLLOW
    // applies at every segment, O_NONBLOCK prevents FIFO resources blocking.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode,
        )
    };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
