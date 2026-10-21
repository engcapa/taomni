/// Cheap signal that the host clipboard may have changed. `None` means the
/// session has no such signal and the content itself must be compared.
pub(super) struct ChangeToken {
    #[cfg(target_os = "linux")]
    pub(super) selection: Option<x11_selection::SelectionWatch>,
}

impl ChangeToken {
    pub(super) fn new() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            selection: x11_selection::SelectionWatch::new(),
        }
    }

    #[cfg(target_os = "windows")]
    pub(super) fn current(&mut self) -> Option<u64> {
        // SAFETY: a plain read of the session clipboard's change counter.
        Some(u64::from(unsafe {
            windows::Win32::System::DataExchange::GetClipboardSequenceNumber()
        }))
    }

    #[cfg(target_os = "macos")]
    pub(super) fn current(&mut self) -> Option<u64> {
        Some(objc2_app_kit::NSPasteboard::generalPasteboard().changeCount() as u64)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn current(&mut self) -> Option<u64> {
        self.selection
            .as_mut()
            .map(x11_selection::SelectionWatch::events)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    pub(super) fn current(&mut self) -> Option<u64> {
        None
    }
}

#[cfg(target_os = "linux")]
mod x11_selection {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::Event;
    use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
    use x11rb::protocol::xproto::ConnectionExt as _;
    use x11rb::rust_connection::RustConnection;

    /// Counts XFixes owner events for CLIPBOARD. Every copy re-asserts
    /// selection ownership, so the count changes without reading any data.
    pub(in crate::servers::rdp) struct SelectionWatch {
        conn: RustConnection,
        events: u64,
    }

    impl SelectionWatch {
        pub(in crate::servers::rdp) fn new() -> Option<Self> {
            std::env::var_os("DISPLAY")?;
            let (conn, screen) = x11rb::connect(None).ok()?;
            conn.xfixes_query_version(5, 0).ok()?.reply().ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            let clipboard = conn
                .intern_atom(false, b"CLIPBOARD")
                .ok()?
                .reply()
                .ok()?
                .atom;
            conn.xfixes_select_selection_input(
                root,
                clipboard,
                SelectionEventMask::SET_SELECTION_OWNER
                    | SelectionEventMask::SELECTION_WINDOW_DESTROY
                    | SelectionEventMask::SELECTION_CLIENT_CLOSE,
            )
            .ok()?;
            conn.flush().ok()?;
            Some(Self { conn, events: 0 })
        }

        pub(in crate::servers::rdp) fn events(&mut self) -> u64 {
            while let Ok(Some(event)) = self.conn.poll_for_event() {
                if matches!(event, Event::XfixesSelectionNotify(_)) {
                    self.events += 1;
                }
            }
            self.events
        }
    }
}
