//! P1-1: real native resident WebView reuse with generation-scoped cleanup.

use super::*;

struct ResidentCleanup(AppHandle);
impl Drop for ResidentCleanup {
    fn drop(&mut self) {
        super::super::close_session(&self.0);
        let _ = super::super::overlay_resident::discard_idle(&self.0);
    }
}

async fn wait_idle(app: &AppHandle, window: &WebviewWindow) -> anyhow::Result<Value> {
    // Idle deliberately has an empty React root; run_js's mounted-document
    // precondition is therefore inappropriate. Observe the actual teardown.
    let deadline = Instant::now() + Duration::from_secs(5);
    let empty = loop {
        let state = eval_raw(window,
            "document.readyState === 'complete' && !document.querySelector('[data-testid=\"screenshot-overlay\"]')".into(),
            Duration::from_millis(300)).await;
        if state == Some(json!(true)) {
            break true;
        }
        if Instant::now() >= deadline {
            break false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let state = json!({"empty":empty});
    let deadline = Instant::now() + Duration::from_secs(5);
    while (window.is_visible()? || !main_visible(app)) && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let (overlay, lease, hidden, scroll, recording) = {
        let state = super::super::tool_state();
        (
            state.overlay.is_some(),
            state.session_lease.is_some(),
            !state.hidden.is_empty(),
            state.scroll.is_some(),
            state.recording.is_some(),
        )
    };
    let lease_available = super::super::session::SessionLease::acquire()
        .map_err(anyhow::Error::msg)?
        .is_some();
    let evidence = json!({"empty":state["empty"], "visible":window.is_visible()?,
        "mainRestored":main_visible(app), "payloadRetained":overlay, "leaseRetained":lease,
        "hiddenRetained":hidden, "scrollActive":scroll, "recordingActive":recording,
        "leaseAvailable":lease_available});
    anyhow::ensure!(
        state["empty"] == true
            && !window.is_visible()?
            && main_visible(app)
            && !overlay
            && !lease
            && !hidden
            && !scroll
            && !recording
            && lease_available,
        "resident close did not release session ownership: {evidence}"
    );
    Ok(evidence)
}

#[tauri::command]
pub async fn screenshot_qa_resident_overlay(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let mut trace = ScenarioTrace::new("resident-overlay-phases.json");
    trace.mark("begin", json!({}));
    let _cleanup = ScenarioCleanup(app.clone());
    let _resident_cleanup = ResidentCleanup(app.clone());
    let profile = super::super::startup_profile::StartupProfile {
        reuse_window: true,
        ..super::super::startup_profile::StartupProfile::OPTIMIZED
    };
    let _profile = super::super::startup_profile::QaProfile::install(profile);
    super::super::close_session(&app);
    trace.mark("closed-previous", json!({}));
    super::super::overlay_resident::discard_idle(&app)?;
    trace.mark("discarded-previous", json!({}));
    if !wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await {
        return Err("previous screenshot did not close".into());
    }
    // Warm only an empty hidden WebView, then prove that no permission,
    // artifact or cross-process lease was consumed before the first click.
    super::super::prewarm(&app);
    let deadline = Instant::now() + Duration::from_secs(8);
    let prewarmed = loop {
        if let Some(window) = app.get_webview_window(super::super::OVERLAY_LABEL) {
            if super::super::overlay_resident::is_idle() {
                break window;
            }
        }
        if Instant::now() >= deadline {
            return Err("hidden overlay prewarm did not complete".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let warm_idle = wait_idle(&app, &prewarmed)
        .await
        .map_err(|e| format!("prewarm: {e:#}"))?;
    trace.mark("prewarmed-empty", warm_idle.clone());
    let mut rounds = Vec::new();
    let outcome = async {
        let mut first_identity = None;
        let mut previous_generation = None;
        for index in 0..3 {
            trace.mark("before-open", json!({"index":index}));
            let main = app.get_webview_window("main").context("main unavailable")?;
            super::super::screenshot_open_overlay(app.clone(), main, None, None)
                .await.map_err(anyhow::Error::msg)?;
            let window = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await?;
            let init = super::super::screenshot_overlay_init().await.map_err(anyhow::Error::msg)?;
            if let Some(stale) = init.generation.checked_sub(1) {
                super::super::screenshot_close_overlay(app.clone(), Some(stale))
                    .await.map_err(anyhow::Error::msg)?;
                anyhow::ensure!(super::super::tool_state().overlay.as_ref()
                    .is_some_and(|active| active.generation == init.generation),
                    "stale close ended the new screenshot generation");
            }
            let script = format!(r#"
                for (let i=0;i<100 && document.querySelector('[data-testid="screenshot-overlay"]')?.dataset.phase!=='select';i++) await new Promise(r=>setTimeout(r,25));
                const q = id => document.querySelector('[data-testid="'+id+'"]');
                const shapes=q('screenshot-annotation-canvas')?.dataset.shapes;
                if(q('screenshot-overlay')?.dataset.phase!=='select' || q('screenshot-selection') || (shapes && shapes!=='0')) throw new Error('new generation retained selection or annotations: '+JSON.stringify({{phase:q('screenshot-overlay')?.dataset.phase,selection:!!q('screenshot-selection'),shapes}}));
                const image=q('screenshot-base-image');
                if(!image?.complete || !image.naturalWidth) throw new Error('new generation has no decoded bitmap');
                window.__qaResidentIdentity ??= crypto.randomUUID();
                const identity=window.__qaResidentIdentity;
                const layer=q('screenshot-select-layer');
                const fire=(el,type,x,y)=>el.dispatchEvent(new MouseEvent(type,{{bubbles:true,button:0,clientX:x,clientY:y}}));
                fire(layer,'mousedown',80,90); await new Promise(r=>setTimeout(r,20));
                fire(window,'mousemove',280,240); fire(window,'mouseup',280,240); await new Promise(r=>setTimeout(r,50));
                if(!q('screenshot-selection')) throw new Error('selection unavailable');
                q('screenshot-tool-rect').click(); await new Promise(r=>setTimeout(r,30));
                fire(q('screenshot-annotation-layer'),'mousedown',110,120);
                await new Promise(r=>setTimeout(r,30));
                fire(q('screenshot-annotation-layer'),'mousemove',180,180);
                await new Promise(r=>setTimeout(r,30));
                fire(window,'mouseup',180,180);
                await new Promise(r=>setTimeout(r,50));
                if(q('screenshot-annotation-canvas')?.dataset.shapes!=='1') throw new Error('annotation unavailable');
                return {{identity, generation:{generation}, naturalWidth:image.naturalWidth, naturalHeight:image.naturalHeight, phase:q('screenshot-overlay').dataset.phase}};
            "#, generation=init.generation);
            trace.mark("opened", json!({"index":index}));
            let view = run_js(&window, &script, Duration::from_secs(6)).await?;
            trace.mark("annotated", json!({"index":index,"view":view}));
            if let Some(identity) = &first_identity {
                anyhow::ensure!(&view["identity"] == identity, "resident WebView was recreated");
            } else { first_identity = Some(view["identity"].clone()); }
            if let Some(previous) = previous_generation {
                anyhow::ensure!(init.generation > previous, "session generation did not advance");
            }
            previous_generation = Some(init.generation);
            let notes = super::super::startup_timing::snapshot().notes;
            anyhow::ensure!(notes.get("windowReused") == Some(&json!(true)), "prewarmed/resident native window was rebuilt");
            anyhow::ensure!(notes.get("readyBeforeShow") == Some(&json!(true)), "resident frame was shown before readiness");
            let path = init.path.clone();
            if index == 1 {
                // Real CloseRequested must retire the session as safely as the
                // IPC close. No new close handlers accumulate between rounds.
                window.close()?;
            } else {
                super::super::close_session(&app);
            }
            trace.mark("close-requested", json!({"index":index}));
            let idle = wait_idle(&app, &window).await?;
            trace.mark("idle", json!({"index":index,"idle":idle}));
            anyhow::ensure!(!std::path::Path::new(&path).exists(), "retired screenshot artifact was not purged");
            rounds.push(json!({"index":index, "view":view, "idle":idle,
                "windowReused":notes.get("windowReused").cloned().unwrap_or(json!(false)), "readyBeforeShow":notes.get("readyBeforeShow"),
                "artifactPurged":true}));
        }
        // Keep original controls/scroll/recorder and mixed-DPI acceptance in
        // their existing cases; this scenario proves the resident owner itself.
        Ok::<_, anyhow::Error>(())
    }.await;
    trace.mark("finished", json!({"ok":outcome.is_ok()}));
    let passed = outcome.is_ok() && rounds.len() == 3;
    Ok(report(
        passed,
        json!({"scenario":"resident-overlay", "prewarm":warm_idle, "rounds":rounds,
        "error":outcome.err().map(|error| format!("{error:#}"))}),
    ))
}
