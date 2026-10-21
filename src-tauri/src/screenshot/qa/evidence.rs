use super::*;

pub(super) fn artifact_dir() -> std::path::PathBuf {
    std::env::var("RUNNER_TEMP")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("taomni-qa-artifacts")
}

pub(super) fn evidence_path(name: &str) -> std::path::PathBuf {
    static PROCESS_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let process = PROCESS_ID.get_or_init(|| uuid::Uuid::new_v4().to_string());
    artifact_dir().join(format!(
        "{}-{process}-{}-{name}",
        platform(),
        EVAL_ID.fetch_add(1, Ordering::Relaxed)
    ))
}

/// Best-effort copy of an output into the CI artifact folder.
pub(super) fn keep_artifact(src: &std::path::Path, name: &str) -> Option<String> {
    let dir = artifact_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let dest = evidence_path(name);
    std::fs::copy(src, &dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

pub(super) fn keep_image(image: &RgbaImage, name: &str) -> Option<String> {
    let dir = artifact_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let dest = evidence_path(name);
    image.save(&dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

pub(super) fn report(ok: bool, details: Value) -> String {
    format!("{} {}", if ok { "OK" } else { "FAIL" }, details)
}

pub(super) async fn read_source(window: &WebviewWindow) -> anyhow::Result<SourceEvidence> {
    let value = run_js(
        window,
        "return window.__qaScreenshotSource || null;",
        Duration::from_secs(10),
    )
    .await?;
    serde_json::from_value(value).context("fixture did not retain original pixel evidence")
}

pub(super) fn source_png(data_url: &str) -> anyhow::Result<RgbaImage> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let data = data_url
        .strip_prefix("data:image/png;base64,")
        .context("source evidence is not a PNG")?;
    let bytes = STANDARD
        .decode(data)
        .context("decode original source PNG")?;
    Ok(image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)?.to_rgba8())
}

pub(super) fn keep_json(value: &Value, name: &str) -> anyhow::Result<String> {
    let path = evidence_path(name);
    std::fs::create_dir_all(artifact_dir())?;
    std::fs::write(&path, serde_json::to_vec_pretty(value)?)?;
    Ok(path.to_string_lossy().into_owned())
}

pub(super) fn source_crop_size(source: &SourceEvidence) -> anyhow::Result<(u32, u32)> {
    if !source.scale.is_finite()
        || source.scale <= 0.0
        || (source.css_width * source.scale).round() as u32 != source.width
        || (source.css_height * source.scale).round() as u32 != source.height
    {
        anyhow::bail!("invalid original source geometry");
    }
    let margin = (6.0 * source.scale).round() as u32;
    let width = source.width.checked_sub(margin * 2).filter(|w| *w >= 2);
    let height = source.height.checked_sub(margin * 2).filter(|h| *h >= 2);
    Ok((
        width.context("original source too narrow")?,
        height.context("original source too short")?,
    ))
}

pub(super) fn source_crop(source: &SourceEvidence, image: &RgbaImage) -> anyhow::Result<RgbaImage> {
    if image.dimensions() != (source.width, source.height) {
        anyhow::bail!("original PNG does not match its declared dimensions");
    }
    let (width, height) = source_crop_size(source)?;
    let margin = (6.0 * source.scale).round() as u32;
    Ok(capture::crop(image, margin, margin, width, height))
}

/// Derive the contract from the original geometry, never decoded dimensions.
pub(super) fn record_expected_size(
    source: &SourceEvidence,
    is_mp4: bool,
) -> anyhow::Result<(u32, u32)> {
    let (width, height) = source_crop_size(source)?;
    let cap = if is_mp4 { 1920 } else { 960 };
    let (width, height) = if width > cap {
        (
            cap,
            ((height as f64 * cap as f64 / width as f64).round() as u32).max(2),
        )
    } else {
        (width, height)
    };
    Ok(((width & !1).max(2), (height & !1).max(2)))
}

pub(super) fn source_region(
    source: &SourceEvidence,
    image: &RgbaImage,
    dimensions: (u32, u32),
) -> anyhow::Result<RgbaImage> {
    let crop = source_crop(source, image)?;
    Ok(if crop.dimensions() == dimensions {
        crop
    } else {
        image::imageops::resize(
            &crop,
            dimensions.0,
            dimensions.1,
            image::imageops::FilterType::Triangle,
        )
    })
}

pub(super) fn compare_scroll_original(
    actual: &RgbaImage,
    source: &SourceEvidence,
) -> anyhow::Result<Value> {
    if source.kind != "scroll" {
        anyhow::bail!("expected original scroll page");
    }
    let original = source_png(
        source
            .data_url
            .as_deref()
            .context("missing original page PNG")?,
    )?;
    let expected = source_crop(source, &original)?;
    let comparison = qa_oracle::compare(actual, &expected, false);
    let source_artifact =
        keep_image(&original, "scroll-original-full.png").context("save full source page")?;
    let expected_artifact =
        keep_image(&expected, "scroll-expected.png").context("save expected scroll crop")?;
    let difference = keep_image(
        &qa_oracle::difference(actual, &expected),
        "scroll-difference.png",
    )
    .context("save scroll difference")?;
    Ok(
        json!({"passed":comparison.passed,"comparison":comparison,"sourceArtifact":source_artifact,
        "expectedArtifact":expected_artifact,"differenceArtifact":difference,"sourceSize":[source.width,source.height],
        "cssSize":[source.css_width,source.css_height],"scale":source.scale}),
    )
}

pub(super) fn compare_record_original(
    path: &std::path::Path,
    source: &SourceEvidence,
) -> anyhow::Result<(super::super::record::ClipInfo, Value)> {
    if source.kind != "anim" || source.frames.is_empty() {
        anyhow::bail!("missing drawn animation originals");
    }
    let expected_size = record_expected_size(
        source,
        path.extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("mp4")),
    )?;
    let source_manifest = keep_json(
        &json!({"kind":source.kind,"nonce":source.nonce,"scale":source.scale,
        "dimensions":[source.width,source.height],"expectedSize":expected_size,"frameIntervalMs":source.frame_interval_ms,"frames":source.frames.iter().map(|f|json!({"id":f.id,"atMs":f.at_ms})).collect::<Vec<_>>()}),
        "record-original-timeline.json",
    )?;
    // Save references before decoding so corrupt or unidentified output still
    // leaves evidence that can be inspected without regenerating the scene.
    let mut originals = Vec::new();
    for original in &source.frames {
        let image = source_png(&original.data_url)?;
        let artifact = keep_image(&image, &format!("record-original-{}.png", original.id))
            .context("save original frame")?;
        originals.push(json!({"id":original.id,"atMs":original.at_ms,"artifact":artifact}));
    }
    let mut observations = Vec::new();
    let mut pairs = Vec::new();
    let mut matched_ids = std::collections::HashSet::new();
    let mut previous = None;
    let mut failures = 0u32;
    let mut undecodable = 0u32;
    let mut timeline = qa_oracle::Timeline::with_source_frame_times(
        &source
            .frames
            .iter()
            .map(|frame| frame.at_ms)
            .collect::<Vec<_>>(),
        source
            .frame_interval_ms
            .context("missing source animation cadence")?,
    );
    let source_size = (source.css_width - 12.0, source.css_height - 12.0);
    let inspected = super::super::record::inspect_clip_frames(path, &mut |image, at_ms| {
        let id = qa_oracle::decode_code(image, source_size, 12, 64.0);
        let nonce = qa_oracle::decode_code(image, source_size, 16, 112.0);
        let original_index =
            id.and_then(|id| source.frames.iter().position(|frame| frame.id == id));
        let original = original_index.map(|i| &source.frames[i]);
        let visible_until = original_index
            .and_then(|i| source.frames.get(i + 1))
            .map(|f| f.at_ms);
        let ordered = previous.zip(id).is_none_or(|(last, now)| now >= last);
        let mut comparison = None;
        let matched = if let Some(original) = original {
            let raw = source_png(&original.data_url)?;
            let expected = source_region(source, &raw, expected_size)?;
            let result = qa_oracle::compare(image, &expected, true);
            let timing = timeline.observe(
                at_ms,
                original.at_ms,
                visible_until.unwrap_or(original.at_ms),
            );
            let passed = result.passed && nonce == Some(source.nonce) && ordered && timing;
            if pairs.len() < 8 {
                pairs.push((image.clone(), expected.clone()));
            }
            if passed {
                matched_ids.insert(original.id);
            }
            comparison = Some(result);
            passed
        } else {
            false
        };
        if !matched {
            failures += 1;
            // A frame captured while the animated source was repainting carries
            // neither the id nor the nonce. One such transitional frame is a
            // capture-timing artifact, not a lost or frozen recording; keep
            // every frame that does decode strict.
            if id.is_none() && nonce.is_none() {
                undecodable += 1;
            }
        }
        if id.is_some() {
            previous = id;
        }
        let actual_artifact =
            keep_image(image, &format!("record-decoded-{}.png", observations.len()))
                .context("save decoded frame")?;
        observations.push(json!({"decodedFrame":observations.len(),"atMs":at_ms,"sourceId":id,"nonce":nonce,
            "originalAtMs":original.map(|f|f.at_ms),"originalVisibleUntilMs":visible_until,"ordered":ordered,"matchedOriginal":matched,"comparison":comparison,"actualArtifact":actual_artifact}));
        Ok(())
    });
    let checks = keep_json(
        &json!({"frames":observations,"drawnOriginals":originals,"expectedSize":expected_size,"decodeError":inspected.as_ref().err().map(|e|format!("{e:#}"))}),
        "record-pixel-comparison.json",
    )?;
    let clip = inspected?;
    let mut contact = RgbaImage::new(320 * 3, 200 * pairs.len() as u32);
    for (row, (actual, expected)) in pairs.iter().enumerate() {
        let difference = qa_oracle::difference(actual, expected);
        for (col, image) in [expected, actual, &difference].iter().enumerate() {
            let thumb =
                image::imageops::resize(*image, 320, 200, image::imageops::FilterType::Triangle);
            image::imageops::replace(&mut contact, &thumb, col as i64 * 320, row as i64 * 200);
        }
    }
    let contact_artifact = if pairs.is_empty() {
        None
    } else {
        keep_image(&contact, "record-original-actual-difference.png")
    };
    let timeline_ok = timeline.complete(clip.duration_ms);
    // One undecodable transitional frame is tolerated (see the failure count);
    // every decodable frame must still match its drawn original exactly.
    let transitional_ok = failures == 0 || (failures == 1 && undecodable == 1);
    let passed =
        transitional_ok && matched_ids.len() >= 4 && timeline_ok && contact_artifact.is_some();
    Ok((
        clip,
        json!({"passed":passed,"mismatchedFrames":failures,"matchedDistinctOriginals":matched_ids.len(),"expectedSize":expected_size,
        "nonce":source.nonce,"timelineMatches":timeline_ok,"worstTimelineDriftMs":timeline.worst_drift_ms,"longestFrameGapMs":timeline.longest_gap_ms,"longestUnexplainedGapMs":timeline.longest_unexplained_gap_ms,
        "longestSourcePauseMs":timeline.longest_source_pause_ms,"sourceFrameIntervalMs":source.frame_interval_ms,"undecodableFrames":undecodable,
        "sourceTimeline":source_manifest,"comparisonArtifact":checks,"contactArtifact":contact_artifact}),
    ))
}

pub(super) fn decode_row(px: [u8; 4]) -> Option<u32> {
    if px[2] < 160 {
        return None;
    }
    let r = ((px[0] as f64 - 30.0) / ROW_STEP).round();
    let g = ((px[1] as f64 - 30.0) / ROW_STEP).round();
    if !(0.0..8.0).contains(&r) || !(0.0..8.0).contains(&g) {
        return None;
    }
    // Reject pixels far from any code (anti-aliased edges, text).
    let er = (px[0] as f64 - (30.0 + r * ROW_STEP)).abs();
    let eg = (px[1] as f64 - (30.0 + g * ROW_STEP)).abs();
    (er <= 9.0 && eg <= 9.0).then_some((g * 8.0 + r) as u32)
}

/// Runs of decoded row indices down column `x`: `(index, run_length)`.
pub(super) fn row_runs(image: &RgbaImage, x: u32) -> Vec<(u32, u32)> {
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for y in 0..image.height() {
        let Some(index) = decode_row(image.get_pixel(x, y).0) else {
            continue;
        };
        match runs.last_mut() {
            Some((last, len)) if *last == index => *len += 1,
            _ => runs.push((index, 1)),
        }
    }
    // Drop single-pixel noise runs.
    runs.retain(|(_, len)| *len >= 3);
    runs
}
