use super::dispatch::usage;
use super::readiness::open;
use crate::Args;
use crate::ScenarioResult;
use crate::session::ChannelPlan;
use crate::session::PumpEvent;
use ironrdp::pdu::rdp::autodetect::AutoDetectRequest;
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;
use std::time::Instant;

pub(super) async fn autodetect(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 8.0).map_err(usage)?;
    let mut session = open(args, ChannelPlan::default()).await?;
    let deadline = Instant::now() + Duration::from_secs_f64(seconds);
    let mut counts: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut netchar = Vec::new();
    while Instant::now() < deadline {
        let events = match session.pump(Duration::from_millis(100)).await {
            Ok(events) => events,
            Err(error) => return Err((error, session.summary())),
        };
        for event in events {
            if let PumpEvent::AutoDetect(request) = event {
                let name = match &request {
                    AutoDetectRequest::RttRequest { .. } => "rtt_request",
                    AutoDetectRequest::BandwidthMeasureStart { .. } => "bandwidth_start",
                    AutoDetectRequest::BandwidthMeasurePayload { .. } => "bandwidth_payload",
                    AutoDetectRequest::BandwidthMeasureStop { .. } => "bandwidth_stop",
                    AutoDetectRequest::NetworkCharacteristicsResult {
                        base_rtt_ms,
                        bandwidth_kbps,
                        average_rtt_ms,
                        ..
                    } => {
                        netchar.push(json!({
                            "base_rtt_ms": base_rtt_ms,
                            "bandwidth_kbps": bandwidth_kbps,
                            "average_rtt_ms": average_rtt_ms,
                        }));
                        "network_characteristics"
                    }
                };
                *counts.entry(name).or_default() += 1;
            }
        }
    }
    let mut report = session.summary();
    report["autodetect"] = json!({ "counts": counts, "network_characteristics": netchar });
    Ok(report)
}
