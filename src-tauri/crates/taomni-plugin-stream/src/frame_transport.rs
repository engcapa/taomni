//! M0 measurement with fixed BGRA workloads and the production native upgrade rules.
mod wire;

use std::{
    fs, io,
    process::Stdio,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, process::Command, sync::watch, time};
use tokio_tungstenite::tungstenite::Bytes;

use crate::native_channel::{Channel, Offer};

const WARMUP: u64 = 30;
const SAMPLES: u64 = 150;
const FRAME_COUNT: u64 = WARMUP + SAMPLES;

#[cfg(windows)]
struct TimerResolution;

#[cfg(windows)]
impl TimerResolution {
    fn begin() -> Self {
        // SAFETY: One millisecond is a valid request on the hosted Windows image.
        let result = unsafe { windows_sys::Win32::Media::timeBeginPeriod(1) };
        assert_eq!(result, 0, "request one-millisecond timer resolution");
        Self
    }
}

#[cfg(windows)]
impl Drop for TimerResolution {
    fn drop(&mut self) {
        // SAFETY: This guard owns one matching successful timeBeginPeriod call.
        unsafe { windows_sys::Win32::Media::timeEndPeriod(1) };
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct Workload {
    width: usize,
    height: usize,
    fps: u32,
}

const WORKLOADS: [Workload; 2] = [
    Workload {
        width: 640,
        height: 360,
        fps: 60,
    },
    Workload {
        width: 1920,
        height: 1080,
        fps: 30,
    },
];

impl Workload {
    fn byte_len(self) -> usize {
        self.width * self.height * 4
    }

    fn period(self) -> Duration {
        Duration::from_secs(1) / self.fps
    }

    fn pixels(self) -> [Bytes; 4] {
        std::array::from_fn(|index| {
            let pattern = [5, 7, 11, 255, 197, 113, 59, 255];
            let mut bytes = Vec::with_capacity(self.byte_len());
            while bytes.len() < self.byte_len() {
                bytes.extend(pattern.map(|value: u8| value.wrapping_add(index as u8)));
            }
            bytes.into()
        })
    }
}

#[derive(Clone)]
struct Frame {
    sequence: u64,
    published: Instant,
    pixels: Bytes,
}

fn pixels_for(patterns: &[Bytes; 4], sequence: u64) -> &Bytes {
    &patterns[sequence as usize % patterns.len()]
}

async fn publish(
    workload: Workload,
    patterns: [Bytes; 4],
    latest: watch::Sender<Option<Frame>>,
    start: Instant,
) -> Vec<u128> {
    let mut publications = Vec::with_capacity(SAMPLES as usize);
    let mut timer = time::interval(workload.period());
    timer.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    for sequence in 0..FRAME_COUNT {
        timer.tick().await;
        if latest.is_closed() {
            break;
        }
        let published = Instant::now();
        if sequence >= WARMUP {
            publications.push(published.duration_since(start).as_micros());
        }
        latest.send_replace(Some(Frame {
            sequence,
            published,
            pixels: pixels_for(&patterns, sequence).clone(),
        }));
    }
    publications
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    sequence: u64,
    published_us: u128,
    received_us: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    route: &'static str,
    delivered: usize,
    replaced: usize,
    fps: f64,
    offered_fps: f64,
    p95_us: u128,
    publications_us: Vec<u128>,
    samples: Vec<Sample>,
}

impl Measurement {
    fn summarize(route: &'static str, publications_us: Vec<u128>, samples: Vec<Sample>) -> Self {
        assert_eq!(publications_us.len(), SAMPLES as usize);
        assert_eq!(samples.last().unwrap().sequence, FRAME_COUNT - 1);
        assert!(samples.len() >= 2, "Missing sustained frame delivery");
        let mut latency: Vec<_> = samples
            .iter()
            .map(|sample| sample.received_us - sample.published_us)
            .collect();
        latency.sort_unstable();
        let duration = samples.last().unwrap().received_us - samples.first().unwrap().received_us;
        let publish_duration = publications_us.last().unwrap() - publications_us.first().unwrap();
        let delivered = samples.len();
        Self {
            route,
            delivered,
            replaced: SAMPLES as usize - delivered,
            fps: (delivered - 1) as f64 * 1_000_000.0 / duration as f64,
            offered_fps: (SAMPLES - 1) as f64 * 1_000_000.0 / publish_duration as f64,
            p95_us: latency[(delivered * 95).div_ceil(100) - 1],
            publications_us,
            samples,
        }
    }
}

enum Sink {
    InProcess([Bytes; 4]),
    Host(Channel),
}

impl Sink {
    async fn receive(&mut self, frame: &Frame) {
        match self {
            Self::InProcess(patterns) => {
                assert!(frame.pixels == *pixels_for(patterns, frame.sequence));
            }
            Self::Host(socket) => wire::deliver(socket, frame).await,
        }
    }

    async fn finish(self) -> &'static str {
        match self {
            Self::InProcess(_) => "in-process",
            Self::Host(socket) => {
                socket.close().await.unwrap();
                "plugin-host"
            }
        }
    }
}

async fn measure(workload: Workload, mut sink: Sink) -> Measurement {
    let patterns = workload.pixels();
    let (source, mut latest) = watch::channel::<Option<Frame>>(None);
    let start = Instant::now();
    let producer = tokio::spawn(publish(workload, patterns, source, start));
    let mut samples = Vec::new();
    while latest.changed().await.is_ok() {
        let frame = latest
            .borrow_and_update()
            .clone()
            .expect("publisher must supply pixels");
        sink.receive(&frame).await;
        if frame.sequence >= WARMUP {
            samples.push(Sample {
                sequence: frame.sequence,
                published_us: frame.published.duration_since(start).as_micros(),
                received_us: start.elapsed().as_micros(),
            });
        }
    }
    Measurement::summarize(sink.finish().await, producer.await.unwrap(), samples)
}

async fn measure_host(workload: Workload) -> Measurement {
    let offer = Offer::bind().await.unwrap();
    let input = wire::input(&offer, workload);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "frame_transport::host_receiver",
            "--nocapture",
        ])
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(&serde_json::to_vec(&input).unwrap())
        .await
        .unwrap();
    drop(stdin);
    let socket = offer.accept().await.unwrap();
    let result = measure(workload, Sink::Host(socket)).await;
    assert!(child.wait().await.unwrap().success());
    result
}

