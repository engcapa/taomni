use super::*;

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %self.0.display(),
                    %error,
                    "failed to clean RDP clipboard staging directory"
                );
            }
        }
    }
}

impl ClipboardBridge {
    pub(super) fn new(out_tx: SessionOutputSender) -> Self {
        cleanup_stale_clipboard_staging();
        Self {
            state: Arc::new(Mutex::new(ClipboardBridgeState {
                local_text: None,
                local_files: Vec::new(),
                pending_remote_format: None,
                remote_file_transfer: None,
                completed_remote_staging: Vec::new(),
                actions: VecDeque::new(),
                ready: false,
                negotiated_capabilities: ClipboardGeneralCapabilityFlags::empty(),
            })),
            out_tx,
        }
    }

    pub(super) fn backend(&self) -> TaomniCliprdrBackend {
        let temporary_directory = clipboard_process_staging_root()
            .to_string_lossy()
            .into_owned();
        TaomniCliprdrBackend {
            bridge: self.clone(),
            temporary_directory,
        }
    }

    pub(super) fn set_local_text(&self, text: String) {
        if let Ok(mut state) = self.state.lock() {
            state.local_text = Some(text);
            state.local_files.clear();
        }
    }

    pub(super) fn set_local_files(&self, files: Vec<LocalClipboardFile>) {
        if let Ok(mut state) = self.state.lock() {
            state.local_text = None;
            state.local_files = files;
        }
    }

