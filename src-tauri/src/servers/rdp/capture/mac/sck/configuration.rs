use super::limits::CONTENT_TIMEOUT;
use super::limits::FRAME_RATE;
use super::limits::NATIVE_QUEUE_DEPTH;
use super::limits::STOP_TIMEOUT;
use block2::RcBlock;
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2_core_graphics::CGMainDisplayID;
use objc2_core_video::kCVPixelFormatType_32BGRA;
use objc2_foundation::NSError;
use objc2_screen_capture_kit::SCDisplay;
use objc2_screen_capture_kit::SCShareableContent;
use objc2_screen_capture_kit::SCStream;
use objc2_screen_capture_kit::SCStreamConfiguration;
use std::sync::mpsc;
use std::sync::mpsc::RecvTimeoutError;

pub(super) fn configure_stream(configuration: &SCStreamConfiguration, width: u16, height: u16) {
    unsafe {
        configuration.setWidth(usize::from(width));
        configuration.setHeight(usize::from(height));
        configuration.setPixelFormat(kCVPixelFormatType_32BGRA);
        configuration.setMinimumFrameInterval(objc2_core_media::CMTime::new(1, FRAME_RATE));
        configuration.setQueueDepth(NATIVE_QUEUE_DEPTH);
        // The RDP client renders its local cursor immediately. Including it in
        // video produces a second, delayed cursor and was the source of the
        // observed overlap on macOS.
        configuration.setShowsCursor(false);
        configuration.setCapturesAudio(false);

        // Do not call `setShowMouseClicks(false)` here. Apple introduced that
        // selector in macOS 15; sending it to SCStreamConfiguration on macOS 14
        // raises an Objective-C exception which cannot unwind through Rust and
        // aborts the entire process. Its documented default is already false.
    }
}

pub(crate) fn shareable_content() -> anyhow::Result<Retained<SCShareableContent>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            let result = if content.is_null() {
                let detail = if error.is_null() {
                    "no content or error returned".to_string()
                } else {
                    "macOS returned an error while enumerating shareable content".to_string()
                };
                Err(anyhow::anyhow!(
                    "ScreenCaptureKit content query failed: {detail}"
                ))
            } else {
                // Apple's completion result is autoreleased. Retain it before the
                // callback returns so display selection remains valid below.
                unsafe { Retained::retain(content) }.ok_or_else(|| {
                    anyhow::anyhow!("ScreenCaptureKit returned a null content object")
                })
            };
            let _ = sender.send(result);
        },
    );
    unsafe {
        SCShareableContent::getShareableContentWithCompletionHandler(&completion);
    }
    receiver
        .recv_timeout(CONTENT_TIMEOUT)
        .map_err(|error| match error {
            RecvTimeoutError::Timeout => anyhow::anyhow!(
                "ScreenCaptureKit did not enumerate displays within {} seconds",
                CONTENT_TIMEOUT.as_secs()
            ),
            RecvTimeoutError::Disconnected => {
                anyhow::anyhow!("ScreenCaptureKit content query disconnected")
            }
        })?
}

pub(crate) fn select_display(
    content: &SCShareableContent,
    display_id: Option<&str>,
) -> anyhow::Result<(Retained<SCDisplay>, u32)> {
    let requested = display_id
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| anyhow::anyhow!("invalid macOS display id '{value}'"))
        })
        .transpose()?;
    let displays = unsafe { content.displays().to_vec() };
    let selected = match requested {
        Some(id) => displays
            .into_iter()
            .find(|display| unsafe { display.displayID() } == id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "selected display {id} is no longer available; choose an active display in RDP Server settings"
                )
            })?,
        None => {
            let main_display = CGMainDisplayID();
            displays
                .iter()
                .find(|display| unsafe { display.displayID() } == main_display)
                .cloned()
                .or_else(|| displays.into_iter().next())
                .ok_or_else(|| anyhow::anyhow!("ScreenCaptureKit found no active macOS displays"))?
        }
    };
    let id = unsafe { selected.displayID() };
    Ok((selected, id))
}

pub(crate) fn start_stream(stream: &SCStream) -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(move |error: *mut NSError| {
        let result = if error.is_null() {
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "macOS rejected ScreenCaptureKit stream start"
            ))
        };
        let _ = sender.send(result);
    });
    unsafe {
        stream.startCaptureWithCompletionHandler(Some(&completion));
    }
    receiver
        .recv_timeout(CONTENT_TIMEOUT)
        .map_err(|error| match error {
            RecvTimeoutError::Timeout => anyhow::anyhow!(
                "ScreenCaptureKit did not start within {} seconds",
                CONTENT_TIMEOUT.as_secs()
            ),
            RecvTimeoutError::Disconnected => {
                anyhow::anyhow!("ScreenCaptureKit start disconnected")
            }
        })?
}

pub(super) fn update_stream_configuration(
    stream: &SCStream,
    configuration: &SCStreamConfiguration,
) -> anyhow::Result<()> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(move |error: *mut NSError| {
        let result = if error.is_null() {
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "macOS rejected ScreenCaptureKit output resize"
            ))
        };
        let _ = sender.send(result);
    });
    unsafe {
        stream.updateConfiguration_completionHandler(configuration, Some(&completion));
    }
    receiver
        .recv_timeout(CONTENT_TIMEOUT)
        .map_err(|error| match error {
            RecvTimeoutError::Timeout => anyhow::anyhow!(
                "ScreenCaptureKit output resize did not finish within {} seconds",
                CONTENT_TIMEOUT.as_secs()
            ),
            RecvTimeoutError::Disconnected => {
                anyhow::anyhow!("ScreenCaptureKit output resize disconnected")
            }
        })?
}

pub(crate) fn stop_stream(stream: &SCStream) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let completion = RcBlock::new(move |_error: *mut NSError| {
        let _ = sender.send(());
    });
    unsafe {
        stream.stopCaptureWithCompletionHandler(Some(&completion));
    }
    let _ = receiver.recv_timeout(STOP_TIMEOUT);
}
