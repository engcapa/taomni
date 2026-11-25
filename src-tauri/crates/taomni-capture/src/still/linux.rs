//! X11 RandR and one-shot portal policies. Neither starts a ScreenCast stream.

use super::{LumaBudget, LumaFrame, StillError};
use crate::pixels::{rgba_to_luma, zpixmap_to_luma};
use x11rb::connection::Connection as _;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder};

pub(super) fn capture_x11(budget: &mut LumaBudget) -> Result<Vec<LumaFrame>, StillError> {
    let (conn, screen_num) =
        x11rb::connect(None).map_err(|e| StillError::NoDisplay(e.to_string()))?;
    let setup = conn.setup();
    let screen = setup
        .roots
        .get(screen_num)
        .ok_or_else(|| StillError::NoDisplay("no displays found".into()))?;
    let bits = setup
        .pixmap_formats
        .iter()
        .find(|f| f.depth == screen.root_depth)
        .map(|f| f.bits_per_pixel);
    if bits != Some(32) {
        return Err(StillError::Failed(format!(
            "unsupported X11 root depth {}",
            screen.root_depth
        )));
    }
    let lsb_first = setup.image_byte_order == ImageOrder::LSB_FIRST;
    let mut rects: Vec<(i16, i16, u16, u16)> = conn
        .randr_get_monitors(screen.root, true)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .map(|reply| {
            reply
                .monitors
                .iter()
                .map(|m| (m.x, m.y, m.width, m.height))
                .collect()
        })
        .unwrap_or_default();
    rects.retain(|&(_, _, w, h)| w > 0 && h > 0);
    if rects.is_empty() {
        rects.push((0, 0, screen.width_in_pixels, screen.height_in_pixels));
    }
    let mut frames = Vec::with_capacity(rects.len());
    let mut failures = Vec::new();
    for (x, y, w, h) in rects {
        budget.check(u32::from(w), u32::from(h))?;
        let reply = conn
            .get_image(ImageFormat::Z_PIXMAP, screen.root, x, y, w, h, !0)
            .map_err(|e| e.to_string())
            .and_then(|cookie| cookie.reply().map_err(|e| e.to_string()));
        match reply.and_then(|image| {
            zpixmap_to_luma(&image.data, u32::from(w), u32::from(h), lsb_first)
                .map_err(|e| e.to_string())
        }) {
            Ok(luma) => {
                budget.account(u32::from(w), u32::from(h))?;
                frames.push(LumaFrame {
                    width: u32::from(w),
                    height: u32::from(h),
                    luma,
                });
            }
            Err(error) => failures.push(error),
        }
    }
    if frames.is_empty() {
        return Err(StillError::Failed(failures.join("; ")));
    }
    Ok(frames)
}

pub(super) fn capture_portal(budget: &mut LumaBudget) -> Result<Vec<LumaFrame>, StillError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| StillError::Failed(format!("screenshot portal runtime: {e}")))?;
    let uri = runtime.block_on(async {
        let request = ashpd::desktop::screenshot::Screenshot::request()
            .interactive(false)
            .modal(true)
            .send()
            .await
            .map_err(|e| StillError::Failed(format!("screenshot portal: {e}")))?;
        let response = request
            .response()
            .map_err(|e| StillError::Failed(format!("screenshot portal: {e}")))?;
        Ok::<_, StillError>(response.uri().clone())
    })?;
    let path = uri
        .to_file_path()
        .map_err(|_| StillError::Failed(format!("portal returned {uri}")))?;
    let decoded = (|| {
        if budget.is_bounded() {
            let (width, height) = image::image_dimensions(&path)
                .map_err(|e| StillError::Failed(format!("portal screenshot: {e}")))?;
            budget.check(width, height)?;
        }
        image::open(&path).map_err(|e| StillError::Failed(format!("portal screenshot: {e}")))
    })();
    // Portals write the capture to a temporary file; never touch user folders.
    let temporary = [
        std::env::temp_dir(),
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(Into::into)
            .unwrap_or_default(),
    ];
    if temporary
        .iter()
        .any(|dir| !dir.as_os_str().is_empty() && path.starts_with(dir))
    {
        let _ = std::fs::remove_file(&path);
    }
    let rgba = decoded?.to_rgba8();
    let (width, height) = rgba.dimensions();
    budget.account(width, height)?;
    Ok(vec![LumaFrame {
        width,
        height,
        luma: rgba_to_luma(rgba.as_raw(), width, height)
            .map_err(|e| StillError::Failed(e.to_string()))?,
    }])
}
