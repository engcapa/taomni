//! Explicit, local-only benchmark probe. Never part of application startup.
//! Invoked by scripts/asr-bench/bench.py through the ignored test executable.
use super::{catalog, manager::AsrManager};
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

#[tokio::test]
#[ignore = "requires an explicit PCM path, result path and installed pinned weights"]
async fn decode_fixture() {
    let input = std::env::var("TAOMNI_ASR_BENCH_PCM").expect("TAOMNI_ASR_BENCH_PCM");
    let output = std::env::var("TAOMNI_ASR_BENCH_RESULT").expect("TAOMNI_ASR_BENCH_RESULT");
    let model_id =
        std::env::var("TAOMNI_ASR_BENCH_MODEL").unwrap_or_else(|_| "whisper-base".into());
    let language = std::env::var("TAOMNI_ASR_BENCH_LANGUAGE").unwrap_or_else(|_| "auto".into());
    let model = catalog::model(&model_id).expect("catalog model");
    let bytes = std::fs::read(input).expect("read PCM");
    assert!(!bytes.is_empty() && bytes.len() % 4 == 0 && bytes.len() <= 120 * 64_000);
    let pcm: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
        .collect();
    assert!(pcm.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
    let engine = AsrManager::configured(&model_id, &language);
    let start = Instant::now();
    engine.prepare().await.expect("load pinned model");
    let cold_load_ms = start.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let text = match engine
        .transcribe(pcm, Arc::new(AtomicBool::new(false)))
        .await
    {
        Ok(text) => text,
        Err(error) if error.starts_with("NO_SPEECH:") => String::new(),
        Err(error) => panic!("decode: {error}"),
    };
    let inference_ms = start.elapsed().as_secs_f64() * 1000.0;
    let result = serde_json::json!({
        "text": text,
        "engine": model_id,
        "quantization": if model_id == "sensevoice-small" { "int8" } else if model_id.ends_with("-q8") { "q8_0" } else if model_id.ends_with("-q5") { "q5_0" } else { "f16" },
        "model_sha256": model.sha256,
        "threads": std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2),
        "cold_load_ms": cold_load_ms,
        "inference_ms": inference_ms,
        "first_partial_ms": null,
        "endpoint_to_final_ms": null,
        "peak_rss_bytes": peak_rss_bytes(),
    });
    std::fs::write(output, serde_json::to_vec_pretty(&result).unwrap())
        .expect("write benchmark result");
}

fn peak_rss_bytes() -> Option<u64> {
    // Linux's high-water mark, not a sampled current RSS. Other hosts must add
    // a native equivalent; an unavailable measurement remains null, never zero.
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        let value = line.strip_prefix("VmHWM:")?.split_whitespace().next()?;
        value.parse::<u64>().ok()?.checked_mul(1024)
    })
}
