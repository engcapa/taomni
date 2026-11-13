//! Paste destinations remain relative to the saved document's canonical parent.
use super::HARD_BYTES;
use super::SavedImage;
use super::filesystem::open_regular;
use super::paths::{ScopedRoot, display, file_name, io_error, safe_relative};
use std::io::Write;
use std::path::Path;

pub(crate) fn save_pasted_image(
    doc_path: &str,
    dir: &str,
    requested_name: &str,
    bytes: &[u8],
) -> Result<SavedImage, String> {
    if bytes.is_empty() {
        return Err("binary: Pasted image is empty".into());
    }
    if bytes.len() as u64 > HARD_BYTES {
        return Err("too_large: Image exceeds 64 MiB".into());
    }
    let directory = safe_relative(dir)?;
    let directory = directory
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    let name = file_name(requested_name)?;
    let (document, _, _) = open_regular(doc_path)?;
    let root = ScopedRoot::new(
        document
            .parent()
            .ok_or("permission: Missing document directory")?,
    )?;
    let stem = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let extension = Path::new(name).extension().and_then(|value| value.to_str());
    for collision in 0..10_000u32 {
        let name = if collision == 0 {
            name.to_string()
        } else {
            let suffix = extension
                .map(|value| format!(".{value}"))
                .unwrap_or_default();
            format!("{stem}-{collision}{suffix}")
        };
        let relative = if directory.is_empty() {
            name
        } else {
            format!("{directory}/{name}")
        };
        let relative = relative.as_str();
        let mut file = match root.create(relative) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error("create pasted image", error)),
        };
        let write = file.write_all(bytes).and_then(|()| file.sync_all());
        drop(file);
        if let Err(error) = write {
            root.remove_created(relative);
            return Err(io_error("write pasted image", error));
        }
        return Ok(SavedImage {
            path: display(&root.path.join(relative)),
            relative_path: relative
                .split('/')
                .filter(|part| *part != ".")
                .map(|part| urlencoding::encode(part).into_owned())
                .collect::<Vec<_>>()
                .join("/"),
        });
    }
    Err("conflict: Too many image name collisions".into())
}
