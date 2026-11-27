use super::document_access::reject_profile_paths;
use super::paths::{ScopedRoot, absolute, display, file_name, io_error};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const MAX_COPY_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn validate(source: &Path, bytes: &[u8]) -> Result<(), String> {
    if super::is_owned_temp(source) {
        return Err("permission: Temporary documents are read-only".into());
    }
    if bytes.is_empty() || bytes.len() > MAX_COPY_BYTES {
        return Err("too_large: Document copies are limited to 32 MiB".into());
    }
    Ok(())
}

pub(crate) fn suggested_name(source: &Path) -> Result<String, String> {
    let base = source
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("Missing document name")?;
    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .ok_or("Missing document extension")?;
    Ok(format!("{base} - copy.{extension}"))
}

pub(crate) fn write(
    source: &Path,
    selected: &str,
    protected: &[&Path],
    bytes: &[u8],
) -> Result<String, String> {
    validate(source, bytes)?;
    let selected = Path::new(selected);
    let name = selected
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Missing copy name")?;
    let name = file_name(name)?;
    let expected = source.extension().ok_or("Missing document extension")?;
    if !selected
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(expected))
    {
        return Err(format!(
            "permission: Save with the .{} extension",
            expected.to_string_lossy()
        ));
    }
    let parent = selected
        .parent()
        .and_then(|path| path.to_str())
        .ok_or("Missing copy directory")?;
    let parent: PathBuf = absolute(parent)?;
    reject_profile_paths(protected, &parent)?;
    let parent = ScopedRoot::new(&parent)?;
    let mut staging = tempfile::Builder::new()
        .prefix(".taomni-document-")
        .tempfile_in(&parent.path)
        .map_err(|error| io_error("stage document copy", error))?;
    staging
        .write_all(bytes)
        .and_then(|()| staging.as_file().sync_all())
        .map_err(|error| io_error("write document copy", error))?;
    let output = parent.path.join(name);
    staging.persist_noclobber(&output).map_err(|failure| {
        if failure.error.kind() == io::ErrorKind::AlreadyExists {
            "conflict: A file with this name already exists. Choose a new name.".into()
        } else {
            io_error("publish document copy", failure.error)
        }
    })?;
    Ok(display(&output))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn publishes_a_copy_and_preserves_existing_source_and_destinations() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("report.pdf");
        let copy = root.path().join("report - copy.pdf");
        let config = root.path().join("app-profile");
        fs::create_dir(&config).unwrap();
        fs::write(&original, b"original").unwrap();
        let protected = [config.as_path()];
        assert_eq!(suggested_name(&original).unwrap(), "report - copy.pdf");
        assert!(write(&original, original.to_str().unwrap(), &protected, b"other").is_err());
        assert!(
            write(
                &original,
                config.join("copy.pdf").to_str().unwrap(),
                &protected,
                b"bytes"
            )
            .is_err()
        );
        assert!(!config.join("copy.pdf").exists());
        assert!(write(&original, copy.to_str().unwrap(), &protected, b"bytes").is_ok());
        assert!(
            write(
                &original,
                copy.to_str().unwrap(),
                &protected,
                b"replacement"
            )
            .is_err()
        );
        assert_eq!(fs::read(&original).unwrap(), b"original");
        assert_eq!(fs::read(&copy).unwrap(), b"bytes");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
    }
}
