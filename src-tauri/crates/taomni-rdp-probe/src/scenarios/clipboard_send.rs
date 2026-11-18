use super::dispatch::usage;
use super::readiness::open;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use crate::clipboard;
use crate::clipboard::Advert;
use crate::clipboard::ClipAction;
use crate::clipboard::LocalContent;
use crate::clipboard::LocalFile;
use crate::clipboard::ProbeClipboard;
use crate::session::ChannelPlan;
use crate::session::ProbeSession;
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

pub(super) fn collect_files(paths: &str) -> Result<Vec<LocalFile>, String> {
    let mut files = Vec::new();
    for raw in paths.split(',').filter(|p| !p.trim().is_empty()) {
        let root = PathBuf::from(raw.trim());
        let base = root
            .file_name()
            .ok_or_else(|| format!("bad file path {raw:?}"))?
            .to_string_lossy()
            .into_owned();
        walk(&root, &base, &mut files)?;
    }
    if files.is_empty() {
        return Err("--files did not name any file".to_string());
    }
    Ok(files)
}

pub(super) fn walk(path: &Path, name: &str, out: &mut Vec<LocalFile>) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.is_dir() {
        out.push(LocalFile {
            name: name.to_string(),
            path: None,
            is_dir: true,
            size: 0,
        });
        let mut entries: Vec<_> = std::fs::read_dir(path)
            .map_err(|e| format!("{}: {e}", path.display()))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child = format!("{name}\\{}", entry.file_name().to_string_lossy());
            walk(&entry.path(), &child, out)?;
        }
    } else {
        out.push(LocalFile {
            name: name.to_string(),
            path: Some(path.to_path_buf()),
            is_dir: false,
            size: meta.len(),
        });
    }
    Ok(())
}

pub(super) async fn drain_clipboard(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
) -> Result<(), ProbeError> {
    let actions: Vec<ClipAction> = clip.with(|s| s.actions.drain(..).collect());
    for action in actions {
        let messages = {
            let Some(cliprdr) = session
                .active_stage
                .get_svc_processor_mut::<CliprdrClient>()
            else {
                return Err(ProbeError::unmet("CLIPRDR channel was not negotiated"));
            };
            match action {
                ClipAction::Advertise(Advert::Formats(formats)) => cliprdr.initiate_copy(&formats),
                ClipAction::Advertise(Advert::Files(files)) => cliprdr.initiate_file_copy(files),
                ClipAction::SubmitFormatData(response) => cliprdr.submit_format_data(response),
                ClipAction::SubmitFileContents(response) => cliprdr.submit_file_contents(response),
            }
            .map_err(|e| ProbeError::connection(format!("CLIPRDR encode: {e}")))?
        };
        session.send_svc_messages(messages).await?;
    }
    Ok(())
}

pub(super) async fn pump_clipboard(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    wait: Duration,
) -> Result<(), ProbeError> {
    session.pump(wait).await?;
    drain_clipboard(session, clip).await
}

