//! QA-only observation/input in the job-owned Mutter desktop.
//! Product capture and automatic scrolling continue to use their own portal.

use std::io::{Read, Write};
use std::os::unix::{fs::FileTypeExt, net::UnixStream};
use std::time::Duration;

use anyhow::Context;
use serde_json::{Value, json};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub(super) fn active() -> bool {
    super::super::pins::native_wayland()
}

pub(super) async fn command(request: Value) -> anyhow::Result<Value> {
    tokio::task::spawn_blocking(move || command_sync(request))
        .await
        .context("Mutter observation/input task")?
}

/// The dual-output scenario tells the owned consent helper which real preview
/// to approve. Clear that intention on every exit, including failed scenarios.
pub(super) struct PortalMonitorSelection;

impl Drop for PortalMonitorSelection {
    fn drop(&mut self) {
        if active() {
            let _ = command_sync(json!({"command":"portal_monitor", "index":null}));
        }
    }
}

pub(super) async fn select_portal_monitor(index: usize) -> anyhow::Result<()> {
    if active() {
        command(json!({"command":"portal_monitor", "index":index})).await?;
    }
    Ok(())
}

fn command_sync(request: Value) -> anyhow::Result<Value> {
    let socket = std::path::PathBuf::from(
        std::env::var_os("QA_WAYLAND_INPUT_SOCKET")
            .context("owned Wayland input socket missing")?,
    );
    let runtime = std::path::PathBuf::from(
        std::env::var_os("XDG_RUNTIME_DIR").context("owned Wayland runtime missing")?,
    );
    anyhow::ensure!(
        socket
            .parent()
            .context("input socket parent")?
            .canonicalize()?
            == runtime.canonicalize()?
            && socket.metadata()?.file_type().is_socket(),
        "Wayland input socket is outside the owned runtime"
    );
    let mut connection = UnixStream::connect(socket).context("connect owned Mutter broker")?;
    connection.set_read_timeout(Some(Duration::from_secs(30)))?;
    connection.set_write_timeout(Some(Duration::from_secs(5)))?;
    connection.write_all(serde_json::to_string(&request)?.as_bytes())?;
    connection.write_all(b"\n")?;
    let mut response = String::new();
    connection.take(1_048_576).read_to_string(&mut response)?;
    let response: Value = serde_json::from_str(&response).context("Mutter response")?;
    anyhow::ensure!(response["ok"] == true, "Mutter command failed: {response}");
    Ok(response["value"].clone())
}

/// GTK does not receive Wayland's actual minimized state. Observe the owned
/// compositor instead; a queued minimize request is not a visibility pass.
pub(super) fn visible(window: &WebviewWindow) -> anyhow::Result<bool> {
    command_sync(
        json!({"command":"geometry", "application":std::env::current_exe()?,
        "title":window.title()?}),
    )?["visible"]
        .as_bool()
        .context("Mutter window visibility")
}

pub(super) async fn window(window: &WebviewWindow) -> anyhow::Result<Value> {
    command(
        json!({"command":"geometry", "application":std::env::current_exe()?,
        "title":window.title()?}),
    )
    .await
}

pub(super) fn rect(
    value: &Value,
    scale: f64,
) -> anyhow::Result<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let x = value["x"].as_f64().context("Mutter rectangle x")?;
    let y = value["y"].as_f64().context("Mutter rectangle y")?;
    let width = value["width"].as_f64().context("Mutter rectangle width")?;
    let height = value["height"]
        .as_f64()
        .context("Mutter rectangle height")?;
    anyhow::ensure!(
        width > 0.0 && height > 0.0,
        "Mutter rectangle is empty: {value}"
    );
    Ok((
        PhysicalPosition::new((x * scale).round() as i32, (y * scale).round() as i32),
        PhysicalSize::new(
            (width * scale).round() as u32,
            (height * scale).round() as u32,
        ),
    ))
}

