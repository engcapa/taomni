use serde::Serialize;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

/* ------------------------------- manifest -------------------------------- */

/// Content-addressed description of a file: a per-piece SHA-256 list whose own
/// hash is the stable `file_id` (so the same bytes always map to the same id).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub piece_size: u32,
    /// Lowercase-hex SHA-256 of each piece, in order.
    pub pieces: Vec<String>,
}

impl Manifest {
    pub(super) fn piece_count(&self) -> usize {
        self.pieces.len()
    }
    /// Byte length of piece `i` (the last piece may be short).
    pub(super) fn piece_len(&self, i: usize) -> usize {
        let ps = self.piece_size as u64;
        let start = i as u64 * ps;
        if start >= self.size {
            0
        } else {
            (self.size - start).min(ps) as usize
        }
    }
    pub(super) fn to_json(&self) -> serde_json::Value {
        json!({
            "fileId": self.file_id, "name": self.name, "size": self.size,
            "pieceSize": self.piece_size, "pieces": self.pieces,
        })
    }
    pub(super) fn from_json(v: &serde_json::Value) -> Option<Self> {
        let pieces: Vec<String> = v
            .get("pieces")?
            .as_array()?
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
        Some(Self {
            file_id: v.get("fileId")?.as_str()?.to_string(),
            name: v.get("name")?.as_str()?.to_string(),
            size: v.get("size")?.as_u64()?,
            piece_size: v.get("pieceSize")?.as_u64()? as u32,
            pieces,
        })
    }
}

/// Read `path` and build its manifest (blocking — call via `spawn_blocking`).
pub(super) fn build_manifest(
    path: &std::path::Path,
    name: String,
    piece_size: usize,
) -> Result<Manifest, String> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut pieces = Vec::new();
    let mut id_hasher = Sha256::new();
    let mut buf = vec![0u8; piece_size];
    loop {
        let mut filled = 0;
        while filled < piece_size {
            let n = file
                .read(&mut buf[filled..])
                .map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            break;
        }
        let mut h = Sha256::new();
        h.update(&buf[..filled]);
        let hex = hex::encode(h.finalize());
        id_hasher.update(hex.as_bytes());
        pieces.push(hex);
        if filled < piece_size {
            break;
        }
    }
    // Empty file: one zero-length piece so there is always something to "have".
    if pieces.is_empty() {
        let mut h = Sha256::new();
        h.update(b"");
        let hex = hex::encode(h.finalize());
        id_hasher.update(hex.as_bytes());
        pieces.push(hex);
    }
    let file_id = hex::encode(id_hasher.finalize());
    Ok(Manifest {
        file_id,
        name,
        size,
        piece_size: piece_size as u32,
        pieces,
    })
}

/* -------------------------------- sending -------------------------------- */

pub(super) fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_string()
}
