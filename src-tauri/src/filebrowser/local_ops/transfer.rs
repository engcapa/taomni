use super::model::{CompletedEntry, EntryOperationResult, OpError, OpResult};
use super::operation::Operation;
use super::paths::{
    absolute_entry, destination_dir, reject_descendant, rename_no_replace, unique_path,
    validate_name,
};
use std::fs::{self, Metadata};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

struct SourceSnapshot {
    path: PathBuf,
    metadata: Metadata,
}

pub(super) fn transfer_entries(
    sources: Vec<String>,
    dest_dir: &Path,
    moving: bool,
    operation: &mut Operation,
) -> EntryOperationResult {
    let mut result = EntryOperationResult::default();
    let destination = destination_dir(dest_dir);
    for source in sources {
        let action = (|| {
            operation.check()?;
            let destination = destination
                .as_ref()
                .map_err(|error| OpError::new(error.code, &error.message))?;
            transfer_one(Path::new(&source), destination, moving, operation)
        })();
        match action {
            Ok(to) => result.done.push(CompletedEntry {
                from: source,
                to: to.to_string_lossy().into_owned(),
            }),
            Err(error) => result.failed.push(error.failure(source)),
        }
    }
    result
}

fn transfer_one(
    source: &Path,
    destination: &Path,
    moving: bool,
    operation: &mut Operation,
) -> OpResult<PathBuf> {
    let source = absolute_entry(source)?;
    let meta = fs::symlink_metadata(&source).map_err(|e| OpError::io("stat source", &source, e))?;
    reject_descendant(&source, destination)?;
    // Cut followed by Paste in the original folder is a no-op, never a rename.
    if moving && source.parent() == Some(destination) {
        return Ok(source);
    }
    let name = source
        .file_name()
        .ok_or_else(|| OpError::new("invalid_path", "Missing source filename"))?
        .to_string_lossy();
    let target = unique_path(destination, &name, meta.is_dir(), true)?;
    if moving {
        match rename_no_replace(&source, &target) {
            Ok(()) => {
                // A completed atomic rename remains a success even if Cancel
                // arrives immediately afterwards; only subsequent items stop.
                let _ = operation.advance(&target, if meta.is_file() { meta.len() } else { 0 }, 1);
                return Ok(target);
            }
            Err(error) if is_cross_device(&error) => {}
            Err(error) => return Err(OpError::io("move", &target, error)),
        }
    }
    copy_then_remove(&source, &target, moving, operation)?;
    Ok(target)
}

fn is_cross_device(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(17)
    }
}

/// A cross-volume move retains the entire source until the copy completes.
/// Deletion then only touches copied, unchanged nodes; newly created source
/// children make remove_dir fail rather than being lost in remove_dir_all.
pub(super) fn copy_then_remove(
    source: &Path,
    target: &Path,
    moving: bool,
    operation: &mut Operation,
) -> OpResult<()> {
    let mut copied = Vec::new();
    copy_node(source, target, operation, &mut copied, 0)?;
    if moving {
        operation.check()?;
        for snapshot in copied.into_iter().rev() {
            operation.check()?;
            let current = fs::symlink_metadata(&snapshot.path)
                .map_err(|e| OpError::io("verify source", &snapshot.path, e))?;
            if !unchanged(&snapshot.metadata, &current) {
                return Err(OpError::new(
                    "source_changed",
                    format!(
                        "Source changed during copy; retained {}",
                        snapshot.path.display()
                    ),
                ));
            }
            if current.is_dir() {
                fs::remove_dir(&snapshot.path)
                    .map_err(|e| OpError::io("remove copied source folder", &snapshot.path, e))?;
            } else {
                fs::remove_file(&snapshot.path)
                    .map_err(|e| OpError::io("remove copied source", &snapshot.path, e))?;
            }
        }
    }
    Ok(())
}

fn unchanged(before: &Metadata, after: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() {
            return false;
        }
    }
    before.file_type() == after.file_type()
        && (before.is_dir()
            || (before.len() == after.len() && before.modified().ok() == after.modified().ok()))
}