pub(super) async fn clipboard_send(args: &Args) -> ScenarioResult {
    let mut local = LocalContent::default();
    local.text = args.opt("text");
    local.html = args.opt("html");
    if let Some(png) = args.opt("image-png") {
        let image = image::open(&png)
            .map_err(|e| usage(format!("--image-png {png}: {e}")))?
            .to_rgba8();
        local.dib = Some(clipboard::rgba_to_dib(
            image.width(),
            image.height(),
            image.as_raw(),
        ));
    }
    if let Some(files) = args.opt("files") {
        local.files = collect_files(&files).map_err(usage)?;
    }
    // ironrdp-cliprdr answers the file-list request itself; file transfers
    // are judged by the file contents the server pulls.
    let expected: Vec<u32> = if !local.files.is_empty() {
        Vec::new()
    } else if local.dib.is_some() {
        vec![8]
    } else if local.html.is_some() {
        vec![clipboard::HTML_FORMAT_ID]
    } else if local.text.is_some() {
        vec![13]
    } else {
        return Err(usage(
            "clipboard-send needs --text, --html, --image-png or --files".into(),
        ));
    };
    let total_file_bytes: u64 = local.files.iter().map(|f| f.size).sum();
    let wait = Duration::from_secs(args.u64("wait-sec", 20).map_err(usage)?);
    let clip = ProbeClipboard::new(local.clone());
    let mut session = open(
        args,
        ChannelPlan {
            clipboard: Some(clip.clone()),
            ..ChannelPlan::default()
        },
    )
    .await?;
    let deadline = Instant::now() + wait;
    let mut advertised = false;
    let mut last_activity = Instant::now();
    let mut last_requests = 0u64;
    loop {
        if let Err(error) = pump_clipboard(&mut session, &clip, Duration::from_millis(50)).await {
            return Err((error, clipboard_report(&mut session, &clip)));
        }
        if !advertised && clip.with(|s| s.ready) {
            // Only when Monitor Ready did not already announce it: a second
            // format list would be a second copy.
            clip.with(|s| {
                if !s.announced {
                    s.actions.push_back(ClipAction::Advertise(local.advert()));
                    s.announced = true;
                }
            });
            advertised = true;
        }
        let (requested, file_requests, served) = clip.with(|s| {
            (
                s.requested_formats.clone(),
                s.file_requests,
                s.file_bytes_served,
            )
        });
        if file_requests != last_requests {
            last_requests = file_requests;
            last_activity = Instant::now();
        }
        let got_format = expected.iter().all(|id| requested.contains(id));
        let done = if local.files.is_empty() {
            got_format
        } else {
            file_requests > 0
                && served >= total_file_bytes
                && last_activity.elapsed() > Duration::from_millis(800)
        };
        if done || Instant::now() >= deadline {
            let mut report = clipboard_report(&mut session, &clip);
            report["expected_formats"] = json!(expected);
            report["total_file_bytes"] = json!(total_file_bytes);
            if !done {
                return Err((
                    ProbeError::unmet("server did not fetch the advertised clipboard data in time"),
                    report,
                ));
            }
            // Give the server a moment to apply the data to the host clipboard.
            let _ = session
                .pump_until(Instant::now() + Duration::from_millis(800))
                .await;
            return Ok(report);
        }
    }
}

pub(super) fn clipboard_report(session: &mut ProbeSession, clip: &ProbeClipboard) -> Value {
    let mut report = session.summary();
    clip.with(|s| {
        report["clipboard"] = json!({
            "ready": s.ready,
            "negotiated_flags": s.negotiated,
            "remote_copies": s.remote_copies.iter().map(|formats| formats.iter().map(|f| json!({
                "id": f.id().value(),
                "name": f.name().map(|n| n.value().to_string()),
            })).collect::<Vec<_>>()).collect::<Vec<_>>(),
            "requested_formats": s.requested_formats,
            "file_requests": s.file_requests,
            "file_bytes_served": s.file_bytes_served,
            "format_list_acks": s.format_list_acks,
            "locks": s.locks,
            "log": s.log,
        });
    });
    report
}

pub(super) fn find_format(clip: &ProbeClipboard, kind: &str) -> Option<u32> {
    clip.with(|s| {
        let formats = s.remote_copies.last()?;
        formats.iter().find_map(|f| {
            let id = f.id().value();
            let name = f.name().map(|n| n.value().to_string()).unwrap_or_default();
            let hit = match kind {
                "text" => id == 13,
                "html" => name == clipboard::HTML_FORMAT_NAME,
                "image" => id == 8 || id == 17,
                "files" => name == clipboard::FILE_LIST_FORMAT_NAME,
                _ => false,
            };
            hit.then_some(id)
        })
    })
}

pub(super) async fn paste(
    session: &mut ProbeSession,
    clip: &ProbeClipboard,
    format: u32,
    wait: Duration,
) -> Result<Vec<u8>, ProbeError> {
    clip.with(|s| s.pending_paste = Some(format));
    let messages = {
        let Some(cliprdr) = session
            .active_stage
            .get_svc_processor_mut::<CliprdrClient>()
        else {
            return Err(ProbeError::unmet("CLIPRDR channel was not negotiated"));
        };
        cliprdr
            .initiate_paste(ClipboardFormatId::new(format))
            .map_err(|e| ProbeError::connection(format!("CLIPRDR paste: {e}")))?
    };
    session.send_svc_messages(messages).await?;
    let deadline = Instant::now() + wait;
    loop {
        pump_clipboard(session, clip, Duration::from_millis(50)).await?;
        if let Some((_, result)) = clip.with(|s| {
            s.responses
                .iter()
                .rev()
                .find(|(id, _)| *id == format)
                .cloned()
        }) {
            return result.map_err(ProbeError::unmet);
        }
        if Instant::now() >= deadline {
            return Err(ProbeError::unmet(format!(
                "no data response for format {format}"
            )));
        }
    }
}
