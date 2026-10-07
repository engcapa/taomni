//! Native pin arrangement without screen capture or global input injection.

use super::*;

#[tauri::command]
pub async fn screenshot_qa_pin_arrangement(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    verify(&app).await.map_err(|error| format!("{error:#}"))
}

async fn verify(app: &AppHandle) -> anyhow::Result<String> {
    let mut trace = ScenarioTrace::new("pin-arrangement-phases.json");
    let mut windows = Vec::new();
    let mut originals = Vec::new();
    for (index, color) in [[210, 30, 50, 255], [20, 150, 220, 255]]
        .into_iter()
        .enumerate()
    {
        let image = RgbaImage::from_pixel(320, 240, image::Rgba(color));
        let (path, _, _) = capture::save_png(&image, "qa-arrangement")?;
        let label =
            super::super::screenshot_pin_to_screen(app.clone(), path.to_string_lossy().into())
                .await
                .map_err(anyhow::Error::msg)?;
        let window = wait_window(app, &label, Duration::from_secs(10)).await?;
        let ready = run_js(&window, r#"
            const image = () => document.querySelector('[data-testid="screenshot-pin-image"]');
            for (let i=0; i<100 && !image()?.naturalWidth; i++) await new Promise(r=>setTimeout(r,50));
            return image()?.naturalWidth === 320 && image()?.naturalHeight === 240;
        "#, Duration::from_secs(10)).await?;
        anyhow::ensure!(ready == true, "pin {index} did not load its original image");
        // WebKitGTK needs several compositor turns between top-level
        // surfaces on X11/VNC. Creating both transparent pins back-to-back
        // can tear down the driver page while the second WebView is still
        // being mapped; Xtigervnc is slower than Xvfb here.
        tokio::time::sleep(Duration::from_millis(2000)).await;
        let pinned = super::super::tool_state()
            .pins
            .get(&label)
            .cloned()
            .context("missing pin payload")?;
        originals.push((std::path::PathBuf::from(pinned.path), image));
        windows.push(window);
    }
    anyhow::ensure!(originals[0].0 != originals[1].0, "pins share an owned file");
    trace.mark(
        "opened",
        json!({"labels":windows.iter().map(|w| w.label()).collect::<Vec<_>>()}),
    );
    trace.mark("note-begin", json!({"label": windows[0].label()}));
    let note = run_js(&windows[0], r#"
        const q=id=>document.querySelector('[data-testid="'+id+'"]');
        const wait=()=>new Promise(r=>setTimeout(r,50));
        q('screenshot-pin-menu-toggle').click();
        for(let i=0;i<100&&!q('screenshot-pin-note-input');i++) await wait();
        const input=q('screenshot-pin-note-input');
        input.focus();
        const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
        if(!setter) throw new Error('pin note value setter unavailable');
        setter.call(input,'QA original A');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        input.dispatchEvent(new Event('change',{bubbles:true})); await wait();
        for(let i=0;i<100&&input.value!=='QA original A';i++) await wait();
        q('screenshot-pin-note-save').click();
        for(let i=0;i<100&&q('screenshot-pin-note-save')?.disabled;i++) await wait();
        q('screenshot-pin-menu-toggle').click();
        for(let i=0;i<100&&q('screenshot-pin-note')?.textContent!=='QA original A';i++) await wait();
        return q('screenshot-pin-note')?.textContent;
    "#, Duration::from_secs(20)).await?;
    anyhow::ensure!(
        note == "QA original A",
        "pin note was not saved through the UI: {note}"
    );
    // Two pin windows exist from here on. Mark each remaining step so a native
    // page crash names the phase instead of only "opened".
    trace.mark("noted", json!({"note": note}));
    let pins = super::super::pins::screenshot_list_pins(app.clone())
        .await
        .map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        pins.len() == 2 && pins[0].note == "QA original A",
        "native pin note/list mismatch"
    );
    // Drive the same menu entry users use; this invokes native arrangement.
    run_js(&windows[0], r#"
        const q=id=>document.querySelector('[data-testid="'+id+'"]');
        if(!q('screenshot-pins-tile')) { q('screenshot-pin-menu-toggle').click(); await new Promise(r=>setTimeout(r,100)); }
        q('screenshot-pins-tile').click(); return true;
    "#, Duration::from_secs(5)).await?;
    trace.mark(
        "tile-requested",
        json!({"wayland": super::super::pins::native_wayland()}),
    );
    let wayland = super::super::pins::native_wayland();
    let geometry = if wayland {
        let board = wait_window(app, "screenshot-pin-board", Duration::from_secs(10)).await?;
        let content = run_js(&board, r#"
            const pins=()=>[...document.querySelectorAll('[data-testid="screenshot-board-pin"]')];
            for(let i=0;i<100&&(pins().length!==2||pins().some(p=>!p.querySelector('img')?.naturalWidth));i++)
                await new Promise(r=>setTimeout(r,50));
            return {count:pins().length,images:pins().map(p=>({width:p.querySelector('img')?.naturalWidth,height:p.querySelector('img')?.naturalHeight})),
                note:pins()[0]?.textContent,layout:document.querySelector('[data-testid="screenshot-pin-board"]')?.dataset.layout};
        "#, Duration::from_secs(10)).await?;
        anyhow::ensure!(
            content["count"] == 2 && content["layout"] == "tile",
            "board did not arrange two pins: {content}"
        );
        anyhow::ensure!(
            content["note"]
                .as_str()
                .is_some_and(|s| s.contains("QA original A")),
            "board lost the pin note"
        );
        for image in content["images"]
            .as_array()
            .context("board images missing")?
        {
            anyhow::ensure!(
                image["width"] == 320 && image["height"] == 240,
                "board image changed size: {image}"
            );
        }
        anyhow::ensure!(
            board.is_visible()? && windows.iter().all(|w| w.is_visible().ok() == Some(false)),
            "Wayland board must replace the individual visible pin surfaces"
        );
        let size = board.inner_size()?;
        anyhow::ensure!(
            size.width > 0 && size.height > 0,
            "board has no native surface size"
        );
        trace.mark("board", content.clone());
        // Closing destroys the WebView, including run_js's result slot. Observe
        // the native window lifecycle instead of polling that destroyed page.
        board.eval("document.querySelector('[data-testid=\"screenshot-board-close\"]').click()")?;
        anyhow::ensure!(
            wait_closed(app, "screenshot-pin-board", Duration::from_secs(5)).await,
            "board did not close"
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while windows.iter().any(|w| w.is_visible().ok() != Some(true)) {
            anyhow::ensure!(
                Instant::now() < deadline,
                "closing the board did not restore individual pins"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        json!({"board":content,"size":size,"pinsRestored":true})
    } else {
        let monitor = windows[0]
            .current_monitor()?
            .context("pin monitor missing")?;
        let work = monitor.work_area();
        let area = [
            work.position.x,
            work.position.y,
            work.size.width as i32,
            work.size.height as i32,
        ];
        let deadline = Instant::now() + Duration::from_secs(5);
        let rects = loop {
            let rects = windows
                .iter()
                .map(|w| {
                    let p = w.outer_position()?;
                    let s = w.outer_size()?;
                    Ok([p.x, p.y, s.width as i32, s.height as i32])
                })
                .collect::<tauri::Result<Vec<_>>>()?;
            let inside = rects.iter().all(|r| {
                r[2] > 0
                    && r[3] > 0
                    && r[0] >= area[0]
                    && r[1] >= area[1]
                    && r[0] + r[2] <= area[0] + area[2]
                    && r[1] + r[3] <= area[1] + area[3]
            });
            let (a, b) = (rects[0], rects[1]);
            let overlap = a[0] < b[0] + b[2]
                && b[0] < a[0] + a[2]
                && a[1] < b[1] + b[3]
                && b[1] < a[1] + a[3];
            if inside && !overlap {
                break rects;
            }
            anyhow::ensure!(
                Instant::now() < deadline,
                "native tile geometry invalid: area={area:?}, pins={rects:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        json!({"workArea":area,"pins":rects,"nonoverlapping":true})
    };
    for (path, expected) in &originals {
        anyhow::ensure!(
            image::open(path)?.to_rgba8() == *expected,
            "arrangement changed an original PNG"
        );
    }
    trace.mark("arranged", geometry.clone());
    // Closing one pin must remove only its own file and leave the other usable.
    for (index, window) in windows.iter().enumerate() {
        window.eval("document.querySelector('[data-testid=\"screenshot-pin-close\"]').click()")?;
        trace.mark("closing", json!({"index": index, "label": window.label()}));
        anyhow::ensure!(
            wait_closed(app, window.label(), Duration::from_secs(5)).await,
            "pin did not close"
        );
        trace.mark("closed", json!({"index": index, "label": window.label()}));
        anyhow::ensure!(
            !originals[index].0.exists(),
            "closed pin file was not removed"
        );
        if index == 0 {
            anyhow::ensure!(
                image::open(&originals[1].0)?.to_rgba8() == originals[1].1,
                "closing one pin removed the other original"
            );
        }
    }
    Ok(report(
        true,
        json!({"wayland":wayland,"note":note,"geometry":geometry,"independentOriginals":true,"closed":true}),
    ))
}
