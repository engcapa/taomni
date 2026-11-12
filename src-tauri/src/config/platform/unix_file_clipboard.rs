//! GTK owns the file offer for the lifetime of the native selection, on both
//! X11 and Wayland. No subprocesses, short-lived arboard owners, or text fallbacks.

use super::super::clipboard::file_clipboard::{
    FileListFormat, FileOffer, MAX_PAYLOAD_BYTES, error,
};
use gtk::{gdk, glib, prelude::*};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

enum ReadReply {
    Paths(Vec<String>),
    UnavailableTargets { x11_display: Option<String> },
}

fn file_format_from_targets(targets: &[String]) -> Option<FileListFormat> {
    FileListFormat::ALL
        .into_iter()
        .find(|format| targets.iter().any(|target| target == format.mime()))
}

fn failed_targets_result(x11_owner: Option<u32>) -> Result<Vec<String>, String> {
    // GDK's selection_owner_get returns None for unwrapped foreign windows,
    // not just an empty selection. Only the raw X11 NONE window proves empty.
    match x11_owner {
        Some(x11rb::NONE) => Ok(Vec::new()),
        Some(_) | None => Err(error("unavailable", "native target enumeration failed")),
    }
}

fn query_x11_owner(display: &str) -> Result<u32, String> {
    use x11rb::protocol::xproto::ConnectionExt;

    let query = || -> Result<u32, Box<dyn std::error::Error>> {
        let (connection, _) = x11rb::connect(Some(display))?;
        let atom = connection.intern_atom(false, b"CLIPBOARD")?.reply()?.atom;
        Ok(connection.get_selection_owner(atom)?.reply()?.owner)
    };
    query().map_err(|cause| {
        error(
            "unavailable",
            format!("X11 selection owner query failed: {cause}"),
        )
    })
}

fn native_clipboard() -> Result<(gtk::Clipboard, bool), String> {
    if !gtk::is_initialized_main_thread() {
        return Err(error("unavailable", "GTK main thread is not initialized"));
    }
    let display =
        gdk::Display::default().ok_or_else(|| error("unavailable", "no native GTK display"))?;
    if display.is_closed() {
        return Err(error(
            "unavailable",
            "native GTK display connection is closed",
        ));
    }
    let backend = display.type_().name();
    let wayland = match backend {
        "GdkWaylandDisplay" => true,
        "GdkX11Display" => false,
        _ => return Err(error("unsupported", format!("GTK backend {backend}"))),
    };
    if wayland {
        // GTK uses wl_data_device (the focused application's input serial), not
        // arboard's disabled data-control feature. Do not claim background writes
        // succeeded: a compositor may reject them without acknowledging failure.
        let focused = gtk::Window::list_toplevels().into_iter().any(|widget| {
            widget
                .downcast::<gtk::Window>()
                .is_ok_and(|window| window.display() == display && window.is_active())
        });
        if !focused
            || display
                .default_seat()
                .and_then(|seat| seat.keyboard())
                .is_none()
        {
            return Err(error(
                "permission_denied",
                "Wayland file clipboard requires a focused application window and keyboard seat",
            ));
        }
    }
    let clipboard = gtk::Clipboard::default(&display)
        .ok_or_else(|| error("unavailable", "GTK CLIPBOARD selection is unavailable"))?;
    Ok((clipboard, wayland))
}