    pub(super) fn local_formats(&self) -> Vec<ClipboardFormat> {
        match self.state.lock() {
            Ok(state)
                if state
                    .local_text
                    .as_ref()
                    .is_some_and(|text| !text.is_empty()) =>
            {
                vec![ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)]
            }
            Ok(state) if !state.local_files.is_empty() => vec![file_list_clipboard_format()],
            _ => Vec::new(),
        }
    }

    pub(super) fn drain_actions(&self) -> Vec<ClipboardAction> {
        match self.state.lock() {
            Ok(mut state) => state.actions.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }

    pub(super) fn queue_action(&self, action: ClipboardAction) {
        if let Ok(mut state) = self.state.lock() {
            state.actions.push_back(action);
        }
    }

    pub(super) fn local_text(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.local_text.clone())
    }

    pub(super) fn local_file_list_response(&self) -> OwnedFormatDataResponse {
        let files = match self.state.lock() {
            Ok(state) => state.local_files.clone(),
            Err(_) => Vec::new(),
        };
        if files.is_empty() {
            return FormatDataResponse::new_error().into_owned();
        }
        let list = PackedFileList {
            files: files
                .into_iter()
                .map(|file| {
                    let descriptor = IronClipboardFileDescriptor::new(file.name)
                        .with_attributes(file.attributes);
                    if file.is_directory {
                        descriptor
                    } else {
                        descriptor.with_file_size(file.size)
                    }
                })
                .collect(),
        };
        FormatDataResponse::new_file_list(&list)
            .map(IntoOwned::into_owned)
            .unwrap_or_else(|_| FormatDataResponse::new_error().into_owned())
    }

    pub(super) fn local_file_contents_response(
        &self,
        request: &FileContentsRequest,
    ) -> FileContentsResponse<'static> {
        let file = match self.state.lock() {
            Ok(state) => state.local_files.get(request.index as usize).cloned(),
            Err(_) => None,
        };
        let Some(file) = file else {
            return FileContentsResponse::new_error(request.stream_id);
        };
        if request.flags.contains(FileContentsFlags::SIZE) {
            return FileContentsResponse::new_size_response(request.stream_id, file.size);
        }
        if !request.flags.contains(FileContentsFlags::RANGE) || file.is_directory {
            return FileContentsResponse::new_error(request.stream_id);
        }
        if request.position > file.size {
            return FileContentsResponse::new_error(request.stream_id);
        }
        let remaining = file.size.saturating_sub(request.position);
        let requested_size = request
            .requested_size
            .min(remaining.min(u32::MAX as u64) as u32);
        read_clipboard_file_range(&file.path, request.position, requested_size)
            .map(|data| FileContentsResponse::new_data_response(request.stream_id, data))
            .unwrap_or_else(|_| FileContentsResponse::new_error(request.stream_id))
    }

    pub(super) fn start_remote_file_receive(&self, list: PackedFileList) {
        match build_remote_file_transfer(list) {
            Ok((transfer, requests)) => {
                if requests.is_empty() {
                    let completed_paths = transfer.top_level_paths.clone();
                    if completed_paths.is_empty() {
                        self.send_clipboard_status(
                            "clipboard-remote-files-empty",
                            "Remote clipboard did not contain any file paths.",
                        );
                    } else {
                        if let Ok(mut state) = self.state.lock() {
                            state.completed_remote_staging.clear();
                            state.completed_remote_staging.push(transfer.staging);
                        } else {
                            self.send_clipboard_status(
                                "clipboard-remote-files-error",
                                "Remote clipboard staging state is unavailable.",
                            );
                            return;
                        }
                        self.finish_remote_file_receive(completed_paths);
                    }
                    return;
                }
                if let Ok(mut state) = self.state.lock() {
                    state.completed_remote_staging.clear();
                    state
                        .actions
                        .push_back(ClipboardAction::RequestRemoteFileContents(requests));
                    state.remote_file_transfer = Some(transfer);
                }
            }
            Err(e) => self.send_clipboard_status(
                "clipboard-remote-files-error",
                &format!("Remote file clipboard could not be staged: {}", e),
            ),
        }
    }

    pub(super) fn handle_remote_file_contents_response(&self, response: FileContentsResponse<'_>) {
        let stream_id = response.stream_id();
        let data = response.data();
        let mut next_request = None;
        let mut completed_paths = None;
        let mut error = None;

        if let Ok(mut state) = self.state.lock() {
            let Some(transfer) = state.remote_file_transfer.as_mut() else {
                error = Some(format!("unexpected remote file stream {}", stream_id));
                drop(state);
                self.send_clipboard_status("clipboard-remote-files-error", &error.unwrap());
                return;
            };
            let Some(stream) = transfer.streams.remove(&stream_id) else {
                error = Some(format!("unknown remote file stream {}", stream_id));
                state.remote_file_transfer = None;
                drop(state);
                self.send_clipboard_status("clipboard-remote-files-error", &error.unwrap());
                return;
            };
            let Some(file) = transfer.files.get(stream.index).cloned() else {
                error = Some(format!("remote file index {} is unavailable", stream.index));
                state.remote_file_transfer = None;
                drop(state);
                self.send_clipboard_status("clipboard-remote-files-error", &error.unwrap());
                return;
            };

            let data_len = u64::try_from(data.len()).unwrap_or(u64::MAX);
            let remaining = file.size.saturating_sub(stream.position);
            if file.is_directory {
                error = Some(format!(
                    "remote directory index {} returned file data",
                    stream.index
                ));
            } else if data.is_empty() && stream.position < file.size {
                error = Some(format!(
                    "remote file '{}' ended before its declared size",
                    file.path.display()
                ));
            } else if data.len() > REMOTE_FILE_CHUNK_SIZE as usize || data_len > remaining {
                error = Some(format!(
                    "remote file '{}' exceeded its declared transfer bounds",
                    file.path.display()
                ));
            } else if transfer.received_bytes.saturating_add(data_len) > MAX_CLIPBOARD_TOTAL_BYTES {
                error = Some("remote file clipboard exceeded its total byte quota".to_string());
            }

            if error.is_none() && !data.is_empty() {
                if let Err(e) = write_remote_file_chunk(&file.path, stream.position, &data) {
                    error = Some(e);
                } else {
                    transfer.received_bytes = transfer.received_bytes.saturating_add(data_len);
                }
            }

            let new_position = stream.position.saturating_add(data.len() as u64);
            if error.is_none() && !file.is_directory && new_position < file.size && !data.is_empty()
            {
                let request = next_remote_file_request(transfer, stream.index, new_position);
                next_request = Some(request);
            }

            if error.is_some() {
                state.remote_file_transfer = None;
            } else if let Some(request) = next_request.clone() {
                state
                    .actions
                    .push_back(ClipboardAction::RequestRemoteFileContents(vec![request]));
            } else if transfer.streams.is_empty() {
                if let Some(transfer) = state.remote_file_transfer.take() {
                    completed_paths = Some(transfer.top_level_paths.clone());
                    state.completed_remote_staging.push(transfer.staging);
                }
            }
        }

        if let Some(e) = error {
            self.send_clipboard_status(
                "clipboard-remote-files-error",
                &format!("Remote file clipboard transfer failed: {}", e),
            );
            return;
        }
        if let Some(paths) = completed_paths {
            self.finish_remote_file_receive(paths);
        }
    }

    pub(super) fn finish_remote_file_receive(&self, paths: Vec<PathBuf>) {
        let text = crate::rdp::cliprdr::paths_to_uri_list(&paths);
        let string_paths: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        send_text(
            &self.out_tx,
            json!({
                "type": "clipboard_files",
                "paths": string_paths,
                "text": text,
            })
            .to_string(),
        );
        self.send_clipboard_status(
            "clipboard-remote-files-ready",
            "Remote clipboard files were staged locally.",
        );
    }

    pub(super) fn queue_remote_request(&self, format: ClipboardFormatId) {
        if let Ok(mut state) = self.state.lock() {
            state.pending_remote_format = Some(format);
            state
                .actions
                .push_back(ClipboardAction::RequestRemoteData(format));
        }
    }

    pub(super) fn take_pending_remote_format(&self) -> Option<ClipboardFormatId> {
        self.state
            .lock()
            .ok()
            .and_then(|mut state| state.pending_remote_format.take())
    }

    pub(super) fn send_clipboard_text(&self, text: String) {
        send_text(
            &self.out_tx,
            json!({
                "type": "clipboard",
                "text": text,
            })
            .to_string(),
        );
    }

    pub(super) fn send_clipboard_status(&self, stage: &str, detail: &str) {
        send_status(&self.out_tx, stage, detail);
    }
}