#[tokio::test]
#[ignore = "native continuous loopback and child process; run on GitHub"]
async fn compare_in_process_and_host() {
    assert!(
        !cfg!(debug_assertions),
        "build the frame harness in release mode"
    );
    let path = std::env::var_os("QA_MODULE_FRAME_REPORT").expect("runner frame evidence path");
    #[cfg(windows)]
    let _timer_resolution = TimerResolution::begin();
    time::timeout(Duration::from_secs(90), async {
        let mut trials = Vec::new();
        for workload in WORKLOADS {
            let baseline = measure(workload, Sink::InProcess(workload.pixels())).await;
            let host = measure_host(workload).await;
            trials.push(serde_json::json!({ "workload": workload,
                "bytesPerFrame": workload.byte_len(), "inProcess": baseline, "host": host }));
        }
        let result = serde_json::json!({ "trials": trials,
            "warmupFrames": WARMUP, "measuredFrames": SAMPLES, "profile": "release",
            "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH });
        fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    })
    .await
    .expect("continuous frame comparison timed out");
}

#[tokio::test]
#[ignore = "child entry for frame_transport::compare_in_process_and_host"]
async fn host_receiver() {
    let input = serde_json::from_reader(io::stdin().lock()).expect("frame source through stdin");
    wire::receive(input).await;
}

#[test]
fn measurement_uses_delivered_frame_latencies_and_counts_replaced_frames() {
    let publications = (0..SAMPLES)
        .map(|index| 50 + u128::from(index) * 100)
        .collect();
    let samples = vec![
        Sample {
            sequence: WARMUP,
            published_us: 50,
            received_us: 60,
        },
        Sample {
            sequence: FRAME_COUNT - 1,
            published_us: 14_950,
            received_us: 16_000,
        },
    ];
    let result = Measurement::summarize("in-process", publications, samples);
    assert_eq!(result.delivered, 2);
    assert_eq!(result.replaced, SAMPLES as usize - 2);
    assert_eq!(result.offered_fps, 10_000.0);
    assert_eq!(result.p95_us, 1_050);
    assert!((result.fps - 62.735).abs() < 0.001);
}

#[tokio::test]
async fn slow_consumer_reads_the_latest_frame_after_publication_closes() {
    let (sender, mut receiver) = watch::channel(None);
    let pixels = Bytes::from_static(&[1, 2, 3, 255]);
    for sequence in 0..3 {
        sender.send_replace(Some(Frame {
            sequence,
            published: Instant::now(),
            pixels: pixels.clone(),
        }));
    }
    drop(sender);
    receiver.changed().await.unwrap();
    assert_eq!(receiver.borrow_and_update().as_ref().unwrap().sequence, 2);
    assert!(receiver.changed().await.is_err());
}