fn copy_node(
    source: &Path,
    target: &Path,
    operation: &mut Operation,
    copied: &mut Vec<SourceSnapshot>,
    depth: usize,
) -> OpResult<()> {
    operation.check()?;
    if depth > 256 {
        return Err(OpError::new(
            "too_deep",
            "Folder nesting exceeds 256 levels",
        ));
    }
    let meta = fs::symlink_metadata(source).map_err(|e| OpError::io("stat source", source, e))?;
    if meta.file_type().is_symlink() {
        copy_symlink(source, target, &meta)?;
    } else if meta.is_dir() {
        fs::create_dir(target).map_err(|e| OpError::io("create destination folder", target, e))?;
        copied.push(SourceSnapshot {
            path: source.to_path_buf(),
            metadata: meta.clone(),
        });
        for item in
            fs::read_dir(source).map_err(|e| OpError::io("read source folder", source, e))?
        {
            let item = item.map_err(|e| OpError::io("read source entry", source, e))?;
            copy_node(
                &item.path(),
                &target.join(item.file_name()),
                operation,
                copied,
                depth + 1,
            )?;
        }
        fs::set_permissions(target, meta.permissions())
            .map_err(|e| OpError::io("set destination permissions", target, e))?;
        operation.advance(target, 0, 1)?;
        return Ok(());
    } else if meta.is_file() {
        let mut input_options = fs::OpenOptions::new();
        input_options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            input_options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            input_options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let mut input = input_options
            .open(source)
            .map_err(|e| OpError::io("open source", source, e))?;
        if !unchanged(
            &meta,
            &input
                .metadata()
                .map_err(|e| OpError::io("stat open source", source, e))?,
        ) {
            return Err(OpError::new(
                "source_changed",
                "Source changed while opening it",
            ));
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)
            .map_err(|e| OpError::io("create destination file", target, e))?;
        let mut buffer = vec![0u8; 256 * 1024];
        loop {
            operation.check()?;
            let count = input
                .read(&mut buffer)
                .map_err(|e| OpError::io("read source", source, e))?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|e| OpError::io("write destination", target, e))?;
            operation.advance(target, count as u64, 0)?;
        }
        output
            .flush()
            .map_err(|e| OpError::io("flush destination", target, e))?;
        if !unchanged(
            &meta,
            &input
                .metadata()
                .map_err(|e| OpError::io("verify source", source, e))?,
        ) {
            return Err(OpError::new(
                "source_changed",
                format!("Source changed during copy: {}", source.display()),
            ));
        }
        fs::set_permissions(target, meta.permissions())
            .map_err(|e| OpError::io("set destination permissions", target, e))?;
    } else {
        return Err(OpError::new(
            "unsupported_type",
            "Only files, directories and symbolic links can be copied",
        ));
    }
    copied.push(SourceSnapshot {
        path: source.to_path_buf(),
        metadata: meta,
    });
    operation.advance(target, 0, 1)
}

#[cfg(unix)]
fn copy_symlink(source: &Path, target: &Path, _meta: &Metadata) -> OpResult<()> {
    let link = fs::read_link(source).map_err(|e| OpError::io("read symbolic link", source, e))?;
    std::os::unix::fs::symlink(link, target)
        .map_err(|e| OpError::io("copy symbolic link", target, e))
}

#[cfg(windows)]
fn copy_symlink(source: &Path, target: &Path, meta: &Metadata) -> OpResult<()> {
    use std::os::windows::fs::{MetadataExt, symlink_dir, symlink_file};
    let link = fs::read_link(source).map_err(|e| OpError::io("read symbolic link", source, e))?;
    let result = if meta.file_attributes() & 0x10 != 0 {
        symlink_dir(link, target)
    } else {
        symlink_file(link, target)
    };
    result.map_err(|e| {
        OpError::io(
            "copy symbolic link (Windows Developer Mode or symlink privilege may be required)",
            target,
            e,
        )
    })
}

pub(super) fn rename_entry(path: &Path, name: &str) -> OpResult<String> {
    validate_name(name)?;
    let source = absolute_entry(path)?;
    let destination = source.with_file_name(name);
    if source != destination {
        rename_no_replace(&source, &destination)
            .map_err(|e| OpError::io("rename", &destination, e))?;
    }
    // Return the caller's directory spelling: the shared listing also uses it.
    // A canonical Windows \\?\ prefix (or symlinked Unix parent) would otherwise
    // prevent the newly renamed row from matching the selection path.
    Ok(path.with_file_name(name).to_string_lossy().into_owned())
}

pub(super) fn create_entry(directory: &Path, name: &str, folder: bool) -> OpResult<String> {
    validate_name(name)?;
    let display_directory = directory.to_path_buf();
    let directory = destination_dir(directory)?;
    // Retry atomic create if another process wins the suggested filename.
    for _ in 0..100 {
        let path = unique_path(&directory, name, folder, false)?;
        let result = if folder {
            fs::create_dir(&path)
        } else {
            fs::File::create_new(&path).map(|_| ())
        };
        match result {
            Ok(()) => {
                return Ok(display_directory
                    .join(path.file_name().unwrap())
                    .to_string_lossy()
                    .into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(OpError::io("create entry", &path, e)),
        }
    }
    Err(OpError::new(
        "already_exists",
        "The destination keeps changing; try again",
    ))
}
