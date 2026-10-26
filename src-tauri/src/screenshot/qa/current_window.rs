//! Current-window menu and modal shortcut through the real Windows WebView.
use super::*;

#[tauri::command]
pub async fn screenshot_qa_current_window(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::close_session(&app);
    let main = app.get_webview_window("main").ok_or("main unavailable")?;
    main.show().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())?;
    let mut attempts = Vec::new();
    for modal in [false, true] {
        run_js(
            &main,
            if modal {
                r#"
            const q=id=>document.querySelector('[data-testid="'+id+'"]');
            q('side-tab-sessions').click();
            for(let i=0;i<100&&!q('session-new');i++) await new Promise(r=>setTimeout(r,50));
            if(!q('session-new')) throw new Error('Sessions new-session control missing');
            q('session-new').click();
            for(let i=0;i<100&&!q('session-host');i++) await new Promise(r=>setTimeout(r,50));
            const input=q('session-host');
            if(!input || !q('session-editor')) throw new Error('session modal missing');
            input.focus();
            if(document.activeElement!==input) throw new Error('modal input lacks focus');
            return true;
        "#
            } else {
                r#"
            document.querySelector('[data-testid="system-screenshot-delay-toggle"]').click();
            await new Promise(r=>setTimeout(r,100));
            document.querySelector('[data-testid="system-screenshot-current-window"]').click();
            return true;
        "#
            },
            Duration::from_secs(10),
        )
        .await
        .map_err(|e| e.to_string())?;
        let mut reference = None;
        if modal {
            // Keep the cursor on the invoking display before the production capture lookup.
            let pos = main.inner_position().map_err(|e| e.to_string())?;
            let scale = main.scale_factor().map_err(|e| e.to_string())?;
            park_pointer(input_point((pos.x + 40, pos.y + 80), scale))
                .await
                .map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_millis(250)).await;
            let display = capture::display_at_cursor(&app).map_err(|e| e.to_string())?;
            reference = Some(capture::capture_display(&app, &display).map_err(|e| e.to_string())?);
            tokio::task::spawn_blocking(|| -> Result<(), String> {
                use enigo::{Direction, Enigo, Key, Keyboard, Settings};
                let mut input = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
                input
                    .key(Key::Alt, Direction::Press)
                    .map_err(|e| e.to_string())?;
                let result = input
                    .key(Key::Unicode('a'), Direction::Click)
                    .map_err(|e| e.to_string());
                let release = input
                    .key(Key::Alt, Direction::Release)
                    .map_err(|e| e.to_string());
                result.and(release)
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(15))
            .await
            .map_err(|e| e.to_string())?;
        let selection = run_js(&overlay, r#"
            const q=id=>document.querySelector('[data-testid="'+id+'"]');
            for(let i=0;i<150&&q('screenshot-overlay')?.dataset.phase!=='select';i++) await new Promise(r=>setTimeout(r,50));
            if(q('screenshot-overlay')?.dataset.phase!=='select'||q('screenshot-selection')||q('screenshot-toolbar'))
                throw new Error('current-window capture did not start unselected');
            const layer=q('screenshot-select-layer');
            const fire=(type,x,y)=>layer.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
            fire('mousedown',120,130); fire('mousemove',420,350); fire('mouseup',420,350);
            await new Promise(r=>setTimeout(r,100));
            const rect=q('screenshot-selection')?.getBoundingClientRect();
            if(!rect||Math.abs(rect.x-120)>1||Math.abs(rect.y-130)>1||Math.abs(rect.width-300)>1||Math.abs(rect.height-220)>1)
                throw new Error('manual selection geometry incorrect');
            return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
        "#, Duration::from_secs(15)).await.map_err(|e| e.to_string())?;
        let init = super::super::screenshot_overlay_init().await?;
        let artifact = keep_artifact(
            std::path::Path::new(&init.path),
            if modal {
                "modal-shortcut-capture.png"
            } else {
                "current-window-menu.png"
            },
        );
        let visible = main_visible(&app);
        let modal_preserved = if modal {
            run_js(
                &main,
                "return !!document.querySelector('[data-testid=\"session-editor\"]');",
                Duration::from_secs(5),
            )
            .await
            .map_err(|e| e.to_string())?
                == json!(true)
        } else {
            true
        };
        let mut pixel_difference = None;
        if let Some(reference) = reference {
            let captured = image::open(&init.path)
                .map_err(|e| e.to_string())?
                .to_rgba8();
            let region = init.window_region.ok_or("window bounds missing")?;
            if reference.dimensions() != captured.dimensions() {
                return Err("capture dimensions changed".into());
            }
            let mut total = 0u64;
            for y in region.y..region.y + region.height {
                for x in region.x..region.x + region.width {
                    for channel in 0..3 {
                        total += reference.get_pixel(x, y)[channel]
                            .abs_diff(captured.get_pixel(x, y)[channel])
                            as u64;
                    }
                }
            }
            let difference = total as f64 / (region.width as f64 * region.height as f64 * 3.0);
            if difference > 3.0 {
                return Err(format!(
                    "modal capture differs from visible window: {difference}"
                ));
            }
            pixel_difference = Some(difference);
            keep_image(&reference, "modal-before-shortcut.png");
        }
        // Two Escapes: reset the manually drawn selection, then close.
        for _ in 0..2 {
            os_stop_input(false).await.map_err(|e| e.to_string())?;
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(5)).await;
        attempts.push(json!({"entry":if modal {"Alt+A in modal input"} else {"menu"},"selection":selection,
            "mainVisible":visible,"modalPreserved":modal_preserved,"pixelDifference":pixel_difference,
            "artifact":artifact,"closed":closed,"passed":visible&&modal_preserved&&closed&&artifact.is_some()}));
    }
    Ok(report(
        attempts.iter().all(|a| a["passed"] == json!(true)),
        json!({"attempts":attempts,"input":os_input_transport()}),
    ))
}
