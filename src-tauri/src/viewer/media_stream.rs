//! Byte-range access to exactly one already-opened regular file per player.
use super::{filesystem::open_regular, html_loopback};
use axum::body::{Body, Bytes};
use axum::http::{Request, Response, StatusCode, header};
use futures::stream;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, ErrorKind};
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;

struct Source {
    file: File,
    size: u64,
    mime: &'static str,
    closed: AtomicBool,
}
static SOURCES: LazyLock<Mutex<HashMap<Uuid, Arc<Source>>>> = LazyLock::new(Default::default);

#[derive(Serialize)]
pub(crate) struct MediaStream {
    token: String,
    url: String,
}

pub(crate) fn open(path: &str) -> Result<MediaStream, String> {
    let (path, file, metadata) = open_regular(path)?;
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "flv" => "video/x-flv",
        "wmv" => "video/x-ms-wmv",
        "rm" | "rmvb" => "application/vnd.rn-realmedia",
        "3gp" => "video/3gpp",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        _ => return Err("unsupported: No media stream for this file type".into()),
    };
    let token = Uuid::new_v4();
    let url = format!("{}/media/{token}", html_loopback::origin());
    let source = Source {
        file,
        size: metadata.len(),
        mime,
        closed: AtomicBool::new(false),
    };
    SOURCES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(token, Arc::new(source));
    Ok(MediaStream {
        token: token.to_string(),
        url,
    })
}

pub(crate) fn close(token: &str) {
    if let Ok(token) = Uuid::parse_str(token)
        && let Some(source) = SOURCES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&token)
    {
        source.closed.store(true, Ordering::Release);
    }
}

pub(super) fn clear() {
    for (_, source) in SOURCES.lock().unwrap_or_else(|e| e.into_inner()).drain() {
        source.closed.store(true, Ordering::Release);
    }
}

/// Returns a half-open interval for one HTTP bytes range.
fn interval(range: &str, size: u64) -> Option<(u64, u64)> {
    let (first, last) = range.strip_prefix("bytes=")?.split_once('-')?;
    if first.is_empty() {
        let suffix = last.parse::<u64>().ok()?;
        return (suffix > 0 && size > 0).then_some((size.saturating_sub(suffix), size));
    }
    let start = first.parse().ok()?;
    let end = if last.is_empty() {
        size
    } else {
        last.parse::<u64>().ok()?.saturating_add(1).min(size)
    };
    (start < end).then_some((start, end))
}

fn read_at(source: &Source, offset: u64, end: u64) -> io::Result<Bytes> {
    if source.closed.load(Ordering::Acquire) {
        return Err(io::Error::new(
            ErrorKind::Interrupted,
            "Media stream closed",
        ));
    }
    let mut buf = vec![0; (end - offset).min(256 * 1024) as usize];
    #[cfg(unix)]
    let count = std::os::unix::fs::FileExt::read_at(&source.file, &mut buf, offset)?;
    #[cfg(windows)]
    let count = std::os::windows::fs::FileExt::seek_read(&source.file, &mut buf, offset)?;
    if count == 0 {
        return Err(io::Error::new(
            ErrorKind::UnexpectedEof,
            "Media file changed",
        ));
    }
    buf.truncate(count);
    Ok(Bytes::from(buf))
}

pub(super) fn serve(request: &Request<Body>, token: &str) -> Response<Body> {
    let source = Uuid::parse_str(token).ok().and_then(|id| {
        SOURCES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
    });
    let Some(source) = source else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    };
    let size = source.size;
    let mut response = Response::builder()
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, source.mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox");
    let (start, end) = if let Some(range) = request.headers().get(header::RANGE) {
        let Some((start, end)) = range.to_str().ok().and_then(|r| interval(r, size)) else {
            return response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .unwrap();
        };
        response = response.status(StatusCode::PARTIAL_CONTENT).header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", end - 1),
        );
        (start, end)
    } else {
        (0, size)
    };
    let response = response.header(header::CONTENT_LENGTH, end - start);
    if request.method() == axum::http::Method::HEAD {
        return response.body(Body::empty()).unwrap();
    }
    let chunks = stream::try_unfold((source, start), move |(source, offset)| async move {
        if offset >= end {
            return Ok::<_, io::Error>(None);
        }
        tokio::task::spawn_blocking(move || {
            let bytes = read_at(&source, offset, end)?;
            let next = offset + bytes.len() as u64;
            Ok(Some((bytes, (source, next))))
        })
        .await
        .map_err(io::Error::other)?
    });
    response.body(Body::from_stream(chunks)).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_are_bounded_and_seekable() {
        assert_eq!(interval("bytes=10-19", 50), Some((10, 20)));
        assert_eq!(interval("bytes=10-", 50), Some((10, 50)));
        assert_eq!(interval("bytes=-10", 50), Some((40, 50)));
        assert_eq!(interval("bytes=0-999", 50), Some((0, 50)));
        for value in ["bytes=50-", "bytes=3-1", "bytes=-0", "bytes=1-2,4-5"] {
            assert_eq!(interval(value, 50), None);
        }
    }

    #[tokio::test]
    async fn concurrent_ranges_use_the_opened_file_and_closing_revokes_its_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.wav");
        std::fs::write(&path, b"0123456789").unwrap();
        let media = open(path.to_str().unwrap()).unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let fetch = |range| client.get(&media.url).header("range", range).send();
        let (first, last) = tokio::join!(fetch("bytes=0-2"), fetch("bytes=-2"));
        let first = first.unwrap();
        assert_eq!(first.status().as_u16(), 206);
        assert_eq!(first.headers()["content-range"], "bytes 0-2/10");
        assert_eq!(&first.bytes().await.unwrap()[..], b"012");
        assert_eq!(&last.unwrap().bytes().await.unwrap()[..], b"89");
        assert_eq!(fetch("bytes=10-").await.unwrap().status().as_u16(), 416);
        close(&media.token);
        assert_eq!(fetch("bytes=0-").await.unwrap().status().as_u16(), 404);
    }
}
