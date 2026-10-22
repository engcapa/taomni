use super::policy::unicode_payload_within_limit;
use crate::servers::rdp::clipboard_formats::ClipboardLevel;
use crate::servers::rdp::clipboard_formats::MAX_HTML_BYTES;
use crate::servers::rdp::clipboard_formats::RgbaImage;
use ironrdp::core::IntoOwned as _;
use std::hash::Hash;
use std::hash::Hasher;
use std::path::PathBuf;
use std::sync::Arc;

/// One clipboard state in transferable form.
#[derive(Clone, Default)]
pub(super) struct HostContent {
    pub(super) text: Option<String>,
    pub(super) html: Option<Arc<String>>,
    pub(super) image: Option<Arc<RgbaImage>>,
    pub(super) files: Vec<PathBuf>,
}

impl HostContent {
    pub(super) fn is_empty(&self) -> bool {
        self.text.is_none() && self.html.is_none() && self.image.is_none() && self.files.is_empty()
    }

    /// What a user would call "the same clipboard": file names and sizes, image
    /// RGB pixels, or text with normalised line endings. Paths and alpha are
    /// deliberately excluded — a same-machine client stages files elsewhere and
    /// CF_DIB drops alpha — so its echo compares equal (DEC-15).
    pub(super) fn identity(&self) -> u64 {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        if !self.files.is_empty() {
            1u8.hash(&mut hasher);
            let mut entries: Vec<(String, Option<u64>)> = self
                .files
                .iter()
                .map(|path| {
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let size = std::fs::metadata(path)
                        .ok()
                        .filter(|meta| meta.is_file())
                        .map(|meta| meta.len());
                    (name, size)
                })
                .collect();
            entries.sort();
            entries.hash(&mut hasher);
        } else if let Some(image) = &self.image {
            2u8.hash(&mut hasher);
            (image.width, image.height).hash(&mut hasher);
            let mut rgb = Vec::with_capacity(image.width as usize * 3);
            for row in image.pixels.chunks_exact(image.width as usize * 4) {
                rgb.clear();
                row.chunks_exact(4)
                    .for_each(|px| rgb.extend_from_slice(&px[..3]));
                hasher.write(&rgb);
            }
        } else if let Some(text) = &self.text {
            3u8.hash(&mut hasher);
            text.replace("\r\n", "\n").hash(&mut hasher);
        } else if let Some(html) = &self.html {
            4u8.hash(&mut hasher);
            html.hash(&mut hasher);
        }
        hasher.finish()
    }

    /// Format summary for the server log; never includes clipboard content.
    pub(super) fn describe(&self) -> String {
        if !self.files.is_empty() {
            return format!("{} file item(s)", self.files.len());
        }
        let mut parts = Vec::new();
        if let Some(text) = &self.text {
            parts.push(format!("text ({} chars)", text.chars().count()));
        }
        if self.html.is_some() {
            parts.push("html".to_string());
        }
        if let Some(image) = &self.image {
            parts.push(format!("image {}x{}", image.width, image.height));
        }
        if parts.is_empty() {
            "empty clipboard".to_string()
        } else {
            parts.join(", ")
        }
    }
}

/// Another process holds the OS clipboard; retry on the next tick.
pub(super) struct HostBusy;

/// `text/uri-list` lines end in CRLF (RFC 2483; GTK file managers write it
/// that way) but arboard splits the list on LF only, which leaves a `\r` on
/// every Linux path.
pub(super) fn without_uri_list_cr(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|value| value.strip_suffix('\r')) {
        Some(trimmed) => PathBuf::from(trimmed),
        None => path,
    }
}

/// `Ok(None)` when a format is simply absent.
pub(super) fn available<T>(result: Result<T, arboard::Error>) -> Result<Option<T>, HostBusy> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(arboard::Error::ClipboardOccupied) => Err(HostBusy),
        Err(_) => Ok(None),
    }
}

/// Read the formats `level` allows. Files win over everything else, like a
/// shell copy; otherwise text, HTML and an image may coexist.
pub(super) fn read_host(
    clipboard: &mut arboard::Clipboard,
    level: ClipboardLevel,
) -> Result<HostContent, HostBusy> {
    let mut content = HostContent::default();
    if !level.allows_text() {
        return Ok(content);
    }
    if level.allows_files()
        && let Some(files) = available(clipboard.get().file_list())?
        && !files.is_empty()
    {
        content.files = files.into_iter().map(without_uri_list_cr).collect();
        return Ok(content);
    }
    content.text = available(clipboard.get_text())?
        .filter(|text| !text.is_empty() && unicode_payload_within_limit(text));
    if level.allows_rich() {
        content.html = available(clipboard.get().html())?
            .filter(|html| !html.is_empty() && html.len() <= MAX_HTML_BYTES)
            .map(Arc::new);
        content.image = available(clipboard.get_image())?
            .and_then(|image| {
                let width = u32::try_from(image.width).ok()?;
                let height = u32::try_from(image.height).ok()?;
                RgbaImage::new(width, height, image.bytes.into_owned()).ok()
            })
            .map(Arc::new);
    }
    Ok(content)
}

/// Publish client content on the host. arboard sets one representation per
/// write (HTML carries its plain-text alternative), so pick the richest one
/// the content stands for: files, a picture without text, HTML, then text.
pub(super) fn write_host(
    clipboard: &mut arboard::Clipboard,
    content: &HostContent,
) -> Result<(), arboard::Error> {
    if !content.files.is_empty() {
        return clipboard.set().file_list(&content.files);
    }
    let text = content.text.as_deref().filter(|text| !text.is_empty());
    if let Some(image) = content.image.as_ref().filter(|_| text.is_none()) {
        return clipboard.set_image(arboard::ImageData {
            width: image.width as usize,
            height: image.height as usize,
            bytes: std::borrow::Cow::Borrowed(&image.pixels),
        });
    }
    match (&content.html, text) {
        (Some(html), alt) => clipboard.set_html(html.as_str(), alt),
        (None, Some(text)) => clipboard.set_text(text),
        (None, None) => Ok(()),
    }
}
