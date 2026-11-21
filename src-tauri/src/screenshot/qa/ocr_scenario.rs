use super::*;

/// Real OCR and automatic-redaction UI over a native text fixture.
#[tauri::command]
pub async fn screenshot_qa_ocr_redact(
    app: AppHandle,
    expect_disabled: Option<bool>,
    expect_offline: Option<bool>,
) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    let (_fixture, display, region) = open_fixture(&app, "ocr")
        .await
        .map_err(|e| format!("{e:#}"))?;
    let source = super::super::screenshot_capture_region(
        app.clone(),
        Some(display.id.clone()),
        region.0,
        region.1,
        region.2,
        region.3,
    )
    .await?;
    if expect_offline == Some(true) {
        return signed_offline_ocr(&app, &source.path).await;
    }
    let ocr = super::super::screenshot_ocr(source.path.clone(), app.state()).await;
    let boxes = super::super::screenshot_auto_redact(source.path.clone(), app.state()).await;
    if expect_disabled == Some(true) {
        let probe = super::super::screenshot_probe(app.state()).await?;
        let expected = super::super::ocr::MODULE_UNAVAILABLE;
        let artifact = keep_artifact(
            std::path::Path::new(&source.path),
            "ocr-disabled-capture.png",
        );
        let recognition_error = ocr.err();
        let redaction_error = boxes.err();
        let ok = artifact.is_some()
            && recognition_error.as_deref() == Some(expected)
            && redaction_error.as_deref() == Some(expected)
            && !probe.ocr_available
            && probe.ocr_hint.as_deref() == Some(expected);
        return Ok(report(
            ok,
            json!({"artifact":artifact,"recognitionError":recognition_error,"redactionError":redaction_error,"probe":probe}),
        ));
    }
    let (ocr, boxes) = (ocr?, boxes?);
    let ocr_ok = ocr.text.contains("user@example.com") && ocr.text.contains("13812345678");
    let boxes_ok = boxes.boxes.iter().any(|b| b.kind == "email")
        && boxes.boxes.iter().any(|b| b.kind == "phone")
        && !boxes.boxes.iter().any(|b| b.kind == "id");
    let source_artifact = keep_artifact(std::path::Path::new(&source.path), "ocr-source.png");
    super::super::open_overlay(&app, Some(display.id)).await?;
    let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let body = format!(
        r#"
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const q = id => document.querySelector('[data-testid="' + id + '"]');
      const exports = {{}};
      let phase = null;
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      const geometry = () => ({{
        viewport: [innerWidth, innerHeight],
        image: [q('screenshot-base-image')?.naturalWidth, q('screenshot-base-image')?.naturalHeight],
        selectionSize: q('screenshot-size-hint')?.textContent,
        selectionStyle: q('screenshot-selection')?.getAttribute('style'),
      }});
      // Observe the exact PNG returned to saveDataUrl without replacing IPC,
      // changing its pixels, adding a redraw or retrying recognition.
      HTMLCanvasElement.prototype.toDataURL = function(...args) {{
        const dataUrl = toDataURL.apply(this, args);
        if (phase) exports[phase] = {{dataUrl, canvasSize: [this.width, this.height], geometry: geometry()}};
        return dataUrl;
      }};
      try {{
      for (let i=0;i<100 && !(q('screenshot-base-image') && q('screenshot-base-image').complete);i++) await sleep(100);
      const image = q('screenshot-base-image');
      const sx = image.naturalWidth / innerWidth, sy = image.naturalHeight / innerHeight;
      const fire = (type,x,y) => q('screenshot-select-layer').dispatchEvent(new MouseEvent(type, {{bubbles:true,button:0,clientX:x,clientY:y}}));
      fire('mousedown', {x}/sx, {y}/sy);
      fire('mouseup', ({x}+{w})/sx, ({y}+{h})/sy);
      for(let i=0;i<40 && !q('screenshot-toolbar');i++) await sleep(100);
      phase = 'ocr';
      q('screenshot-ocr').click();
      for(let i=0;i<150 && !(q('screenshot-ocr-text') && q('screenshot-ocr-text').value.includes('user@example.com'));i++) await sleep(100);
      const text = q('screenshot-ocr-text')?.value || '';
      q('screenshot-ocr-close').click();
      phase = 'redact';
      q('screenshot-auto-redact').click();
      for(let i=0;i<150 && !(Number(q('screenshot-annotation-canvas').getAttribute('data-shapes')) >= 2 && !q('screenshot-undo').disabled);i++) await sleep(100);
      const count = Number(q('screenshot-annotation-canvas').getAttribute('data-shapes'));
      q('screenshot-undo').click(); await sleep(150);
      const afterUndo = Number(q('screenshot-annotation-canvas').getAttribute('data-shapes'));
      q('screenshot-redo').click(); await sleep(150);
      const afterRedo = Number(q('screenshot-annotation-canvas').getAttribute('data-shapes'));
      return {{text,count,afterUndo,afterRedo,exports}};
      }} catch (error) {{
        return {{error: String(error), exports, geometry: geometry()}};
      }} finally {{ HTMLCanvasElement.prototype.toDataURL = toDataURL; }}
    "#,
        x = region.0,
        y = region.1,
        w = region.2,
        h = region.3
    );
    let mut page = run_js(&overlay, &body, Duration::from_secs(45))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let inputs_retained = retain_ocr_inputs(&mut page);
    overlay
        .eval("document.querySelector('[data-testid=\"screenshot-copy\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    let clipboard = read_clipboard_image(&app).map_err(|e| format!("{e:#}"))?;
    let artifact = keep_image(&clipboard, "ocr-redacted.png");
    let original = image::open(
        &source_artifact
            .clone()
            .ok_or("OCR source evidence missing")?,
    )
    .map_err(|e| e.to_string())?
    .to_rgba8();
    let changed = original.dimensions() == clipboard.dimensions()
        && original
            .pixels()
            .zip(clipboard.pixels())
            .filter(|(a, b)| a != b)
            .count()
            >= 50;
    let count = page["count"].as_u64().unwrap_or(0);
    let ok = ocr_ok
        && boxes_ok
        && page["text"]
            .as_str()
            .is_some_and(|s| s.contains("user@example.com"))
        && count >= 2
        && page["afterUndo"] == json!(0)
        && page["afterRedo"] == json!(count)
        && closed
        && main_visible(&app)
        && changed
        && inputs_retained
        && artifact.is_some();
    Ok(report(
        ok,
        json!({"ocr":ocr,"boxes":boxes,"page":page,"inputsRetained":inputs_retained,"pixelsChanged":changed,"overlayClosed":closed,
        "sourceArtifact":source_artifact,"artifact":artifact}),
    ))
}

async fn signed_offline_ocr(app: &AppHandle, path: &str) -> Result<String, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};

    let state = app.state::<crate::state::AppState>();
    let module = state
        .plugins
        .get(taomni_screenshot_api::SLUG)
        .filter(|record| record.state == crate::plugin::LifecycleState::Enabled)
        .ok_or("Enable the signed Screenshot module before verifying offline recognition")?;
    let entry = module
        .manifest
        .entry
        .frontend
        .ok_or("Missing signed OCR renderer")?;
    let route = format!(
        "/__taomni_plugins__/screenshot/{}/{}",
        module.manifest.version, entry
    );
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let data = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
    let main = app
        .get_webview_window("main")
        .ok_or("Missing native main window")?;
    let script = format!(
        r#"
      const entry = new URL({route}, location.href).href;
      const renderer = await import(entry);
      return await renderer.recognizeOffline({data}, new URL('screenshot-ocr/', entry).href);
    "#,
        route = json!(route),
        data = json!(data)
    );
    let result = run_js(&main, &script, Duration::from_secs(105))
        .await
        .map_err(|error| format!("{error:#}"))?;
    let recognized = result["text"]
        .as_str()
        .is_some_and(|text| text.contains("user@example.com"));
    let tsv = result["tsv"]
        .as_str()
        .ok_or("Missing offline OCR word geometry")?;
    let sensitive = super::super::screenshot_redact_tsv(tsv.to_owned(), state).await?;
    let email_box = sensitive
        .boxes
        .iter()
        .any(|item| item.kind == "email" && item.w > 0 && item.h > 0);
    Ok(report(
        recognized && email_box && result["langs"] == json!("bundled:eng+chi_sim"),
        json!({"recognition":result,"redaction":sensitive}),
    ))
}

/// Retain the canvas output sent to saveDataUrl for each UI action. A direct
/// fixture capture alone cannot diagnose a bad crop or empty renderer export.
fn retain_ocr_inputs(page: &mut Value) -> bool {
    let Some(exports) = page["exports"].as_object_mut() else {
        return false;
    };
    let mut retained = 0;
    for (phase, export) in exports.iter_mut() {
        let Some(data_url) = export.as_object_mut().and_then(|e| e.remove("dataUrl")) else {
            continue;
        };
        let result = (|| -> anyhow::Result<Value> {
            let image = source_png(
                data_url
                    .as_str()
                    .context("page OCR input is not a string")?,
            )?;
            let artifact = keep_image(&image, &format!("{phase}-page-input.png"))
                .context("retain page OCR input")?;
            retained += 1;
            Ok(json!({"artifact":artifact,"size":[image.width(),image.height()]}))
        })();
        export["input"] = match result {
            Ok(input) => input,
            Err(error) => json!({"error":format!("{error:#}")}),
        };
    }
    retained == 2 && exports.contains_key("ocr") && exports.contains_key("redact")
}
