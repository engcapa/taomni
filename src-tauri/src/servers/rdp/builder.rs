use super::approval::ControlGate;
use super::approval::ControlGateState;
#[cfg(target_os = "macos")]
use super::features::EXPERIMENTAL_AVC420_ENV;
#[cfg(target_os = "macos")]
use super::features::EXPERIMENTAL_CLIENT_SIZE_ENV;
#[cfg(target_os = "macos")]
use super::features::experimental_feature_enabled;
use super::lifetime::ServerParams;
use super::policy::ConnectionPolicy;
use super::policy::SecurityMode;
use crate::servers::engine::LogEmitter;
use crate::servers::rdp::audio_input;
use crate::servers::rdp::capture;
use crate::servers::rdp::clipboard::ClipboardFactory;
use crate::servers::rdp::display;
use crate::servers::rdp::display::RdpDisplay;
#[cfg(target_os = "macos")]
use crate::servers::rdp::gfx;
use crate::servers::rdp::input;
use crate::servers::rdp::input::RdpInput;
#[cfg(target_os = "macos")]
use crate::servers::rdp::input::control_permission_granted;
use crate::servers::rdp::metrics;
use crate::servers::rdp::metrics::RdpMetrics;
use crate::servers::rdp::sound;
use ironrdp::server::ConnectionHandler;
use ironrdp::server::RdpServer;
use std::sync::Arc;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Assemble the [`RdpServer`] for the requested security mode. Each branch
/// produces a different builder type (the builder is a typestate machine), so
/// the input/display/build tail is repeated per branch.
pub(super) fn build_server(
    params: &ServerParams,
    log: &LogEmitter,
    cancel: CancellationToken,
) -> anyhow::Result<RdpServer> {
    let control_gate = (!params.view_only && params.require_control_approval).then(|| {
        Arc::new(ControlGate {
            app: params.app.clone(),
            log: log.clone(),
            approvals: params.approvals.clone(),
            cancel: cancel.clone(),
            state: Mutex::new(ControlGateState::default()),
        })
    });
    // Auto-detect RTT (MS-RDPBCGR 2.2.14), written by the server per session
    // and shown in the periodic latency report.
    let network_rtt = Arc::new(std::sync::atomic::AtomicU32::new(u32::MAX));
    let encoder_stats = Arc::new(ironrdp::server::EncoderStats::default());
    let bulk_enabled = std::env::var("TAOMNI_RDP_BULK_COMPRESSION").as_deref() != Ok("0");
    log.line(if bulk_enabled {
        "RDP display encoding: adaptive planar+bulk / RemoteFX (negotiated per connection)"
    } else {
        "RDP display encoding: compatibility mode (TAOMNI_RDP_BULK_COMPRESSION=0)"
    });
    let metrics = RdpMetrics::new(log.clone())
        .with_network_rtt(Arc::clone(&network_rtt))
        .with_encoder_stats(Arc::clone(&encoder_stats));
    #[cfg(target_os = "macos")]
    if !params.view_only && !input::control_permission_granted() {
        anyhow::bail!(
            "Accessibility permission is required for RDP keyboard and mouse control. Open RDP Server settings, grant permission, then start the server again."
        );
    }
    #[cfg(target_os = "macos")]
    let gfx = gfx::GfxTransport::new(log.clone());
    let display = RdpDisplay::new(
        log.clone(),
        params.display_id.clone(),
        metrics.clone(),
        params.view_only,
        #[cfg(target_os = "macos")]
        gfx.clone(),
    )?;
    #[cfg(target_os = "macos")]
    let input_mapping = if params.view_only {
        None
    } else {
        Some(input::MacInputMapping::new(
            capture::mac::selected_display_bounds(params.display_id.as_deref())?,
            display.input_surface_size(),
        )?)
    };
    #[cfg(target_os = "macos")]
    let honor_client_desktop_size = display.supports_client_size();
    #[cfg(target_os = "macos")]
    let honor_client_desktop_size =
        honor_client_desktop_size && experimental_feature_enabled(EXPERIMENTAL_CLIENT_SIZE_ENV);
    #[cfg(target_os = "macos")]
    let enable_avc420 = experimental_feature_enabled(EXPERIMENTAL_AVC420_ENV);
    let input = RdpInput::new(
        log.clone(),
        params.view_only,
        control_gate.clone(),
        metrics.clone(),
        #[cfg(target_os = "linux")]
        display.portal_input(),
        #[cfg(target_os = "macos")]
        input_mapping,
    );
    // Both directions off removes the channel itself, as disabling clipboard
    // redirection does on Windows.
    let cliprdr: Option<Box<dyn ironrdp::server::CliprdrServerFactory>> =
        params.clipboard.enabled().then(|| {
            Box::new(ClipboardFactory::new(log.clone(), params.clipboard))
                as Box<dyn ironrdp::server::CliprdrServerFactory>
        });

    let sound: Option<Box<dyn ironrdp::server::SoundServerFactory>> =
        params.audio_playback.then(|| {
            Box::new(sound::SoundFactory::new(log.clone()))
                as Box<dyn ironrdp::server::SoundServerFactory>
        });

    // Not offered when this computer has nothing to play the microphone
    // into; the factory logs the reason.
    let microphone: Option<Box<dyn ironrdp::server::DvcServerFactory>> = params
        .microphone
        .then(|| audio_input::MicFactory::new(log.clone(), params.microphone_device.clone()))
        .flatten()
        .map(|factory| Box::new(factory) as Box<dyn ironrdp::server::DvcServerFactory>);

    let channel_log = log.clone();
    let channel_observer: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |channel| {
        channel_log.line(format!("RDP {channel} channel negotiated"));
    });
    let base = RdpServer::builder().with_addr(params.addr);
    let connection_handler: Box<dyn ConnectionHandler> = Box::new(ConnectionPolicy {
        app: params.app.clone(),
        log: log.clone(),
        control_gate,
        view_only: params.view_only,
        active: false,
    });

    let server = match params.security {
        SecurityMode::Hybrid => {
            let identity = &params.identity;
            let acceptor = identity.make_acceptor()?;
            let builder = base
                .with_hybrid(acceptor, identity.pub_key.clone())
                .with_input_handler(input)
                .with_display_handler(display)
                .with_channel_observer(channel_observer)
                .with_cliprdr_factory(cliprdr)
                .with_sound_factory(sound)
                .with_dvc_factory(microphone)
                .with_bulk_compression(bulk_enabled)
                .with_encoder_stats_handle(encoder_stats)
                .with_autodetect_rtt_handle(network_rtt);
            #[cfg(target_os = "macos")]
            let builder = builder.with_honor_client_desktop_size(honor_client_desktop_size);
            #[cfg(target_os = "macos")]
            let builder = if enable_avc420 {
                log.line(format!(
                    "RDP display transport: experimental EGFX/AVC420 enabled by {EXPERIMENTAL_AVC420_ENV}"
                ));
                builder.with_gfx_factory(Some(Box::new(gfx.factory())))
            } else {
                log.line(format!(
                    "RDP display transport: bitmap compatibility mode; set {EXPERIMENTAL_AVC420_ENV}=1 only for AVC420 interoperability testing"
                ));
                builder
            };
            #[cfg(target_os = "macos")]
            if honor_client_desktop_size {
                log.line(format!(
                    "RDP desktop sizing: experimental client-requested size enabled by {EXPERIMENTAL_CLIENT_SIZE_ENV}"
                ));
            } else {
                log.line(format!(
                    "RDP desktop sizing: server capture size compatibility mode; set {EXPERIMENTAL_CLIENT_SIZE_ENV}=1 only for resize interoperability testing"
                ));
            }
            builder
                .with_connection_handler(Some(connection_handler))
                .build()
        }
    };
    Ok(server)
}
