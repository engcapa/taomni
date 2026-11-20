//! Bounded image requests shared by Markdown preview and export.
use super::{BytesData, network};
use crate::proxy::ResolvedProxy;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tokio::sync::{Semaphore, SemaphorePermit};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_BYTES: u64 = 20 * 1024 * 1024;
const CANCELLED: &str = "Markdown image request cancelled";
type Requests = HashMap<(String, Uuid), CancellationToken>;
static REQUESTS: LazyLock<Mutex<Requests>> = LazyLock::new(Mutex::default);
static PERMITS: Semaphore = Semaphore::const_new(4);

pub(crate) struct ImageRequest {
    key: (String, Uuid),
    cancel: CancellationToken,
}

impl ImageRequest {
    pub(crate) fn new(owner: String) -> Result<Self, String> {
        let mut requests = REQUESTS
            .lock()
            .map_err(|_| "Image requests are unavailable")?;
        if requests.len() >= 256 {
            return Err(
                "Too many Markdown image requests. Try again when other images finish.".into(),
            );
        }
        let key = (owner, Uuid::new_v4());
        let cancel = CancellationToken::new();
        requests.insert(key.clone(), cancel.clone());
        Ok(Self { key, cancel })
    }

    pub(crate) fn id(&self) -> String {
        self.key.1.to_string()
    }

    pub(crate) async fn acquire(&self) -> Result<SemaphorePermit<'static>, String> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(CANCELLED.into()),
            permit = PERMITS.acquire() => permit.map_err(|_| CANCELLED.into()),
        }
    }

    pub(crate) async fn read(
        &self,
        reference: &str,
        proxy: Option<&ResolvedProxy>,
    ) -> Result<BytesData, String> {
        tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(CANCELLED.into()),
            result = fetch(reference, proxy) => result,
        }
    }
}

impl Drop for ImageRequest {
    fn drop(&mut self) {
        if let Ok(mut requests) = REQUESTS.lock() {
            requests.remove(&self.key);
        }
    }
}

pub(crate) fn cancel(owner: &str, id: &str) {
    if let Ok(id) = Uuid::parse_str(id)
        && let Ok(requests) = REQUESTS.lock()
        && let Some(cancel) = requests.get(&(owner.to_string(), id))
    {
        cancel.cancel();
    }
}

fn image_mime(response: &reqwest::Response) -> Result<String, String> {
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match mime.as_str() {
        "image/png"
        | "image/jpeg"
        | "image/gif"
        | "image/webp"
        | "image/bmp"
        | "image/svg+xml"
        | "image/avif"
        | "image/x-icon"
        | "image/vnd.microsoft.icon" => Ok(mime),
        _ => Err("The remote address did not return a supported image".into()),
    }
}

async fn fetch(reference: &str, proxy: Option<&ResolvedProxy>) -> Result<BytesData, String> {
    let url = network::validate_url(reference)?;
    let client = network::resource_client(
        proxy,
        reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 {
                attempt.error("Too many redirects")
            } else if network::validate_url(attempt.url().as_str()).is_err() {
                attempt.error("Unsupported image redirect")
            } else {
                attempt.follow()
            }
        }),
    )?;
    let response = client.get(url).send().await.map_err(|_| {
        "Could not load the remote image. Check the image address and selected proxy.".to_string()
    })?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "The remote image returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let mime = image_mime(&response)?;
    let size_error = "The remote image exceeds the 20 MiB limit";
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES)
    {
        return Err(size_error.into());
    }
    let mut chunks = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let chunk =
            chunk.map_err(|_| "The remote image connection ended before the image was received")?;
        if (bytes.len() + chunk.len()) as u64 > MAX_BYTES {
            return Err(size_error.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let size = bytes.len() as u64;
    Ok(BytesData { bytes, mime, size })
}