pub(super) async fn inner_rect(
    window: &WebviewWindow,
) -> anyhow::Result<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let native = self::window(window).await?;
    rect(
        &native["client"],
        output_scale(window.app_handle(), &native["client"])?,
    )
}

/// XWayland's buffer scale is global, while portal pixels are output-specific.
/// Resolve the actual compositor rectangle before comparing desktop pixels.
pub(super) fn output_scale(app: &tauri::AppHandle, value: &Value) -> anyhow::Result<f64> {
    let cx = value["x"].as_f64().context("native x")?
        + value["width"].as_f64().context("native width")? / 2.0;
    let cy = value["y"].as_f64().context("native y")?
        + value["height"].as_f64().context("native height")? / 2.0;
    super::super::capture::list_displays(app)?
        .into_iter()
        .find(|display| {
            let (x, y, w, h) = display.logical_rect();
            cx >= x as f64 && cy >= y as f64 && cx < (x + w) as f64 && cy < (y + h) as f64
        })
        .map(|display| display.scale_factor)
        .context("native rectangle is outside actual outputs")
}

pub(super) async fn control_geometry(
    window: &WebviewWindow,
) -> anyhow::Result<(super::super::surfaces::Rect, bool, Value)> {
    let native = self::window(window).await?;
    let (origin, size) = rect(
        &native["client"],
        output_scale(window.app_handle(), &native["client"])?,
    )?;
    let selector = if window.label() == super::super::surfaces::SCROLL_LABEL {
        "screenshot-scroll-controller"
    } else {
        "screenshot-recorder"
    };
    let dom = super::run_js(window, &format!(r#"
        const q=()=>document.querySelector('[data-testid="{selector}"]');
        for(let i=0;i<50&&!q();i++) await new Promise(r=>setTimeout(r,50));
        const el=q(); if(!el) throw new Error('capture control DOM missing');
        const r=el.getBoundingClientRect();
        return {{x:r.x,y:r.y,width:r.width,height:r.height,
            viewportWidth:innerWidth,viewportHeight:innerHeight,background:getComputedStyle(el).backgroundColor}};
    "#), Duration::from_secs(5)).await?;
    let sx = size.width as f64
        / dom["viewportWidth"]
            .as_f64()
            .context("control viewport width")?;
    let sy = size.height as f64
        / dom["viewportHeight"]
            .as_f64()
            .context("control viewport height")?;
    let control = super::super::surfaces::Rect {
        x: origin.x + (dom["x"].as_f64().context("control x")? * sx).floor() as i32,
        y: origin.y + (dom["y"].as_f64().context("control y")? * sy).floor() as i32,
        w: (dom["width"].as_f64().context("control width")? * sx).ceil() as i32,
        h: (dom["height"].as_f64().context("control height")? * sy).ceil() as i32,
    };
    let visible = native["visible"] == true && control.w > 0 && control.h > 0;
    Ok((
        control,
        visible,
        json!({"transport":"Mutter geometry and rendered control bounds", "native":native,"dom":dom}),
    ))
}

pub(super) async fn pointer(point: (i32, i32)) -> anyhow::Result<()> {
    command(json!({"command":"pointer","x":point.0,"y":point.1})).await?;
    Ok(())
}

pub(super) async fn mouse_path(points: Vec<(i32, i32)>) -> anyhow::Result<()> {
    command(json!({"command":"path","points":points})).await?;
    Ok(())
}

pub(super) async fn wheel(point: (i32, i32), steps: i32) -> anyhow::Result<()> {
    command(json!({"command":"wheel","x":point.0,"y":point.1,"steps":steps})).await?;
    Ok(())
}

pub(super) async fn keys(chords: Vec<Vec<u32>>) -> anyhow::Result<()> {
    command(json!({"command":"keys","chords":chords})).await?;
    Ok(())
}

pub(super) async fn type_text(text: String) -> anyhow::Result<()> {
    command(json!({"command":"text","text":text})).await?;
    Ok(())
}
