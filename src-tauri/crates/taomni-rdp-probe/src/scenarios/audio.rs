use super::dispatch::plain;
use super::dispatch::usage;
use super::readiness::open;
use super::readiness::settle;
use crate::Args;
use crate::ProbeError;
use crate::ScenarioResult;
use crate::audio::ProbeRdpsnd;
use crate::audio_input;
use crate::audio_input::AudioInputClient;
use crate::host_audio;
use crate::session::ChannelPlan;
use crate::session::ProbeSession;
use crate::stats;
use ironrdp::dvc::DrdynvcClient;
use serde_json::Value;
use serde_json::json;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

pub(super) async fn audio_capture(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 4.0).map_err(usage)?;
    let expected = args.opt("freq").and_then(|f| f.parse::<f64>().ok());
    let rate = u32::try_from(args.u64("rdpsnd-rate", 48_000).map_err(usage)?)
        .map_err(|_| usage("--rdpsnd-rate is out of range".to_string()))?;
    let audio = ProbeRdpsnd::new(rate);
    let capture = audio.capture.clone();
    let formats: Vec<_> = audio.format(0).cloned().into_iter().collect();
    let mut session = open(
        args,
        ChannelPlan {
            audio: Some(audio),
            ..ChannelPlan::default()
        },
    )
    .await?;
    settle(&mut session, Duration::from_secs_f64(seconds)).await?;
    let mut report = session.summary();
    let captured = capture.lock().expect("audio capture");
    let format = captured.format_no.and_then(|n| formats.get(n)).cloned();
    report["audio"] = json!({
        "waves": captured.waves,
        "format_no": captured.format_no,
        "format_changes": captured.format_changes,
        "rate": format.as_ref().map(|f| f.n_samples_per_sec),
        "channels": format.as_ref().map(|f| f.n_channels),
        "volume": captured.volume,
        "closed": captured.closed,
        "first_wave_after_connect_ms": captured.first_wave_at.map(|t| t.saturating_duration_since(session.connected_at).as_millis() as u64),
    });
    let Some(format) = format else {
        drop(captured);
        return Err((ProbeError::unmet("server sent no RDPSND wave data"), report));
    };
    let mono = stats::mono_from_i16(&captured.samples, format.n_channels);
    if let Some(path) = args.opt("wav-out") {
        let _ = write_wav(
            Path::new(&path),
            &captured.samples,
            format.n_samples_per_sec,
            format.n_channels,
        );
    }
    report["tone"] = stats::tone_report(&mono, format.n_samples_per_sec, expected);
    if expected.is_some() && report["tone"]["frequency_matches"] != json!(true) {
        drop(captured);
        return Err((
            ProbeError::unmet("received audio does not contain the expected tone"),
            report,
        ));
    }
    Ok(report)
}

pub(crate) fn write_wav(
    path: &Path,
    samples: &[i16],
    rate: u32,
    channels: u16,
) -> std::io::Result<()> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * u32::from(channels) * 2).to_le_bytes());
    out.extend_from_slice(&(channels * 2).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, out)
}

pub(super) async fn mic_send(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 4.0).map_err(usage)?;
    let freq = args.f64("freq", 440.0).map_err(usage)?;
    let client = AudioInputClient::default();
    let state = client.state.clone();
    let mut session = open(
        args,
        ChannelPlan {
            audio_input: Some(client),
            ..ChannelPlan::default()
        },
    )
    .await?;
    let open_deadline =
        Instant::now() + Duration::from_secs(args.u64("open-wait-sec", 15).map_err(usage)?);
    loop {
        if let Err(error) = session.pump(Duration::from_millis(50)).await {
            return Err((error, mic_report(&mut session, &state, 0, 0)));
        }
        if state.lock().expect("audio input").open {
            break;
        }
        if Instant::now() >= open_deadline {
            return Err((
                ProbeError::unmet("server did not open the AUDIO_INPUT channel"),
                mic_report(&mut session, &state, 0, 0),
            ));
        }
    }
    let (format, channel_id) = {
        let s = state.lock().expect("audio input");
        (s.current.expect("open implies a format"), s.channel_id)
    };
    let channel_id = channel_id
        .or_else(|| {
            session
                .active_stage
                .get_svc_processor::<DrdynvcClient>()
                .and_then(|dvc| dvc.get_dvc_by_type_id::<AudioInputClient>())
                .and_then(|channel| channel.channel_id())
        })
        .unwrap_or_default();
    let frames_per_packet = (format.rate / 50) as usize; // 20 ms
    let mut phase = 0.0;
    let packets = (seconds * 50.0) as usize;
    let mut bytes_sent = 0usize;
    let started = Instant::now();
    for index in 0..packets {
        let pcm = stats::sine_pcm(
            freq,
            format.rate,
            format.channels,
            frames_per_packet,
            &mut phase,
        );
        bytes_sent += pcm.len();
        if let Err(error) = session
            .send_dvc_messages(channel_id, audio_input::data_pdus(&pcm))
            .await
        {
            return Err((error, mic_report(&mut session, &state, index, bytes_sent)));
        }
        let due = started + Duration::from_millis(20 * (index as u64 + 1));
        if let Err(error) = session.pump_until(due).await {
            return Err((error, mic_report(&mut session, &state, index, bytes_sent)));
        }
    }
    let _ = session
        .pump_until(Instant::now() + Duration::from_millis(300))
        .await;
    Ok(mic_report(&mut session, &state, packets, bytes_sent))
}

pub(super) fn mic_report(
    session: &mut ProbeSession,
    state: &std::sync::Arc<std::sync::Mutex<audio_input::AudioInputState>>,
    packets: usize,
    bytes: usize,
) -> Value {
    let mut report = session.summary();
    let s = state.lock().expect("audio input");
    report["audio_input"] = json!({
        "channel_id": s.channel_id,
        "server_version": s.server_version,
        "server_formats": s.server_formats.iter().map(|f| json!({"tag": f.tag, "channels": f.channels, "rate": f.rate, "bits": f.bits})).collect::<Vec<_>>(),
        "accepted_formats": s.client_formats.len(),
        "frames_per_packet": s.frames_per_packet,
        "current": s.current.map(|f| json!({"channels": f.channels, "rate": f.rate})),
        "open": s.open,
        "packets_sent": packets,
        "bytes_sent": bytes,
        "log": s.log,
    });
    report
}

pub(super) fn host_play(args: &Args) -> ScenarioResult {
    let freq = args.f64("freq", 1000.0).map_err(usage)?;
    let seconds = args.f64("seconds", 3.0).map_err(usage)?;
    host_audio::play(freq, seconds, args.opt("device").as_deref())
        .map_err(|e| plain(ProbeError::unmet(e)))
}

pub(super) fn host_record(args: &Args) -> ScenarioResult {
    let seconds = args.f64("seconds", 3.0).map_err(usage)?;
    let expected = args.opt("freq").and_then(|f| f.parse::<f64>().ok());
    let report = host_audio::record(
        seconds,
        args.opt("device").as_deref(),
        args.flag("loopback"),
        args.flag("taomni-mic"),
        expected,
        args.opt("wav-out").map(PathBuf::from).as_deref(),
    )
    .map_err(|e| plain(ProbeError::unmet(e)))?;
    if expected.is_some() && report["frequency_matches"] != json!(true) {
        return Err((
            ProbeError::unmet("recorded audio does not contain the expected tone"),
            report,
        ));
    }
    Ok(report)
}