impl std::fmt::Debug for ClipboardBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClipboardBridge").finish_non_exhaustive()
    }
}

impl std::fmt::Debug for TaomniCliprdrBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaomniCliprdrBackend")
            .finish_non_exhaustive()
    }
}

impl AsAny for TaomniCliprdrBackend {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

impl CliprdrBackend for TaomniCliprdrBackend {
    fn temporary_directory(&self) -> &str {
        &self.temporary_directory
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::STREAM_FILECLIP_ENABLED
            | ClipboardGeneralCapabilityFlags::FILECLIP_NO_FILE_PATHS
    }

    fn on_ready(&mut self) {
        if let Ok(mut state) = self.bridge.state.lock() {
            state.ready = true;
        }
        self.bridge
            .send_clipboard_status("clipboard-ready", "RDP clipboard channel is ready.");
    }

    fn on_request_format_list(&mut self) {
        self.bridge.queue_action(ClipboardAction::AdvertiseFormats(
            self.bridge.local_formats(),
        ));
    }

    fn on_process_negotiated_capabilities(
        &mut self,
        capabilities: ClipboardGeneralCapabilityFlags,
    ) {
        if let Ok(mut state) = self.bridge.state.lock() {
            state.negotiated_capabilities = capabilities;
        }
    }

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        if let Some(format) = available_formats
            .iter()
            .map(ClipboardFormat::id)
            .find(|id| *id == ClipboardFormatId::CF_UNICODETEXT)
        {
            self.bridge.queue_remote_request(format);
            return;
        }

        if let Some(format) = available_formats
            .iter()
            .find(|format| {
                format
                    .name()
                    .is_some_and(|name| name.value().eq_ignore_ascii_case("FileGroupDescriptorW"))
            })
            .map(ClipboardFormat::id)
        {
            self.bridge.queue_remote_request(format);
            return;
        }

