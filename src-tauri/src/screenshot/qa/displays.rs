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
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    Ok(json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height}))
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
        let main_before = geometry(&main).await?;
        // Park outside the next captured monitor. CursorMode::Embedded cannot
        // then contaminate the independent full-screen pixel comparison.
        let other = &monitors[1 - initial]["logical"];
        park_pointer((
            other["x"].as_i64().unwrap() as i32 + 16,
            other["y"].as_i64().unwrap() as i32 + 16,
        ))
        .await?;
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
                    other["x"].as_i64().unwrap() as i32 + 16,
                    other["y"].as_i64().unwrap() as i32 + 16,
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
                let clip = read_clipboard_image()?;
                let scale = fact["scale"].as_f64().unwrap();
                let reference = capture::crop(
                    &expected,
                    (128.0 * scale) as u32,
                    (128.0 * scale) as u32,
                    (384.0 * scale) as u32,
                    (256.0 * scale) as u32,
                );
                let pixels = qa_oracle::compare(&clip, &reference, false);
                let main_after = geometry(&main).await?;
                let copied = json!({"initial":initial,"selection":selection,"pixels":pixels,
                    "mainBefore":main_before,"mainAfter":main_after,"mainVisible":main_visible(app),
                    "clipboard":keep_image(&clip,&format!("dual-{initial}-clipboard.png"))});
                keep_json(&copied, &format!("dual-{initial}-copy.json"))?;
                anyhow::ensure!(
                    pixels.passed && main_visible(app) && main_before == main_after,
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
