//! Native dual-output evidence: external GTK originals, actual compositor geometry,
//! public display picker, OS selection input and system clipboard pixels.
use super::*;

#[tauri::command]
pub async fn screenshot_qa_displays(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    #[cfg(not(target_os = "linux"))]
    {
        Err("dual-output fixture requires Linux".into())
    }
    #[cfg(target_os = "linux")]
    {
        verify(&app).await.map_err(|e| format!("{e:#}"))
    }
}

#[cfg(target_os = "linux")]
async fn geometry(window: &WebviewWindow) -> anyhow::Result<Value> {
    if wayland::active() {
        return Ok(wayland::window(window).await?["frame"].clone());
    }
    // GTK can cache transient 0,0 coordinates around unmap/remap. Observe
    // the X server independently, as we do with Mutter on Wayland.
    let title = window.title()?;
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("xwininfo")
            .args(["-name", &title])
            .output()
    })
    .await??;
    anyhow::ensure!(
        output.status.success(),
        "X11 geometry probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let (rect, _) = x11_control_geometry(&String::from_utf8_lossy(&output.stdout))
        .context("X11 native window rectangle")?;
    Ok(json!({"x":rect.x,"y":rect.y,"width":rect.w,"height":rect.h}))
}

#[cfg(target_os = "linux")]
async fn place_main(main: &WebviewWindow, x: i32, y: i32) -> anyhow::Result<()> {
    if wayland::active() {
        wayland::command(
            json!({"command":"place", "application":std::env::current_exe()?,
            "title":main.title()?, "rect":{"x":x+100,"y":y+100,"width":800,"height":600}}),
        )
        .await?;
    } else {
        main.set_position(tauri::PhysicalPosition::new(x + 100, y + 100))?;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    Ok(())
}

#[cfg(target_os = "linux")]
fn on_monitor(window: &Value, monitor: &Value) -> bool {
    let coordinate = |value: &Value, key: &str| value[key].as_f64().unwrap_or(f64::NAN);
    let x = coordinate(window, "x") + coordinate(window, "width") / 2.0;
    let y = coordinate(window, "y") + coordinate(window, "height") / 2.0;
    x >= coordinate(monitor, "x")
        && x < coordinate(monitor, "x") + coordinate(monitor, "width")
        && y >= coordinate(monitor, "y")
        && y < coordinate(monitor, "y") + coordinate(monitor, "height")
}

#[cfg(target_os = "linux")]
async fn verify(app: &AppHandle) -> anyhow::Result<String> {
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(app);
    let fixture_path =
        std::env::var("QA_MULTI_DISPLAY_FIXTURE").context("dual output fixture missing")?;
    let fixture: Value = serde_json::from_slice(&std::fs::read(fixture_path)?)?;
    anyhow::ensure!(
        fixture["kind"] == "OS virtual outputs",
        "unverified display fixture"
    );
    let monitors = fixture["monitors"].as_array().context("fixture monitors")?;
    let worker = app.clone();
    let displays = tokio::task::spawn_blocking(move || capture::list_displays(&worker)).await??;
    anyhow::ensure!(
        monitors.len() == 2 && displays.len() == 2,
        "OS enumeration is not dual: {displays:?}; {fixture}"
    );
    if wayland::active() {
        anyhow::ensure!(fixture["mixedDpi"] == true, "OS mixed DPI missing");
    }
    let main = app.get_webview_window("main").context("main window")?;
    let mut attempts = Vec::new();
    // Keep Taomni on the first output while capturing both. Then invoke from
    // the second output to prove Wayland's synthetic cursor does not select 0,0.
    for initial in 0..2usize {
        let logical = &monitors[initial]["logical"];
        let x = logical["x"].as_i64().context("monitor x")? as i32;
        let y = logical["y"].as_i64().context("monitor y")? as i32;
        place_main(&main, x, y).await?;
        // Park outside the next captured monitor. CursorMode::Embedded cannot
        // then contaminate the independent full-screen pixel comparison.
        // X11 exposes the real pointer and uses its monitor for the default;
        // its root image excludes the cursor. Wayland uses the invoking
        // window's monitor, so keep the embedded pointer on the other output.
        let pointer_monitor = if wayland::active() {
            1 - initial
        } else {
            initial
        };
        let other = &monitors[pointer_monitor]["logical"];
        park_pointer((
            other["x"].as_i64().unwrap() as i32 + 64,
            other["y"].as_i64().unwrap() as i32 + 64,
        ))
        .await?;
        // Recording and Wayland scrolling crop a persistent monitor stream;
        // renderer Copy alone cannot prove this separate backend path.
        if super::super::hide_app_windows(app) {
            super::super::await_hidden_windows(app)
                .await
                .map_err(anyhow::Error::msg)?;
        }
        let scale = monitors[initial]["scale"]
            .as_f64()
            .context("monitor scale")?;
        let target_rect = (
            x,
            y,
            logical["width"].as_i64().unwrap() as i32,
            logical["height"].as_i64().unwrap() as i32,
        );
        let display = displays
            .iter()
            .find(|d| d.logical_rect() == target_rect)
            .context("initial monitor")?
            .clone();
        let region = (
            (128.0 * scale) as u32,
            (128.0 * scale) as u32,
            (384.0 * scale) as u32,
            (256.0 * scale) as u32,
        );
        let worker = app.clone();
        let streamed = tokio::task::spawn_blocking(move || {
            capture::FrameSource::for_region(&worker, display, region).grab()
        })
        .await?;
        super::super::restore_app_windows(app);
        let streamed = streamed?;
        let original = image::open(
            monitors[initial]["expected"]
                .as_str()
                .context("monitor original")?,
        )?
        .to_rgba8();
        let reference = capture::crop(&original, region.0, region.1, region.2, region.3);
        let pixels = qa_oracle::compare(&streamed, &reference, false);
        let region_evidence = json!({"initial":initial,"region":region,"pixels":pixels,
            "actual":keep_image(&streamed,&format!("dual-{initial}-stream-region.png")),
            "expected":keep_image(&reference,&format!("dual-{initial}-stream-region-expected.png"))});
        keep_json(
            &region_evidence,
            &format!("dual-{initial}-stream-region.json"),
        )?;
        anyhow::ensure!(
            pixels.passed,
            "persistent monitor region mismatch: {region_evidence}"
        );
        attempts.push(region_evidence);
        // The standalone backend probe above remaps main as part of fixture
        // cleanup. Establish the actual invoking monitor again before the
        // public button workflow; Wayland owns normal-window placement.
        place_main(&main, x, y).await?;
        let main_before = geometry(&main).await?;
        anyhow::ensure!(
            on_monitor(&main_before, logical),
            "fixture did not place invoking main on the target monitor: {main_before}"
        );
        run_js(
            &main,
            "document.querySelector('[data-testid=\"system-screenshot\"]').click(); return true;",
            Duration::from_secs(5),
        )
        .await?;
        let overlay =
            wait_window(app, super::super::OVERLAY_LABEL, Duration::from_secs(20)).await?;
        for (step, index) in [initial, 1 - initial, initial].into_iter().enumerate() {
            let fact = &monitors[index];
            let l = &fact["logical"];
            let rect = (
                l["x"].as_i64().unwrap() as i32,
                l["y"].as_i64().unwrap() as i32,
                l["width"].as_i64().unwrap() as i32,
                l["height"].as_i64().unwrap() as i32,
            );
            let display = displays
                .iter()
                .find(|d| d.logical_rect() == rect)
                .context("GDK/Tauri monitor mismatch")?;
            if step > 0 {
                let other = &monitors[1 - index]["logical"];
                park_pointer((
                    other["x"].as_i64().unwrap() as i32 + 64,
                    other["y"].as_i64().unwrap() as i32 + 64,
                ))
                .await?;
                run_js(
                    &overlay,
                    &format!(
                        r#"
                    const s=document.querySelector('[data-testid="screenshot-display-select"]');
                    if(!s) throw new Error('public display picker missing');
                    s.value={}; s.dispatchEvent(new Event('change',{{bubbles:true}})); return true;
                "#,
                        serde_json::to_string(&display.id)?
                    ),
                    Duration::from_secs(5),
                )
                .await?;
            }
            let deadline = Instant::now() + Duration::from_secs(20);
            let (init, native, dom) = loop {
                let init = super::super::screenshot_overlay_init()
                    .await
                    .map_err(anyhow::Error::msg)?;
                let native = geometry(&overlay).await?;
                let dom = run_js(&overlay, r#"
                    const img=document.querySelector('[data-testid="screenshot-base-image"]');
                    return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,
                        loaded:!!img?.complete&&img.naturalWidth>0,imageWidth:img?.naturalWidth,imageHeight:img?.naturalHeight,
                        selected:document.querySelector('[data-testid="screenshot-display-select"]')?.value,
                        phase:document.querySelector('[data-testid="screenshot-overlay"]')?.dataset.phase};
                "#, Duration::from_secs(3)).await?;
                let expected_rect = json!({"x":rect.0,"y":rect.1,"width":rect.2,"height":rect.3});
                if init.display_id == display.id
                    && dom["loaded"] == true
                    && dom["selected"] == display.id
                    && native == expected_rect
                    && dom["width"] == rect.2
                    && dom["height"] == rect.3
                    && dom["dpr"] == fact["scale"]
                    && dom["imageWidth"] == init.width
                    && dom["imageHeight"] == init.height
                {
                    break (init, native, dom);
                }
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "monitor surface mismatch: target={display:?}; init={init:?}; native={native}; dom={dom}"
                );
                tokio::time::sleep(Duration::from_millis(120)).await;
            };
            let actual = image::open(&init.path)?.to_rgba8();
            let expected =
                image::open(fact["expected"].as_str().context("original path")?)?.to_rgba8();
            let pixels = qa_oracle::compare(&actual, &expected, false);
            let evidence = json!({"initial":initial,"step":step,"display":display,"native":native,"dom":dom,
                "pixels":pixels,"actual":keep_image(&actual,&format!("dual-{initial}-{step}-actual.png")),
                "expected":keep_image(&expected,&format!("dual-{initial}-{step}-expected.png"))});
            keep_json(&evidence, &format!("dual-{initial}-{step}.json"))?;
            anyhow::ensure!(
                pixels.passed && actual.dimensions() == (display.width, display.height),
                "wrong monitor pixels: {evidence}"
            );
            attempts.push(evidence);
            if step == 2 {
                mouse_path(vec![
                    (rect.0 + 128, rect.1 + 128),
                    (rect.0 + 320, rect.1 + 256),
                    (rect.0 + 512, rect.1 + 384),
                ])
                .await?;
                let selection = run_js(&overlay, r#"
                    for(let i=0;i<50&&!document.querySelector('[data-testid="screenshot-copy"]');i++) await new Promise(r=>setTimeout(r,50));
                    const s=document.querySelector('[data-testid="screenshot-selection"]');
                    if(!s) throw new Error('native selection missing');
                    const rect=s.getBoundingClientRect().toJSON();
                    document.querySelector('[data-testid="screenshot-copy"]').click(); return rect;
                "#, Duration::from_secs(8)).await?;
                anyhow::ensure!(
                    wait_closed(app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await,
                    "copy did not close overlay"
                );
                let clip = read_clipboard_image(app)?;
                let scale = fact["scale"].as_f64().unwrap();
                let reference = capture::crop(
                    &expected,
                    (128.0 * scale) as u32,
                    (128.0 * scale) as u32,
                    (384.0 * scale) as u32,
                    (256.0 * scale) as u32,
                );
                let pixels = qa_oracle::compare(&clip, &reference, false);
                // Showing main and closing the tool are independent native
                // requests. Wait for the compositor acknowledgement instead
                // of treating its transient 0,0 geometry as final placement.
                let until = Instant::now() + Duration::from_secs(5);
                let main_after = loop {
                    let observed = geometry(&main).await.unwrap_or(Value::Null);
                    if main_visible(app) && on_monitor(&observed, logical) {
                        break observed;
                    }
                    if Instant::now() >= until {
                        break observed;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                };
                let copied = json!({"initial":initial,"selection":selection,"pixels":pixels,
                    "mainBefore":main_before,"mainAfter":main_after,"mainVisible":main_visible(app),
                    "clipboard":keep_image(&clip,&format!("dual-{initial}-clipboard.png"))});
                keep_json(&copied, &format!("dual-{initial}-copy.json"))?;
                anyhow::ensure!(
                    pixels.passed && main_visible(app) && on_monitor(&main_after, logical),
                    "selection/DPI/restore mismatch: {copied}"
                );
                attempts.push(copied);
            }
        }
    }
    Ok(report(
        true,
        json!({"fixture":fixture,"displays":displays,"attempts":attempts,
        "physicalHardware":false,"input":"OS pointer drag","oracle":"external GTK Cairo originals"}),
    ))
}
