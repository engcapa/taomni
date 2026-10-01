//! Local (non-RDP) audio helpers: play a tone on a host output device and
//! record a host input device. Used as the oracle for RDPSND playback and
//! AUDIO_INPUT microphone redirection on Windows/macOS; Linux cases may use
//! PipeWire's own `pw-play`/`pw-record` instead.

use serde_json::{Value, json};

#[cfg(feature = "rdp-server-audio")]
mod imp {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use serde_json::{Value, json};

    /// "Endpoint (device)": WASAPI names only the endpoint ("Speakers");
    /// the driver field carries the device ("VB-Audio Virtual Cable").
    fn device_name(device: &cpal::Device) -> String {
        let Ok(description) = device.description() else {
            return "<unnamed>".to_string();
        };
        let name = description.name().to_string();
        match description
            .driver()
            .filter(|driver| !driver.is_empty() && !name.contains(driver))
        {
            Some(driver) => format!("{name} ({driver})"),
            None => name,
        }
    }

    fn pick(output: bool, contains: Option<&str>) -> Result<cpal::Device, String> {
        let host = cpal::default_host();
        if let Some(needle) = contains {
            let needle = needle.to_lowercase();
            let devices: Vec<cpal::Device> = if output {
                host.output_devices().map_err(|e| e.to_string())?.collect()
            } else {
                host.input_devices().map_err(|e| e.to_string())?.collect()
            };
            let names: Vec<String> = devices.iter().map(device_name).collect();
            return devices
                .into_iter()
                .find(|d| device_name(d).to_lowercase().contains(&needle))
                .ok_or_else(|| {
                    format!(
                        "no {} device matching {needle:?}; have {names:?}",
                        if output { "output" } else { "input" }
                    )
                });
        }
        if output {
            host.default_output_device()
        } else {
            host.default_input_device()
        }
        .ok_or_else(|| {
            format!(
                "no default {} device",
                if output { "output" } else { "input" }
            )
        })
    }

    pub fn play(freq: f64, seconds: f64, device: Option<&str>) -> Result<Value, String> {
        let device = pick(true, device)?;
        let name = device_name(&device);
        let config = device.default_output_config().map_err(|e| e.to_string())?;
        let rate = config.sample_rate();
        let channels = usize::from(config.channels());
        let format = config.sample_format();
        let step = 2.0 * std::f32::consts::PI * freq as f32 / rate as f32;
        let phase = Arc::new(Mutex::new(0.0f32));
        let err = |e: cpal::StreamError| eprintln!("host-play stream error: {e}");
        let stream_config: cpal::StreamConfig = config.into();
        let stream = match format {
            cpal::SampleFormat::F32 => {
                let phase = Arc::clone(&phase);
                device.build_output_stream(
                    &stream_config,
                    move |data: &mut [f32], _| {
                        let mut p = phase.lock().unwrap();
                        for frame in data.chunks_mut(channels) {
                            let v = p.sin() * 0.5;
                            frame.iter_mut().for_each(|s| *s = v);
                            *p = (*p + step) % (2.0 * std::f32::consts::PI);
                        }
                    },
                    err,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let phase = Arc::clone(&phase);
                device.build_output_stream(
                    &stream_config,
                    move |data: &mut [i16], _| {
                        let mut p = phase.lock().unwrap();
                        for frame in data.chunks_mut(channels) {
                            let v = (p.sin() * 0.5 * 32767.0) as i16;
                            frame.iter_mut().for_each(|s| *s = v);
                            *p = (*p + step) % (2.0 * std::f32::consts::PI);
                        }
                    },
                    err,
                    None,
                )
            }
            other => return Err(format!("unsupported output sample format {other:?}")),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_secs_f64(seconds));
        drop(stream);
        Ok(
            json!({ "device": name, "rate": rate, "channels": channels, "freq": freq, "seconds": seconds }),
        )
    }

    /// First input device whose name contains one of `names`, in order.
    fn pick_input(names: &[&str]) -> Result<cpal::Device, String> {
        let devices: Vec<cpal::Device> = cpal::default_host()
            .input_devices()
            .map_err(|e| e.to_string())?
            .collect();
        let found: Vec<String> = devices.iter().map(device_name).collect();
        let index = names.iter().find_map(|needle| {
            let needle = needle.to_lowercase();
            found
                .iter()
                .position(|n| n.to_lowercase().contains(&needle))
        });
        match index {
            Some(index) => Ok(devices.into_iter().nth(index).expect("index into names")),
            None => Err(format!(
                "no input device matching {names:?}; have {found:?}"
            )),
        }
    }

    /// Record mono f32 samples. `loopback` records what an output device
    /// plays (WASAPI loopback on Windows) instead of an input device;
    /// `taomni_mic` records the capture side of the virtual cable the RDP
    /// server plays client microphones into.
    pub fn record(
        seconds: f64,
        device: Option<&str>,
        loopback: bool,
        taomni_mic: bool,
    ) -> Result<(Vec<f32>, u32, String), String> {
        let device = if taomni_mic {
            pick_input(&super::MIC_CAPTURE_DEVICES)?
        } else {
            pick(loopback, device)?
        };
        let name = device_name(&device);
        let config = if loopback {
            device.default_output_config()
        } else {
            device.default_input_config()
        }
        .map_err(|e| e.to_string())?;
        let rate = config.sample_rate();
        let channels = usize::from(config.channels());
        let format = config.sample_format();
        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let err = |e: cpal::StreamError| eprintln!("host-record stream error: {e}");
        let stream_config: cpal::StreamConfig = config.into();
        let stream = match format {
            cpal::SampleFormat::F32 => {
                let samples = Arc::clone(&samples);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| {
                        let mut out = samples.lock().unwrap();
                        out.extend(
                            data.chunks(channels)
                                .map(|f| f.iter().sum::<f32>() / channels as f32),
                        );
                    },
                    err,
                    None,
                )
            }
            cpal::SampleFormat::I16 => {
                let samples = Arc::clone(&samples);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| {
                        let mut out = samples.lock().unwrap();
                        out.extend(data.chunks(channels).map(|f| {
                            f.iter().map(|s| f32::from(*s) / 32768.0).sum::<f32>() / channels as f32
                        }));
                    },
                    err,
                    None,
                )
            }
            other => return Err(format!("unsupported input sample format {other:?}")),
        }
        .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?;
        std::thread::sleep(Duration::from_secs_f64(seconds));
        drop(stream);
        let samples = std::mem::take(&mut *samples.lock().unwrap());
        Ok((samples, rate, name))
    }
}