        self.bridge.send_clipboard_status(
            "clipboard-unsupported-format",
            "Remote clipboard changed, but no Unicode text or file-list format was advertised.",
        );
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let response = if request.format == ClipboardFormatId::CF_UNICODETEXT {
            self.bridge
                .local_text()
                .map(|text| FormatDataResponse::new_unicode_string(&text).into_owned())
                .unwrap_or_else(|| FormatDataResponse::new_error().into_owned())
        } else if request.format == file_list_clipboard_format_id() {
            self.bridge.local_file_list_response()
        } else {
            FormatDataResponse::new_error().into_owned()
        };
        self.bridge
            .queue_action(ClipboardAction::SubmitFormatData(response));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            self.bridge.send_clipboard_status(
                "clipboard-read-failed",
                "Remote clipboard data request failed.",
            );
            return;
        }
        match self.bridge.take_pending_remote_format() {
            Some(format) if format == ClipboardFormatId::CF_UNICODETEXT => {
                match response.to_unicode_string() {
                    Ok(text) => self.bridge.send_clipboard_text(text),
                    Err(e) => self.bridge.send_clipboard_status(
                        "clipboard-decode-failed",
                        &format!("Remote clipboard text could not be decoded: {}", e),
                    ),
                }
            }
            Some(_) => match response.to_file_list() {
                Ok(list) => self.bridge.start_remote_file_receive(list),
                Err(e) => self.bridge.send_clipboard_status(
                    "clipboard-decode-failed",
                    &format!("Remote clipboard file list could not be decoded: {}", e),
                ),
            },
            None => self.bridge.send_clipboard_status(
                "clipboard-decode-failed",
                "Remote clipboard response arrived without a tracked requested format.",
            ),
        }
    }

    fn on_file_contents_request(&mut self, request: FileContentsRequest) {
        let response = self.bridge.local_file_contents_response(&request);
        self.bridge
            .queue_action(ClipboardAction::SubmitFileContents(response));
    }

    fn on_file_contents_response(&mut self, response: FileContentsResponse<'_>) {
        self.bridge.handle_remote_file_contents_response(response);
    }

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

