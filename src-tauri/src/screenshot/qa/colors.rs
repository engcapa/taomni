use super::*;

#[tauri::command]
pub async fn screenshot_qa_colors(app: AppHandle) -> Result<String, String> {
    ensure_qa(&app)?;
    let _cleanup = ScenarioCleanup(app.clone());
    super::super::open_overlay(&app, None).await?;
    let overlay = wait_window(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10))
        .await
        .map_err(|e| e.to_string())?;
    let marks = run_js(&overlay, r#"
      const q=id=>document.querySelector('[data-testid="'+id+'"]');
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      for(let i=0;i<100 && !q('screenshot-hint');i++) await wait(100);
      const fire=(el,type,x,y)=>el.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,buttons:type==='mouseup'?0:1,clientX:x,clientY:y}));
      fire(q('screenshot-select-layer'),'mousedown',100,100);
      fire(window,'mousemove',500,400); fire(window,'mouseup',500,400); await wait(150);
      q('screenshot-tool-line').click(); q('screenshot-line-width-4').click(); await wait(100);
      const colors=[['orange',[250,140,22]],['cyan',[19,194,194]],['purple',[114,46,209]],['pink',[235,47,150]],['gray',[140,140,140]],['black',[0,0,0]],['custom',[18,52,86]]];
      for(let i=0;i<colors.length;i++) {
        const name=colors[i][0];
        if(name==='custom') {
          const input=q('screenshot-color-hex');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#123456');
          input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
        } else q('screenshot-color-'+name).click();
        await wait(70);
        const y=140+i*28, el=q('screenshot-annotation-layer');
        fire(el,'mousedown',140,y); fire(window,'mousemove',300,y); fire(window,'mouseup',360,y); await wait(80);
      }
      const img=q('screenshot-base-image');
      return {count:Number(q('screenshot-annotation-canvas').dataset.shapes),sx:img.naturalWidth/innerWidth,sy:img.naturalHeight/innerHeight,colors};
    "#, Duration::from_secs(20)).await.map_err(|e| e.to_string())?;
    overlay
        .eval("document.querySelector('[data-testid=\"screenshot-copy\"]').click()")
        .map_err(|e| e.to_string())?;
    let closed = wait_closed(&app, super::super::OVERLAY_LABEL, Duration::from_secs(10)).await;
    let image = read_clipboard_image(&app).map_err(|e| e.to_string())?;
    let sx = marks["sx"].as_f64().ok_or("missing x scale")?;
    let sy = marks["sy"].as_f64().ok_or("missing y scale")?;
    let colors: [[u8; 3]; 7] = [
        [250, 140, 22],
        [19, 194, 194],
        [114, 46, 209],
        [235, 47, 150],
        [140, 140, 140],
        [0, 0, 0],
        [18, 52, 86],
    ];
    let mut pixels = Vec::new();
    let mut matched = true;
    for (i, expected) in colors.into_iter().enumerate() {
        let x = (100.0 * sx).round() as u32;
        let y = ((40.0 + i as f64 * 28.0) * sy).round() as u32;
        let actual = image
            .get_pixel(x.min(image.width() - 1), y.min(image.height() - 1))
            .0;
        let passed = actual[..3] == expected && actual[3] == 255;
        matched &= passed;
        pixels.push(json!({"expected":expected,"actual":actual,"at":[x,y],"passed":passed}));
    }
    let artifact = keep_image(&image, "annotation-expanded-colors.png");
    Ok(report(
        closed && marks["count"] == 7 && matched && artifact.is_some(),
        json!({"renderer":marks,"nativeClipboardPixels":pixels,"closed":closed,"artifact":artifact}),
    ))
}
