//! Hosted G5 comparison using the real X11 capture/display and IronRDP encoder.
//! The remote encoder takes one bitmap at a time across the native channel.
mod bitmap;

use std::{
    io,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, ensure};
use async_trait::async_trait;
use bytes::Bytes;
use ironrdp::server::{
    Credentials, DesktopSize, DisplayUpdate, RdpServer, RdpServerDisplay, RdpServerDisplayUpdates,
    ServerEvent,
};
use serde::{Deserialize, Serialize};
use taomni_plugin_stream::native_channel::{Channel, Endpoint, Offer};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{Mutex, oneshot},
    time,
};

use crate::servers::engine::LogEmitter;

use super::{
    display::RdpDisplay, input::RdpInput, loopback_tests::tls_identity, metrics::RdpMetrics,
};
use bitmap::channel_error;

const ENCODER_TEST: &str = "servers::rdp::host_perf::encoder_process";
const NEXT_BITMAP: Bytes = Bytes::from_static(b"next");

#[derive(Serialize, Deserialize)]
struct EncoderConfig<E> {
    report: PathBuf,
    width: u16,
    height: u16,
    endpoint: E,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferStats {
    bitmaps: u64,
    bitmap_bytes: u64,
    damage_regions: u64,
}

fn eof() -> oneshot::Receiver<()> {
    let (sender, receiver) = oneshot::channel();
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
        let _ = sender.send(());
    });
    receiver
}

fn publish(report: &Path, name: &str, value: &impl Serialize) -> anyhow::Result<()> {
    let target = report.join(name);
    let temp = target.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(value)?)?;
    std::fs::rename(temp, target)?;
    Ok(())
}