pub(super) async fn drain_clipboard_actions<S>(
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

pub(super) async fn advertise_clipboard_formats<S>(
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

pub(super) async fn write_cliprdr_messages<S>(
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

pub(super) fn file_list_clipboard_format_id() -> ClipboardFormatId {
    ClipboardFormatId::new(CLIPRDR_FILE_LIST_FORMAT_VALUE)
}

pub(super) fn file_list_clipboard_format() -> ClipboardFormat {
    ClipboardFormat::new(file_list_clipboard_format_id()).with_name(ClipboardFormatName::FILE_LIST)
}

pub(super) fn file_contents_request_message(request: FileContentsRequest) -> SvcMessage {
    SvcMessage::from(ClipboardPdu::FileContentsRequest(request))
        .with_flags(ChannelFlags::SHOW_PROTOCOL)
}

pub(super) fn clipboard_staging_base() -> PathBuf {
    #[cfg(unix)]
    let name = format!("taomni-rdp-cliprdr-{}", unsafe { libc::geteuid() });
    #[cfg(not(unix))]
    let name = "taomni-rdp-cliprdr".to_string();
    std::env::temp_dir().join(name)
}

pub(super) fn clipboard_process_staging_root() -> PathBuf {
    clipboard_staging_base().join(format!("process-{}", std::process::id()))
}

pub(super) fn cleanup_stale_clipboard_staging() {
    static CLEANUP: Once = Once::new();
    CLEANUP.call_once(|| {
        let base = clipboard_staging_base();
        if let Err(error) = ensure_private_directory(&base) {
            tracing::warn!(path = %base.display(), %error, "failed to create RDP clipboard staging root");
            return;
        }
        if let Err(error) = ensure_private_directory(&clipboard_process_staging_root()) {
            tracing::warn!(%error, "failed to create private RDP clipboard process directory");
            return;
        }
        let Ok(entries) = fs::read_dir(&base) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == clipboard_process_staging_root() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let stale = if let Some(pid) = name
                .strip_prefix("process-")
                .and_then(|value| value.parse::<u32>().ok())
            {
                !process_is_alive(pid)
            } else {
                entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age > std::time::Duration::from_secs(24 * 60 * 60))
            };
            if stale {
                let result = if path.is_dir() {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_file(&path)
                };
                if let Err(error) = result {
                    tracing::warn!(path = %path.display(), %error, "failed to remove stale RDP clipboard staging path");
                }
            }
        }
    });
}

pub(crate) fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("create private directory '{}': {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure directory '{}': {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn process_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub(crate) fn process_is_alive(_pid: u32) -> bool {
    // Avoid deleting another process's active transfer on platforms where this
    // module has no inexpensive process-existence probe.
    true
}

pub(super) fn build_remote_file_transfer(
    list: PackedFileList,
) -> Result<(RemoteFileTransfer, Vec<FileContentsRequest>), String> {
    if list.files.len() > MAX_CLIPBOARD_FILE_ITEMS {
        return Err(format!(
            "remote file clipboard contains more than {} items",
            MAX_CLIPBOARD_FILE_ITEMS
        ));
    }
    let process_root = clipboard_process_staging_root();
    ensure_private_directory(&process_root)?;
    let staging_dir = process_root.join(uuid::Uuid::new_v4().to_string());
    ensure_private_directory(&staging_dir)?;
    let staging = StagingDirectory(staging_dir.clone());

    let mut files = Vec::with_capacity(list.files.len());
    let mut top_level_names = HashSet::new();
    let mut top_level_paths = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut total_bytes = 0u64;
    for file in list.files {
        let is_directory = file
            .attributes
            .unwrap_or_else(ClipboardFileAttributes::empty)
            .contains(ClipboardFileAttributes::DIRECTORY);
        let path = remote_clipboard_safe_path(&staging_dir, &file.name)?;
        if !seen_paths.insert(path.clone()) {
            return Err(format!(
                "remote file clipboard contains duplicate path '{}'",
                file.name
            ));
        }
        let file_size = file.file_size.unwrap_or_default();
        if !is_directory && file_size > MAX_CLIPBOARD_FILE_BYTES {
            return Err(format!(
                "remote clipboard file '{}' exceeds the {} MiB per-file quota",
                file.name,
                MAX_CLIPBOARD_FILE_BYTES / (1024 * 1024)
            ));
        }
        total_bytes = total_bytes.saturating_add(file_size);
        if total_bytes > MAX_CLIPBOARD_TOTAL_BYTES {
            return Err(format!(
                "remote file clipboard exceeds the {} MiB total quota",
                MAX_CLIPBOARD_TOTAL_BYTES / (1024 * 1024)
            ));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create directory '{}': {}", parent.display(), e))?;
        }
        if is_directory {
            fs::create_dir_all(&path)
                .map_err(|e| format!("create directory '{}': {}", path.display(), e))?;
        } else {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            options
                .open(&path)
                .map_err(|e| format!("create '{}': {}", path.display(), e))?;
        }

        if let Some(name) = remote_top_level_name(&file.name) {
            if top_level_names.insert(name.clone()) {
                top_level_paths.push(staging_dir.join(name));
            }
        }

        files.push(RemoteClipboardFile {
            path,
            size: file_size,
            is_directory,
        });
    }

    let mut transfer = RemoteFileTransfer {
        staging,
        files,
        top_level_paths,
        streams: HashMap::new(),
        next_stream_id: 1,
        received_bytes: 0,
    };
    let mut requests = Vec::new();
    for index in 0..transfer.files.len() {
        let file = &transfer.files[index];
        if !file.is_directory && file.size > 0 {
            requests.push(next_remote_file_request(&mut transfer, index, 0));
        }
    }

    Ok((transfer, requests))
}

pub(super) fn next_remote_file_request(
    transfer: &mut RemoteFileTransfer,
    index: usize,
    position: u64,
) -> FileContentsRequest {
    let file = &transfer.files[index];
    let remaining = file.size.saturating_sub(position);
    let requested_size = remaining.min(u64::from(REMOTE_FILE_CHUNK_SIZE)) as u32;
    let stream_id = transfer.next_stream_id;
    transfer.next_stream_id = transfer.next_stream_id.wrapping_add(1).max(1);
    transfer
        .streams
        .insert(stream_id, RemoteFileStream { index, position });
    FileContentsRequest {
        stream_id,
        index: index as i32,
        flags: FileContentsFlags::RANGE,
        position,
        requested_size,
        data_id: None,
    }
}

pub(crate) fn remote_clipboard_safe_path(
    root: &Path,
    remote_name: &str,
) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    let mut saw_part = false;
    for part in remote_name.split(['\\', '/']) {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return Err(format!("remote clipboard path '{}' is unsafe", remote_name));
        }
        saw_part = true;
        path.push(part);
    }
    if !saw_part {
        return Err("remote clipboard file has an empty name".to_string());
    }
    Ok(path)
}

