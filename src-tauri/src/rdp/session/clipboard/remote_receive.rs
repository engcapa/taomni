use super::remote_files::build_remote_file_transfer;
use super::remote_files::next_remote_file_request;
use super::remote_files::write_remote_file_chunk;
use crate::rdp::session::ClipboardAction;
use crate::rdp::session::ClipboardBridge;
use crate::rdp::session::MAX_CLIPBOARD_TOTAL_BYTES;
use crate::rdp::session::REMOTE_FILE_CHUNK_SIZE;
use crate::rdp::session::display;
use crate::rdp::session::events::send_text;
use ironrdp::cliprdr::pdu::FileContentsResponse;
use ironrdp::cliprdr::pdu::PackedFileList;
use ironrdp::core::IntoOwned;
use serde_json::json;
use std::path::PathBuf;

impl ClipboardBridge {
    pub(in crate::rdp::session) fn start_remote_file_receive(&self, list: PackedFileList) {
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

    pub(in crate::rdp::session) fn handle_remote_file_contents_response(
        &self,
        response: FileContentsResponse<'_>,
    ) {
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

    pub(in crate::rdp::session) fn finish_remote_file_receive(&self, paths: Vec<PathBuf>) {
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
}
