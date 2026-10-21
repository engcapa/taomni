use super::audio::audio_capture;
use super::audio::host_play;
use super::audio::host_record;
use super::audio::mic_send;
use super::autodetection::autodetect;
use super::clipboard_receive::clipboard_receive;
use super::clipboard_send::clipboard_send;
use super::images::image_digest;
use super::images::image_make;
use super::latency::latency;
use super::readiness::connect;
use super::readiness::wait_ready;
use super::throughput::throughput;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use serde_json::Value;
use serde_json::json;
use std::time::Duration;

pub(super) fn plain(error: ProbeError) -> (ProbeError, Value) {
    (error, json!({}))
}

pub(super) fn usage(message: String) -> (ProbeError, Value) {
    plain(ProbeError::usage(message))
}

pub(crate) async fn run(args: &Args) -> ScenarioResult {
    let waited_ms = wait_ready(args).await?;
    let limit = Duration::from_secs(args.u64("timeout-sec", 120).map_err(usage)?);
    let work = async {
        match args.scenario.as_str() {
            "connect" => connect(args).await,
            "latency" => latency(args).await,
            "throughput" => throughput(args).await,
            "clipboard-send" => clipboard_send(args).await,
            "clipboard-receive" => clipboard_receive(args).await,
            "audio-capture" => audio_capture(args).await,
            "mic-send" => mic_send(args).await,
            "autodetect" => autodetect(args).await,
            "host-play" => host_play(args),
            "host-record" => host_record(args),
            "image-digest" => image_digest(args),
            "image-make" => image_make(args),
            other => Err(usage(format!("unknown scenario {other:?}"))),
        }
    };
    let mut result = match tokio::time::timeout(limit, work).await {
        Ok(result) => result,
        Err(_) => Err(plain(ProbeError::unmet(format!(
            "scenario exceeded --timeout-sec {}",
            limit.as_secs()
        )))),
    };
    if let Some(waited_ms) = waited_ms {
        let report = match &mut result {
            Ok(report) | Err((_, report)) => report,
        };
        if report.is_object() {
            report["wait_ready_ms"] = json!(waited_ms);
        }
    }
    result
}