async fn run_server(
    display: impl RdpServerDisplay + 'static,
    report: &Path,
    stop: oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    let log = LogEmitter::rdp_test_log();
    let input = RdpInput::new(log.clone(), false, None, RdpMetrics::new(log), None);
    let identity_dir = tempfile::tempdir()?;
    let identity = tls_identity(identity_dir.path());
    let mut server = RdpServer::builder()
        .with_addr(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .with_hybrid(identity.make_acceptor()?, identity.pub_key.clone())
        .with_input_handler(input)
        .with_display_handler(display)
        .with_bulk_compression(true)
        .build();
    server.set_credentials(Some(Credentials {
        username: "qa-rdp".into(),
        password: std::env::var("QA_RDP_PASSWORD")?,
        domain: None,
    }));
    let (address_tx, address_rx) = oneshot::channel();
    server
        .event_sender()
        .send(ServerEvent::GetLocalAddr(address_tx))?;
    let listening = async {
        let address = address_rx.await?.context("RDP listener has no address")?;
        publish(
            report,
            "encoder.json",
            &serde_json::json!({
                "port": address.port(),
                "pid": std::process::id()
            }),
        )?;
        stop.await?;
        Ok(())
    };
    tokio::select! {
        done = listening => done,
        result = server.run() => anyhow::bail!("RDP listener exited: {result:?}"),
    }
}

async fn export_bitmaps(
    display: &mut RdpDisplay,
    channel: &mut Channel,
    stats: &mut TransferStats,
) -> anyhow::Result<()> {
    let Some(mut request) = channel.receive().await.map_err(channel_error)? else {
        return Ok(());
    };
    let mut updates = display.updates().await?;
    loop {
        ensure!(request == NEXT_BITMAP, "Expected a single bitmap request");
        let update = updates.next_update().await?.context("Capture stopped")?;
        let DisplayUpdate::Bitmap(update) = update else {
            anyhow::bail!("The fixed X11 comparison expects bitmap updates");
        };
        let damage = update.x != 0 || update.y != 0;
        stats.bitmap_bytes += bitmap::send(channel, update).await? as u64;
        stats.bitmaps += 1;
        stats.damage_regions += u64::from(damage);
        match channel.receive().await.map_err(channel_error)? {
            Some(next) => request = next,
            None => return Ok(()),
        }
    }
}

async fn run_in_child(
    mut display: RdpDisplay,
    report: &Path,
    stop: oneshot::Receiver<()>,
) -> anyhow::Result<()> {
    let size = display.size().await;
    let offer = Offer::bind().await.map_err(channel_error)?;
    let mut worker = Command::new(std::env::current_exe()?)
        .args(["--ignored", "--exact", ENCODER_TEST, "--nocapture"])
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = worker.stdin.take().context("No child stdin")?;
    let mut descriptor = serde_json::to_vec(&EncoderConfig {
        report: report.to_path_buf(),
        width: size.width,
        height: size.height,
        endpoint: offer.endpoint(),
    })?;
    descriptor.push(b'\n');
    input.write_all(&descriptor).await?;
    let mut channel = offer.accept().await.map_err(channel_error)?;
    let mut stats = TransferStats::default();
    tokio::select! {
        result = export_bitmaps(&mut display, &mut channel, &mut stats) => {
            result?;
            anyhow::bail!("Encoder closed the frame channel before the end of the trial");
        }
        status = worker.wait() => anyhow::bail!("Encoder exited early: {}", status?),
        result = stop => result?,
    }
    // Both peers still own the connection. EOF stops the RDP server,
    // dropping its outstanding bitmap receive before the test process exits.
    drop(input);
    let status = time::timeout(Duration::from_secs(10), worker.wait()).await??;
    ensure!(status.success(), "Encoder shutdown failed: {status}");
    ensure!(
        stats.bitmaps > 0,
        "Encoder received no cross-process bitmaps"
    );
    publish(report, "transport.json", &stats)
}

struct RemoteDisplay {
    size: DesktopSize,
    channel: Arc<Mutex<Channel>>,
    opened: bool,
}

#[async_trait]
impl RdpServerDisplay for RemoteDisplay {
    async fn size(&mut self) -> DesktopSize {
        self.size
    }

    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> {
        ensure!(!self.opened, "The trial expects a single RDP session");
        self.opened = true;
        Ok(Box::new(RemoteUpdates {
            channel: self.channel.clone(),
            size: self.size,
        }))
    }
}

struct RemoteUpdates {
    channel: Arc<Mutex<Channel>>,
    size: DesktopSize,
}

#[async_trait]
impl RdpServerDisplayUpdates for RemoteUpdates {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        let mut channel = self.channel.lock().await;
        let result = async {
            channel.send(NEXT_BITMAP).await.map_err(channel_error)?;
            bitmap::receive(&mut channel, self.size).await
        }
        .await;
        match result {
            Ok(bitmap) => Ok(Some(DisplayUpdate::Bitmap(bitmap))),
            Err(error) => {
                eprintln!("Bitmap transport stopped: {error:#}");
                Ok(None)
            }
        }
    }
}

#[tokio::test]
#[ignore = "real X11 and RDP performance fixture executed by GitHub Actions"]
async fn serve_x11() -> anyhow::Result<()> {
    ensure!(!cfg!(debug_assertions), "Use a release test harness");
    let report =
        PathBuf::from(std::env::var_os("QA_RDP_GATE_REPORT").context("Missing trial directory")?);
    let log = LogEmitter::rdp_test_log();
    let display = RdpDisplay::new(log.clone(), None, RdpMetrics::new(log), false)?;
    let stop = eof();
    match std::env::var("QA_RDP_GATE_ROUTE")?.as_str() {
        "in-process" => run_server(display, &report, stop).await,
        "encoder-host" => run_in_child(display, &report, stop).await,
        _ => anyhow::bail!("Unknown trial route"),
    }
}

#[tokio::test]
#[ignore = "child of the hosted X11 and RDP performance fixture"]
async fn encoder_process() -> anyhow::Result<()> {
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let config: EncoderConfig<Endpoint> = serde_json::from_str(&line)?;
    let channel = Channel::connect(config.endpoint)
        .await
        .map_err(channel_error)?;
    let display = RemoteDisplay {
        size: DesktopSize {
            width: config.width,
            height: config.height,
        },
        channel: Arc::new(Mutex::new(channel)),
        opened: false,
    };
    run_server(display, &config.report, eof()).await
}