pub async fn clipboard_read_files() -> Result<Vec<String>, String> {
    if !gtk::is_initialized() {
        return Err(error("unavailable", "GTK is not initialized"));
    }
    let (sender, receiver) = oneshot::channel();
    // Unlike MainContext::invoke, an idle source cannot execute GTK code inline
    // on an IPC worker that happens to acquire an otherwise idle main context.
    glib::idle_add_once(move || {
        if sender.is_closed() {
            return;
        }
        let (clipboard, wayland) = match native_clipboard() {
            Ok(value) => value,
            Err(cause) => {
                let _ = sender.send(Err(cause));
                return;
            }
        };
        // Never use GDK's wrapped-window owner lookup to skip this request:
        // external file-manager owners may have no corresponding GdkWindow.
        let x11_display = if wayland {
            None
        } else {
            clipboard
                .display()
                .map(|display| display.name().to_string())
        };
        clipboard.request_contents(&gdk::Atom::intern("TARGETS"), move |clipboard, data| {
            if sender.is_closed() {
                return;
            }
            // A failed conversion is not evidence of an empty clipboard.
            // The IPC worker may prove an empty X11 selection with the raw
            // protocol query; Wayland has no equivalent reliable distinction.
            if data.length() < 0 {
                let _ = sender.send(Ok(ReadReply::UnavailableTargets { x11_display }));
                return;
            }
            if data.length() > 64 * 1024 {
                let _ = sender.send(Err(error("invalid", "too many native clipboard targets")));
                return;
            }
            let Some(targets) = data.targets() else {
                let _ = sender.send(Err(error("invalid", "invalid native target enumeration")));
                return;
            };
            let targets: Vec<String> = targets
                .iter()
                .map(|target| target.name().to_string())
                .collect();
            let Some(format) = file_format_from_targets(&targets) else {
                let _ = sender.send(Ok(ReadReply::Paths(Vec::new())));
                return;
            };
            clipboard.request_contents(&gdk::Atom::intern(format.mime()), move |_, data| {
                if sender.is_closed() {
                    return;
                }
                let result = if data.length() < 0 {
                    Err(error("unavailable", "native file list conversion failed"))
                } else if data.length() as usize > MAX_PAYLOAD_BYTES
                    || data.format() != 8
                    || data.data_type() != gdk::Atom::intern(format.mime())
                {
                    Err(error("invalid", "invalid native file-list representation"))
                } else {
                    format.decode(&data.data()).map(ReadReply::Paths)
                };
                let _ = sender.send(result);
            });
        });
    });
    tokio::time::timeout(REQUEST_TIMEOUT, async move {
        match receiver
            .await
            .map_err(|_| error("unavailable", "native file read was interrupted"))??
        {
            ReadReply::Paths(paths) => Ok(paths),
            ReadReply::UnavailableTargets {
                x11_display: Some(display),
            } => {
                // Do not block GTK while connecting or awaiting an X11 reply.
                let owner = tokio::task::spawn_blocking(move || query_x11_owner(&display))
                    .await
                    .map_err(|_| {
                        error("unavailable", "X11 selection owner query was interrupted")
                    })??;
                failed_targets_result(Some(owner))
            }
            ReadReply::UnavailableTargets { x11_display: None } => failed_targets_result(None),
        }
    })
    .await
    .map_err(|_| error("unavailable", "native file read timed out"))?
}

/// Serialize cancellation with the short synchronous ownership handoff. If the
/// main loop never services this request, timeout cancels it before it can write.
/// If the handoff already started, observe its result instead of reporting a
/// timeout followed by a surprising late clipboard replacement.
struct WriteGate(Mutex<bool>);

impl WriteGate {
    fn new() -> Self {
        Self(Mutex::new(true))
    }

    fn run(&self, deadline: Instant, action: impl FnOnce()) {
        let Ok(mut pending) = self.0.lock() else {
            return;
        };
        if *pending && Instant::now() <= deadline {
            action();
        }
        *pending = false;
    }

    fn cancel(&self) {
        if let Ok(mut pending) = self.0.lock() {
            *pending = false;
        }
    }
}

pub async fn clipboard_write_files(paths: &[String]) -> Result<(), String> {
    let offer = FileOffer::new(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    if !gtk::is_initialized() {
        return Err(error("unavailable", "GTK is not initialized"));
    }
    let gate = Arc::new(WriteGate::new());
    let queued = gate.clone();
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    let (sender, mut receiver) = oneshot::channel();
    glib::idle_add_once(move || {
        queued.run(deadline, || {
            if sender.is_closed() {
                return;
            }
            let result = native_clipboard().and_then(|(clipboard, _)| {
                let targets = FileListFormat::ALL.map(|format| {
                    gtk::TargetEntry::new(format.mime(), gtk::TargetFlags::empty(), format as u32)
                });
                // gtk_clipboard_set_with_data retains this owned callback and
                // destroys it only on selection clear/replacement or set failure.
                // libfm/PCManFM and Nautilus accept the GNOME copy header; URI
                // consumers (Dolphin/GTK) also get the standard text/uri-list.
                if clipboard.set_with_data(&targets, move |_, data, info| {
                    if let Some(format) = FileListFormat::ALL.get(info as usize) {
                        data.set(&gdk::Atom::intern(format.mime()), 8, offer.payload(*format));
                    }
                }) {
                    Ok(())
                } else {
                    Err(error(
                        "unavailable",
                        "GTK rejected native file clipboard ownership",
                    ))
                }
            });
            let _ = sender.send(result);
        });
    });
    match tokio::time::timeout(REQUEST_TIMEOUT, &mut receiver).await {
        Ok(result) => {
            result.map_err(|_| error("unavailable", "native file write was interrupted"))?
        }
        Err(_) => {
            gate.cancel();
            receiver.try_recv().unwrap_or_else(|_| {
                Err(error(
                    "unavailable",
                    "native file write timed out before ownership handoff",
                ))
            })
        }
    }
}

#[cfg(test)]
#[path = "unix_file_clipboard_tests.rs"]
mod tests;
