use super::clipboard_send::clipboard_report;
use super::clipboard_send::find_format;
use super::clipboard_send::paste;
use super::clipboard_send::pump_clipboard;
use super::dispatch::usage;
use super::readiness::open;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use crate::clipboard;
use crate::clipboard::LocalContent;
use crate::clipboard::ProbeClipboard;
use crate::session::ChannelPlan;
use crate::session::ProbeSession;
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use ironrdp::cliprdr::pdu::FileContentsFlags;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::cliprdr::pdu::FormatDataResponse;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

/// Paste the server's FileGroupDescriptorW, then download every file with
/// SIZE + RANGE requests against the lock ironrdp took for the list.
pub(super) async fn receive_files(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    format: u32,
    wait: Duration,
    out_dir: Option<&Path>,
) -> ScenarioResult {
    clip.with(|s| s.remote_file_list = None);
    let messages = {
        let Some(cliprdr) = session
            .active_stage
            .get_svc_processor_mut::<CliprdrClient>()
        else {
            return Err((
                ProbeError::unmet("CLIPRDR channel was not negotiated"),
                clipboard_report(session, clip),
            ));
        };
        match cliprdr.initiate_paste(ClipboardFormatId::new(format)) {
            Ok(messages) => messages,
            Err(e) => {
                return Err((
                    ProbeError::connection(format!("CLIPRDR paste: {e}")),
                    clipboard_report(session, clip),
                ));
            }
        }
    };
    if let Err(error) = session.send_svc_messages(messages).await {
        return Err((error, clipboard_report(session, clip)));
    }
    let deadline = Instant::now() + wait;
    let (descriptors, data_id) = loop {
        if let Err(error) = pump_clipboard(session, clip, Duration::from_millis(50)).await {
            return Err((error, clipboard_report(session, clip)));
        }
        if let Some(list) = clip.with(|s| s.remote_file_list.clone()) {
            break list;
        }
        if Instant::now() >= deadline {
            return Err((
                ProbeError::unmet("server never answered the file list request"),
                clipboard_report(session, clip),
            ));
        }
    };
    let mut stream_id = 0u32;
    let mut files = Vec::new();
    for (index, descriptor) in descriptors.iter().enumerate() {
        let name = clipboard::wire_name(descriptor);
        let is_dir = descriptor
            .attributes
            .is_some_and(|a| a.contains(ironrdp::cliprdr::pdu::ClipboardFileAttributes::DIRECTORY));
        if is_dir {
            files.push(json!({ "name": name, "dir": true }));
            continue;
        }
        match fetch_file(session, clip, index as i32, data_id, &mut stream_id, wait).await {
            Ok(bytes) => {
                if let Some(dir) = out_dir {
                    let target = dir.join(name.replace('\\', "/"));
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&target, &bytes);
                }
                files.push(
                    json!({ "name": name, "size": bytes.len(), "sha256": sha256_hex(&bytes) }),
                );
            }
            Err(error) => {
                let mut report = clipboard_report(session, clip);
                report["files"] = json!(files);
                return Err((error, report));
            }
        }
    }
    let mut report = clipboard_report(session, clip);
    report["format"] = json!(format);
    report["lock_id"] = json!(data_id);
    report["received"] = json!({ "files": files });
    Ok(report)
}

