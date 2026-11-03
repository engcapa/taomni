//! Real Windows clipboard contention: one copy request must wait for the
//! competing owner, publish decoded pixels, and preserve the persistent owner.

use super::*;

#[tauri::command]
pub async fn screenshot_qa_clipboard_retry(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("clipboard contention scenario requires Windows".into())
    }
    #[cfg(target_os = "windows")]
    {
        use winapi::um::winuser::{
            CloseClipboard, CreateWindowExW, DestroyWindow, HWND_MESSAGE, OpenClipboard,
        };
        let _cleanup = ScenarioCleanup(app.clone());
        let expected = RgbaImage::from_fn(64, 48, |x, y| {
            image::Rgba([(x * 3) as u8, (y * 4) as u8, 93, 255])
        });
        let (path, _, _) =
            capture::save_png(&expected, "clipboard-retry").map_err(|e| format!("{e:#}"))?;
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            struct Owner {
                window: winapi::shared::windef::HWND,
                held: bool,
            }
            impl Drop for Owner {
                fn drop(&mut self) {
                    unsafe {
                        if self.held {
                            CloseClipboard();
                        }
                        if !self.window.is_null() {
                            DestroyWindow(self.window);
                        }
                    }
                }
            }
            // NULL does not identify a competing window; repeated NULL opens
            // can succeed without exercising the intended contention. Own an
            // invisible message-only STATIC window on this exact thread.
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let window = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    std::ptr::null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            let mut owner = Owner {
                window,
                held: false,
            };
            let deadline = Instant::now() + Duration::from_secs(2);
            while !window.is_null() {
                // No EmptyClipboard: preserve the contents during the hold.
                if unsafe { OpenClipboard(window) } != 0 {
                    owner.held = true;
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = ready_tx.send(owner.held);
            if owner.held && release_rx.recv_timeout(Duration::from_secs(3)).is_ok() {
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        let held = ready_rx.await.unwrap_or(false);
        // Establish a real failing control while the holder cannot release.
        // The native case must not pass just because a 200ms timer elapsed
        // before the production worker began running.
        let occupied = if held {
            super::super::runtime::blocking("clipboard contention control", || {
                Ok(matches!(
                    arboard::Clipboard::new()?.get_image(),
                    Err(arboard::Error::ClipboardOccupied)
                ))
            })
            .await
            .unwrap_or(false)
        } else {
            false
        };
        let retries_before = super::super::clipboard_copy::busy_retries();
        let started = Instant::now();
        let _ = release_tx.send(());
        let copied = if held && occupied {
            super::super::screenshot_copy_image(app.clone(), path.to_string_lossy().into_owned())
                .await
        } else {
            Err("clipboard contention control did not observe ClipboardOccupied".into())
        };
        let elapsed = started.elapsed().as_millis();
        let retries = super::super::clipboard_copy::busy_retries().saturating_sub(retries_before);
        holder
            .join()
            .map_err(|_| "clipboard holder panicked".to_string())?;
        let actual = read_clipboard_image(&app).map_err(|e| e.to_string());
        let matches = actual.as_ref().is_ok_and(|image| image == &expected);
        Ok(report(
            copied.is_ok() && held && occupied && retries > 0 && elapsed >= 200 && matches,
            json!({
                "scenario":"clipboard-retry", "held":held, "singleRequest":true,
                "occupiedControl":occupied, "busyRetries":retries,
                "copyError":copied.err(), "pixelsMatch":matches,
                "clipboardError":actual.err(), "elapsedMs":elapsed,
                "note":"A message-only window holds the real clipboard: a control read must be occupied, and one production copy must record a typed retry before publishing exact pixels.",
            }),
        ))
    }
}