pub(crate) fn play(freq: f64, seconds: f64, device: Option<&str>) -> Result<Value, String> {
    #[cfg(feature = "rdp-server-audio")]
    {
        imp::play(freq, seconds, device)
    }
    #[cfg(not(feature = "rdp-server-audio"))]
    {
        let _ = (freq, seconds, device);
        Err("rdp-probe was built without the rdp-server-audio feature".to_string())
    }
}

/// Capture side of the virtual cables the RDP server's microphone plays into
/// on Windows (VB-CABLE) and macOS (BlackHole, Background Music).
#[cfg_attr(not(feature = "rdp-server-audio"), allow(dead_code))]
const MIC_CAPTURE_DEVICES: [&str; 4] =
    ["CABLE Output", "VB-Audio", "BlackHole", "Background Music"];
/// `node.name` of the RDP server's PipeWire microphone source on Linux.
#[cfg(target_os = "linux")]
const MIC_NODE: &str = "taomni-rdp-microphone";

pub(crate) fn record(
    seconds: f64,
    device: Option<&str>,
    loopback: bool,
    taomni_mic: bool,
    expected: Option<f64>,
) -> Result<Value, String> {
    #[cfg(target_os = "linux")]
    if taomni_mic {
        let (samples, rate, name) = crate::pw_record::record(seconds, MIC_NODE)?;
        let mut report = crate::stats::tone_report(&samples, rate, expected);
        report["device"] = json!(name);
        report["loopback"] = json!(false);
        return Ok(report);
    }
    #[cfg(feature = "rdp-server-audio")]
    {
        let (samples, rate, name) = imp::record(seconds, device, loopback, taomni_mic)?;
        let mut report = crate::stats::tone_report(&samples, rate, expected);
        report["device"] = json!(name);
        report["loopback"] = json!(loopback);
        Ok(report)
    }
    #[cfg(not(feature = "rdp-server-audio"))]
    {
        let _ = (seconds, device, loopback, taomni_mic, expected, json!(null));
        Err("rdp-probe was built without the rdp-server-audio feature".to_string())
    }
}
