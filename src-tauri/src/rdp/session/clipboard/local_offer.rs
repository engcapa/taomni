use super::local_files::read_clipboard_file_range;
use crate::rdp::session::ClipboardBridge;
use crate::rdp::session::LocalClipboardFile;
use ironrdp::cliprdr::pdu::FileContentsFlags;
use ironrdp::cliprdr::pdu::FileContentsRequest;
use ironrdp::cliprdr::pdu::FileContentsResponse;
use ironrdp::cliprdr::pdu::FileDescriptor as IronClipboardFileDescriptor;
use ironrdp::cliprdr::pdu::FormatDataResponse;
use ironrdp::cliprdr::pdu::OwnedFormatDataResponse;
use ironrdp::cliprdr::pdu::PackedFileList;
use ironrdp::core::IntoOwned;

impl ClipboardBridge {
    pub(in crate::rdp::session) fn set_local_text(&self, text: String) {
        if let Ok(mut state) = self.state.lock() {
            state.local_text = Some(text);
            state.local_files.clear();
        }
    }

    pub(in crate::rdp::session) fn set_local_files(&self, files: Vec<LocalClipboardFile>) {
        if let Ok(mut state) = self.state.lock() {
            state.local_text = None;
            state.local_files = files;
        }
    }

    pub(in crate::rdp::session) fn local_file_list_response(&self) -> OwnedFormatDataResponse {
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

    pub(in crate::rdp::session) fn local_file_contents_response(
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
}
