use super::document_access::reject_profile_paths;
use super::paths::{ScopedRoot, absolute, display, file_name, io_error};
use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tauri::Window;
use tauri_plugin_dialog::DialogExt;

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

fn extension<'a>(
    source: &'a Path,
    slug: &str,
    output: Option<&'a str>,
) -> Result<&'a OsStr, String> {
    if let Some(output) = output {
        if matches!(
            (slug, output),
            ("taoffice-video", "mp4" | "webm") | ("taoffice-visio", "svg")
        ) {
            return Ok(OsStr::new(output));
        }
        return Err("permission: The requested document copy format is unavailable".into());
    }
    let extension = source.extension().ok_or("Missing document extension")?;
    if slug == "taoffice-word"
        && ["doc", "odt", "rtf"]
            .iter()
            .any(|legacy| extension.eq_ignore_ascii_case(legacy))
    {
        return Ok(OsStr::new("docx"));
    }
    Ok(
        if slug == "taoffice-project"
            && ["mpp", "mpx"]
                .iter()
                .any(|ext| extension.eq_ignore_ascii_case(ext))
        {
            OsStr::new("xml")
        } else {
            extension
        },
    )
}

fn suggested_name(source: &Path, slug: &str, output: Option<&str>) -> Result<String, String> {
    let base = source
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("Missing document name")?;
    let extension = extension(source, slug, output)?
        .to_str()
        .ok_or("Missing document extension")?;
    Ok(format!("{base} - copy.{extension}"))
}

pub(crate) fn select_destination(
    window: &Window,
    source: &Path,
    slug: &str,
    output: Option<&str>,
) -> Result<Option<String>, String> {
    let name = suggested_name(source, slug, output)?;
    let parent = source.parent().ok_or("Missing document directory")?;
    let selected = window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Save as")
        .set_directory(parent)
        .set_file_name(name)
        .blocking_save_file();
    selected
        .map(|file| {
            let path = file.into_path().map_err(|error| error.to_string())?;
            Ok(display(&path))
        })
        .transpose()
}

pub(crate) fn write(
    source: &Path,
    slug: &str,
    selected: &str,
    protected: &[&Path],
    bytes: &[u8],
    output: Option<&str>,
) -> Result<String, String> {
    validate(source, bytes)?;
    let selected = Path::new(selected);
    let name = selected
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Missing copy name")?;
    let name = file_name(name)?;
    let expected = extension(source, slug, output)?;
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
        let slug = "taoffice-pdf";
        assert_eq!(
            suggested_name(&original, slug, None).unwrap(),
            "report - copy.pdf"
        );
        assert!(
            write(
                &original,
                slug,
                original.to_str().unwrap(),
                &protected,
                b"other",
                None,
            )
            .is_err()
        );
        assert!(
            write(
                &original,
                slug,
                config.join("copy.pdf").to_str().unwrap(),
                &protected,
                b"bytes",
                None,
            )
            .is_err()
        );
        assert!(!config.join("copy.pdf").exists());
        assert!(
            write(
                &original,
                slug,
                copy.to_str().unwrap(),
                &protected,
                b"bytes",
                None,
            )
            .is_ok()
        );
        assert!(
            write(
                &original,
                slug,
                copy.to_str().unwrap(),
                &protected,
                b"replacement",
                None,
            )
            .is_err()
        );
        assert_eq!(fs::read(&original).unwrap(), b"original");
        assert_eq!(fs::read(&copy).unwrap(), b"bytes");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
    }

    #[test]
    fn a_project_import_saves_only_as_xml() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("plan.MPP");
        let valid = root.path().join("plan - copy.xml");
        let invalid = root.path().join("other.mpp");
        assert_eq!(
            suggested_name(&root.path().join("plan.MPX"), "taoffice-project", None).unwrap(),
            "plan - copy.xml"
        );
        fs::write(&source, b"original").unwrap();
        let slug = "taoffice-project";
        assert_eq!(
            suggested_name(&source, slug, None).unwrap(),
            "plan - copy.xml"
        );
        assert!(write(&source, slug, invalid.to_str().unwrap(), &[], b"xml", None).is_err());
        assert!(!invalid.exists());
        write(&source, slug, valid.to_str().unwrap(), &[], b"xml", None).unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert_eq!(fs::read(&valid).unwrap(), b"xml");
    }

    #[test]
    fn legacy_word_copies_require_docx_and_keep_the_original() {
        let root = tempfile::tempdir().unwrap();
        for extension in ["DOC", "odt", "Rtf"] {
            let source = root.path().join(format!("notes.{extension}"));
            let target = root.path().join(format!("notes-{extension}.docx"));
            let invalid = root.path().join(format!("duplicate.{extension}"));
            let slug = "taoffice-word";
            fs::write(&source, b"legacy document").unwrap();
            assert_eq!(
                suggested_name(&source, slug, None).unwrap(),
                "notes - copy.docx"
            );
            assert!(write(&source, slug, invalid.to_str().unwrap(), &[], b"docx", None).is_err());
            assert!(!invalid.exists());
            assert!(suggested_name(&source, slug, Some("rtf")).is_err());
            write(&source, slug, target.to_str().unwrap(), &[], b"docx", None).unwrap();
            assert_eq!(fs::read(&source).unwrap(), b"legacy document");
            assert_eq!(fs::read(&target).unwrap(), b"docx");
        }
    }

    #[test]
    fn a_media_transcode_saves_only_to_the_authorized_output_extension() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("recording.avi");
        let target = root.path().join("review.webm");
        fs::write(&source, b"source").unwrap();
        assert_eq!(
            suggested_name(&source, "taoffice-video", Some("webm")).unwrap(),
            "recording - copy.webm"
        );
        assert!(suggested_name(&source, "taoffice-video", Some("mov")).is_err());
        assert!(suggested_name(&source, "taoffice-ppt", Some("webm")).is_err());
        assert!(
            write(
                &source,
                "taoffice-video",
                target.to_str().unwrap(),
                &[],
                b"encoded",
                Some("mp4")
            )
            .is_err()
        );
        write(
            &source,
            "taoffice-video",
            target.to_str().unwrap(),
            &[],
            b"encoded",
            Some("webm"),
        )
        .unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&target).unwrap(), b"encoded");
    }
}
