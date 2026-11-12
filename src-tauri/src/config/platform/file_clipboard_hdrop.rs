//! CF_HDROP's DROPFILES + UTF-16 path list, testable without Win32 clipboard IO.

use super::validate_paths;

pub(crate) const HEADER_BYTES: usize = 20;

pub(crate) fn encode(paths: &[String]) -> Result<Vec<u8>, String> {
    validate_paths(paths)?;
    let mut bytes = vec![0; HEADER_BYTES];
    bytes[..4].copy_from_slice(&(HEADER_BYTES as u32).to_le_bytes());
    bytes[16..20].copy_from_slice(&1u32.to_le_bytes()); // fWide = TRUE
    for path in paths {
        for unit in path.encode_utf16().chain(std::iter::once(0)) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&0u16.to_le_bytes());
    Ok(bytes)
}
