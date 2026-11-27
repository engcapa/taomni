//! Local file viewer I/O. Policy is independent of any window/document lifetime.
pub(crate) mod archive;
mod assets;
mod chunks;
pub(crate) mod document_access;
pub(crate) mod document_copy;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
mod drawio_frame;
mod filesystem;
mod html;
mod html_document;
mod html_loopback;
pub(crate) mod markdown_images;
pub(crate) mod media_stream;
mod network;
mod network_rewrite;
mod paths;
mod temporary;
mod text;
pub(crate) mod tiff_preview;

pub(crate) use assets::save_pasted_image;
pub(crate) use chunks::read_text_chunk;
pub(crate) use filesystem::{read_bytes, stat};
pub(crate) use html::{HtmlSession, close_html, open_html, register_protocol};
pub(crate) use network::resolve_proxy as resolve_preview_proxy;
pub(crate) use paths::{display as display_path, io_error as path_io_error};
pub(crate) use temporary::{
    allocate_temp, create_temp, is_owned_temp, release_temp, release_temp_token, shutdown,
};
pub(crate) use text::{normalize_eol, read_text, write_text};

use serde::Serialize;

pub(crate) fn drawio_renderer_url() -> Option<String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    return Some(drawio_frame::url());

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    None
}

pub(crate) const DEFAULT_TEXT_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const HARD_TEXT_BYTES: u64 = 20 * 1024 * 1024;
pub(crate) const HARD_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileStat {
    pub path: String,
    pub size: u64,
    /// Unix epoch seconds, matching Workspace and Explorer metadata.
    pub mtime: u64,
    pub mime: String,
    pub is_file: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextData {
    pub path: String,
    pub content: String,
    /// Empty for a truncated prefix: it must never become a write precondition.
    pub hash: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub mtime: u64,
    pub size: u64,
    pub truncated: bool,
    /// Source byte offset (including BOM), safe for the next chunk request.
    pub next_offset: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BytesData {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteAck {
    pub hash: String,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TextChunk {
    pub content: String,
    pub next_offset: u64,
    pub eof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedImage {
    pub path: String,
    /// URL-encoded portable path relative to the document directory.
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct TempFile {
    pub path: String,
    pub token: String,
}

#[cfg(test)]
mod tests;