pub(super) async fn fetch_file(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    index: i32,
    data_id: Option<u32>,
    stream_id: &mut u32,
    wait: Duration,
) -> Result<Vec<u8>, ProbeError> {
    async fn request(
        session: &mut ProbeSession,
        clip: &ProbeClipboard,
        request: FileContentsRequest,
        wait: Duration,
    ) -> Result<Vec<u8>, ProbeError> {
        let id = request.stream_id;
        let messages = {
            let Some(cliprdr) = session
                .active_stage
                .get_svc_processor_mut::<CliprdrClient>()
            else {
                return Err(ProbeError::unmet("CLIPRDR channel was not negotiated"));
            };
            cliprdr
                .request_file_contents(request)
                .map_err(|e| ProbeError::connection(format!("file contents request: {e}")))?
        };
        session.send_svc_messages(messages).await?;
        let deadline = Instant::now() + wait;
        loop {
            pump_clipboard(session, clip, Duration::from_millis(50)).await?;
            let found = clip.with(|s| {
                let position = s.file_responses.iter().position(|r| r.stream_id() == id)?;
                s.file_responses.remove(position)
            });
            if let Some(response) = found {
                if response.is_error() {
                    return Err(ProbeError::unmet(format!(
                        "server failed file contents stream {id}"
                    )));
                }
                return Ok(response.data().to_vec());
            }
            if Instant::now() >= deadline {
                return Err(ProbeError::unmet(format!(
                    "no file contents response for stream {id}"
                )));
            }
        }
    }

    *stream_id += 1;
    let size_bytes = request(
        session,
        clip,
        FileContentsRequest {
            stream_id: *stream_id,
            index,
            flags: FileContentsFlags::SIZE,
            position: 0,
            requested_size: 8,
            data_id,
        },
        wait,
    )
    .await?;
    let size = size_bytes
        .get(..8)
        .map(|b| u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
        .ok_or_else(|| ProbeError::unmet("short SIZE response"))?;
    let mut data = Vec::with_capacity(size as usize);
    while (data.len() as u64) < size {
        *stream_id += 1;
        let chunk = (size - data.len() as u64).min(1024 * 1024) as u32;
        let bytes = request(
            session,
            clip,
            FileContentsRequest {
                stream_id: *stream_id,
                index,
                flags: FileContentsFlags::RANGE,
                position: data.len() as u64,
                requested_size: chunk,
                data_id,
            },
            wait,
        )
        .await?;
        if bytes.is_empty() {
            return Err(ProbeError::unmet(
                "server returned an empty RANGE before EOF",
            ));
        }
        data.extend_from_slice(&bytes);
    }
    Ok(data)
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub(super) async fn clipboard_receive(args: &Args) -> ScenarioResult {
    let kind = args.str("expect", "text");
    let out_dir = args.opt("out-dir").map(PathBuf::from);
    let wait = Duration::from_secs(args.u64("wait-sec", 20).map_err(usage)?);
    let clip = ProbeClipboard::new(LocalContent::default());
    let mut session = open(
        args,
        ChannelPlan {
            clipboard: Some(clip.clone()),
            ..ChannelPlan::default()
        },
    )
    .await?;
    let deadline = Instant::now() + wait;
    let format = loop {
        if let Err(error) = pump_clipboard(&mut session, &clip, Duration::from_millis(50)).await {
            return Err((error, clipboard_report(&mut session, &clip)));
        }
        if let Some(id) = find_format(&clip, &kind) {
            break id;
        }
        if Instant::now() >= deadline {
            return Err((
                ProbeError::unmet(format!("server never announced a {kind} clipboard format")),
                clipboard_report(&mut session, &clip),
            ));
        }
    };
    if let Some(dir) = &out_dir {
        let _ = std::fs::create_dir_all(dir);
    }
    if kind == "files" {
        return receive_files(&mut session, &clip, format, wait, out_dir.as_deref()).await;
    }
    let data = match paste(&mut session, &clip, format, wait).await {
        Ok(data) => data,
        Err(error) => return Err((error, clipboard_report(&mut session, &clip))),
    };
    let mut report = clipboard_report(&mut session, &clip);
    report["format"] = json!(format);
    let result = match kind.as_str() {
        "text" => {
            let text = FormatDataResponse::new_data(data.clone())
                .to_unicode_string()
                .map_err(|e| ProbeError::unmet(format!("text decode: {e}")));
            text.map(|text| {
                let text = text.trim_end_matches('\0').to_string();
                if let Some(dir) = &out_dir {
                    let _ = std::fs::write(dir.join("text.txt"), text.as_bytes());
                }
                json!({ "text": text, "sha256": sha256_hex(text.as_bytes()) })
            })
        }
        "html" => clipboard::cf_html_fragment(&data)
            .ok_or_else(|| ProbeError::unmet("CF_HTML payload has no fragment offsets"))
            .map(|fragment| {
                if let Some(dir) = &out_dir {
                    let _ = std::fs::write(dir.join("fragment.html"), fragment.as_bytes());
                }
                json!({ "fragment": fragment })
            }),
        "image" => clipboard::dib_to_rgba(&data)
            .map_err(ProbeError::unmet)
            .map(|(w, h, rgba)| {
                if let Some(dir) = &out_dir {
                    if let Some(img) = image::RgbaImage::from_raw(w, h, rgba.clone()) {
                        let _ = img.save(dir.join("image.png"));
                    }
                }
                json!({ "width": w, "height": h, "rgba_sha256": sha256_hex(&rgba) })
            }),
        other => Err(ProbeError::usage(format!(
            "--expect must be text|html|image|files, got {other}"
        ))),
    };
    match result {
        Ok(value) => {
            report["received"] = value;
            Ok(report)
        }
        Err(error) => Err((error, report)),
    }
}
