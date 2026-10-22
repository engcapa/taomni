use super::*;

pub(super) const MAX_DIFF_BYTES: usize = 2_000_000;
pub(super) const MAX_DIFF_BYTES_U64: u64 = MAX_DIFF_BYTES as u64;

#[derive(Debug, Clone)]
pub(super) struct BlobSide {
    pub(super) exists: bool,
    pub(super) bytes: Option<Vec<u8>>,
    pub(super) size: u64,
}

impl BlobSide {
    pub(super) fn absent() -> Self {
        Self {
            exists: false,
            bytes: None,
            size: 0,
        }
    }

    pub(super) fn from_bytes(bytes: Vec<u8>) -> Self {
        Self {
            size: bytes.len() as u64,
            exists: true,
            bytes: Some(bytes),
        }
    }

    pub(super) fn oversized(size: u64) -> Self {
        Self {
            exists: true,
            bytes: None,
            size,
        }
    }
}

pub(super) fn read_blob(root: &Path, reference: &str, path: &str) -> Result<BlobSide, String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Ok(BlobSide::absent());
    }
    if reference == ":WORKTREE" {
        let full = root.join(path);
        let size = match fs::metadata(&full) {
            Ok(metadata) => metadata.len(),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BlobSide::absent());
            }
            Err(e) => return Err(format!("failed to stat {path}: {e}")),
        };
        if size > MAX_DIFF_BYTES_U64 {
            return Ok(BlobSide::oversized(size));
        }
        return match fs::read(&full) {
            Ok(bytes) => Ok(BlobSide::from_bytes(bytes)),
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BlobSide::absent()),
            Err(e) => Err(format!("failed to read {path}: {e}")),
        };
    }
    let spec = if reference == ":INDEX" {
        format!(":{path}")
    } else {
        format!("{reference}:{path}")
    };
    let size = match git_blob_size(root, &spec)? {
        Some(size) => size,
        None => return Ok(BlobSide::absent()),
    };
    if size > MAX_DIFF_BYTES_U64 {
        return Ok(BlobSide::oversized(size));
    }
    let output = new_git_command()
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .args(["show", spec.as_str()])
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    // A path that does not exist at the requested ref is "absent" rather than an
    // error: that is the added/deleted side of a diff.
    if output.status.success() {
        Ok(BlobSide::from_bytes(output.stdout))
    } else {
        Ok(BlobSide::absent())
    }
}

pub(super) fn git_blob_size(root: &Path, spec: &str) -> Result<Option<u64>, String> {
    let output = new_git_command()
        .current_dir(root)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .args(["cat-file", "-s", spec])
        .output()
        .map_err(|e| format!("failed to start git: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    raw.trim()
        .parse::<u64>()
        .map(Some)
        .map_err(|e| format!("failed to parse blob size for {spec}: {e}"))
}

pub(super) fn build_blob_pair(
    path: String,
    old_path: Option<String>,
    old_blob: BlobSide,
    new_blob: BlobSide,
) -> GitBlobPair {
    let old_exists = old_blob.exists;
    let new_exists = new_blob.exists;
    let old_size = old_blob.size;
    let new_size = new_blob.size;
    let old_bytes = old_blob.bytes;
    let new_bytes = new_blob.bytes;
    let image = is_image_path(&path);
    let oversize = old_size > MAX_DIFF_BYTES_U64 || new_size > MAX_DIFF_BYTES_U64;

    if image && !oversize {
        return GitBlobPair {
            path,
            old_path,
            old_text: None,
            new_text: None,
            old_exists,
            new_exists,
            binary: true,
            image: true,
            old_image_b64: old_bytes.as_deref().map(|b| B64.encode(b)),
            new_image_b64: new_bytes.as_deref().map(|b| B64.encode(b)),
            oversize: false,
            old_size,
            new_size,
        };
    }

    let binary = is_binary(old_bytes.as_deref()) || is_binary(new_bytes.as_deref());
    let (old_text, new_text) = if binary || oversize {
        (None, None)
    } else {
        (
            old_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
            new_bytes.map(|b| String::from_utf8_lossy(&b).into_owned()),
        )
    };
    GitBlobPair {
        path,
        old_path,
        old_text,
        new_text,
        old_exists,
        new_exists,
        binary,
        image: false,
        old_image_b64: None,
        new_image_b64: None,
        oversize,
        old_size,
        new_size,
    }
}

pub(super) fn is_binary(bytes: Option<&[u8]>) -> bool {
    match bytes {
        Some(b) => b.iter().take(8000).any(|&c| c == 0),
        None => false,
    }
}

pub(super) fn is_image_path(path: &str) -> bool {
    let ext = path.rsplit('.').next().map(|e| e.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "tiff" | "avif")
    )
}