pub(crate) fn remote_top_level_name(remote_name: &str) -> Option<PathBuf> {
    remote_name
        .split(['\\', '/'])
        .find(|part| !part.trim().is_empty() && *part != "." && *part != "..")
        .map(PathBuf::from)
}

pub(crate) fn write_remote_file_chunk(
    path: &Path,
    position: u64,
    data: &[u8],
) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    file.write_all(data)
        .map_err(|e| format!("write '{}': {}", path.display(), e))
}

pub(super) fn collect_local_clipboard_files(
    paths: &[String],
) -> Result<Vec<LocalClipboardFile>, String> {
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for raw in paths {
        if raw.trim().is_empty() {
            continue;
        }
        let path = PathBuf::from(raw);
        let path = path
            .canonicalize()
            .map_err(|e| format!("canonicalize '{}': {}", raw, e))?;
        let root = path.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
        collect_clipboard_path(&root, &path, &mut files, &mut total_bytes)?;
        if files.len() > MAX_CLIPBOARD_FILE_ITEMS {
            return Err(format!(
                "file clipboard contains more than {} items",
                MAX_CLIPBOARD_FILE_ITEMS
            ));
        }
    }
    Ok(files)
}

pub(super) fn collect_clipboard_path(
    root: &Path,
    path: &Path,
    out: &mut Vec<LocalClipboardFile>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("metadata '{}': {}", path.display(), e))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "clipboard path '{}' is a symbolic link; links are not transferred",
            path.display()
        ));
    }
    let is_directory = metadata.is_dir();
    if !is_directory {
        if metadata.len() > MAX_CLIPBOARD_FILE_BYTES {
            return Err(format!(
                "clipboard file '{}' exceeds the {} MiB per-file quota",
                path.display(),
                MAX_CLIPBOARD_FILE_BYTES / (1024 * 1024)
            ));
        }
        *total_bytes = total_bytes.saturating_add(metadata.len());
        if *total_bytes > MAX_CLIPBOARD_TOTAL_BYTES {
            return Err(format!(
                "file clipboard exceeds the {} MiB total quota",
                MAX_CLIPBOARD_TOTAL_BYTES / (1024 * 1024)
            ));
        }
    }
    let name = clipboard_relative_name(root, path)?;
    out.push(LocalClipboardFile {
        path: path.to_path_buf(),
        name,
        size: if is_directory { 0 } else { metadata.len() },
        is_directory,
        attributes: if is_directory {
            ClipboardFileAttributes::DIRECTORY
        } else {
            ClipboardFileAttributes::NORMAL
        },
    });

    if is_directory {
        let mut entries = fs::read_dir(path)
            .map_err(|e| format!("read directory '{}': {}", path.display(), e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read directory '{}': {}", path.display(), e))?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            collect_clipboard_path(root, &entry.path(), out, total_bytes)?;
            if out.len() > MAX_CLIPBOARD_FILE_ITEMS {
                return Err(format!(
                    "file clipboard contains more than {} items",
                    MAX_CLIPBOARD_FILE_ITEMS
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn clipboard_relative_name(root: &Path, path: &Path) -> Result<String, String> {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let name = rel
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("\\");
    if name.is_empty() {
        return Err(format!(
            "clipboard path '{}' has no file name",
            path.display()
        ));
    }
    if name.encode_utf16().count() >= 260 {
        return Err(format!(
            "clipboard file name '{}' exceeds 259 UTF-16 code units",
            name
        ));
    }
    Ok(name)
}

pub(crate) fn read_clipboard_file_range(
    path: &Path,
    position: u64,
    requested_size: u32,
) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW);
    let mut file = options
        .open(path)
        .map_err(|e| format!("open '{}': {}", path.display(), e))?;
    file.seek(SeekFrom::Start(position))
        .map_err(|e| format!("seek '{}': {}", path.display(), e))?;
    let max_chunk = 16 * 1024 * 1024;
    let size = usize::try_from(requested_size)
        .unwrap_or(usize::MAX)
        .min(max_chunk);
    let mut data = Vec::with_capacity(size);
    file.take(size as u64)
        .read_to_end(&mut data)
        .map_err(|e| format!("read '{}': {}", path.display(), e))?;
    Ok(data)
}
