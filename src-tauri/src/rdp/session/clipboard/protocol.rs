use crate::rdp::session::CLIPRDR_FILE_LIST_FORMAT_VALUE;
use crate::rdp::session::ClipboardAction;
use crate::rdp::session::ClipboardBridge;
use crate::rdp::session::SessionOutputSender;
use crate::rdp::session::clipboard;
use crate::rdp::session::events::send_status;
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::cliprdr::pdu::ClipboardFormat;
use ironrdp::cliprdr::pdu::ClipboardFormatId;
use ironrdp::cliprdr::pdu::ClipboardFormatName;
use ironrdp::cliprdr::pdu::ClipboardPdu;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::session::ActiveStage;
use ironrdp::svc::ChannelFlags;
use ironrdp::svc::SvcMessage;
use ironrdp::svc::SvcProcessorMessages;
use ironrdp_tokio::Framed;
use ironrdp_tokio::FramedWrite;
use std::io::Write;

pub(in crate::rdp::session) async fn drain_clipboard_actions<S>(
    active_stage: &mut ActiveStage,
    clipboard: &ClipboardBridge,
    framed: &mut Framed<S>,
    out_tx: &SessionOutputSender,
) -> Result<(), String>
where
    S: FramedWrite,
{
    for action in clipboard.drain_actions() {
        match action {
            ClipboardAction::AdvertiseFormats(formats) => {
                advertise_clipboard_formats(
                    active_stage,
                    formats,
                    framed,
                    out_tx,
                    "clipboard-initial-formats",
                )
                .await?;
            }
            ClipboardAction::RequestRemoteData(format) => {
                let messages = {
                    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>()
                    else {
                        send_status(
                            out_tx,
                            "clipboard-unavailable",
                            "CLIPRDR channel was not negotiated.",
                        );
                        continue;
                    };
                    cliprdr
                        .initiate_paste(format)
                        .map_err(|e| format!("rdp clipboard request remote data: {}", e))?
                };
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
            ClipboardAction::RequestRemoteFileContents(requests) => {
                if active_stage.get_svc_processor::<CliprdrClient>().is_none() {
                    send_status(
                        out_tx,
                        "clipboard-unavailable",
                        "CLIPRDR channel was not negotiated.",
                    );
                    continue;
                }
                let messages = SvcProcessorMessages::<CliprdrClient>::new(
                    requests
                        .into_iter()
                        .map(file_contents_request_message)
                        .collect(),
                );
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
            ClipboardAction::SubmitFormatData(response) => {
                let messages = {
                    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>()
                    else {
                        send_status(
                            out_tx,
                            "clipboard-unavailable",
                            "CLIPRDR channel was not negotiated.",
                        );
                        continue;
                    };
                    cliprdr
                        .submit_format_data(response)
                        .map_err(|e| format!("rdp clipboard submit data: {}", e))?
                };
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
            ClipboardAction::SubmitFileContents(response) => {
                let messages = {
                    let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>()
                    else {
                        send_status(
                            out_tx,
                            "clipboard-unavailable",
                            "CLIPRDR channel was not negotiated.",
                        );
                        continue;
                    };
                    cliprdr
                        .submit_file_contents(response)
                        .map_err(|e| format!("rdp clipboard submit file contents: {}", e))?
                };
                write_cliprdr_messages(active_stage, messages, framed).await?;
            }
        }
    }
    Ok(())
}

pub(in crate::rdp::session) async fn advertise_clipboard_formats<S>(
    active_stage: &mut ActiveStage,
    formats: Vec<ClipboardFormat>,
    framed: &mut Framed<S>,
    out_tx: &SessionOutputSender,
    stage: &str,
) -> Result<(), String>
where
    S: FramedWrite,
{
    let messages = {
        let Some(cliprdr) = active_stage.get_svc_processor_mut::<CliprdrClient>() else {
            send_status(
                out_tx,
                "clipboard-unavailable",
                "CLIPRDR channel was not negotiated.",
            );
            return Ok(());
        };
        cliprdr
            .initiate_copy(&formats)
            .map_err(|e| format!("rdp clipboard advertise formats: {}", e))?
    };
    write_cliprdr_messages(active_stage, messages, framed).await?;
    send_status(
        out_tx,
        stage,
        "Local clipboard formats were advertised to the RDP server.",
    );
    Ok(())
}

pub(in crate::rdp::session) async fn write_cliprdr_messages<S>(
    active_stage: &mut ActiveStage,
    messages: ironrdp::cliprdr::CliprdrSvcMessages<ironrdp::cliprdr::Client>,
    framed: &mut Framed<S>,
) -> Result<(), String>
where
    S: FramedWrite,
{
    let frame = active_stage
        .process_svc_processor_messages(messages)
        .map_err(|e| format!("rdp clipboard encode: {}", e))?;
    if !frame.is_empty() {
        framed
            .write_all(&frame)
            .await
            .map_err(|e| format!("rdp clipboard write: {}", e))?;
    }
    Ok(())
}

pub(in crate::rdp::session) fn file_list_clipboard_format_id() -> ClipboardFormatId {
    ClipboardFormatId::new(CLIPRDR_FILE_LIST_FORMAT_VALUE)
}

pub(in crate::rdp::session) fn file_list_clipboard_format() -> ClipboardFormat {
    ClipboardFormat::new(file_list_clipboard_format_id()).with_name(ClipboardFormatName::FILE_LIST)
}

pub(in crate::rdp::session) fn file_contents_request_message(
    request: FileContentsRequest,
) -> SvcMessage {
    SvcMessage::from(ClipboardPdu::FileContentsRequest(request))
        .with_flags(ChannelFlags::SHOW_PROTOCOL)
}
