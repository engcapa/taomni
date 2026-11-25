use super::configuration::client_codecs;
use super::configuration::connector_config;
use super::configuration::looks_like_auth_failure;
use super::model::ChannelPlan;
use super::model::ConnectOptions;
use super::model::ProbeSession;
use super::tls::tls_upgrade;
use crate::ProbeError;
use crate::rfx_stats::RfxStats;
use ironrdp::cliprdr::CliprdrClient;
use ironrdp::connector;
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::input::Database as InputDatabase;
use ironrdp::rdpsnd::client::Rdpsnd;
use ironrdp::session::ActiveStageBuilder;
use ironrdp::session::image::DecodedImage;
use ironrdp_tokio::TokioFramed;
use std::net::SocketAddr;
use std::time::Instant;
use tokio::net::TcpStream;

impl ProbeSession {
    pub async fn connect(opts: &ConnectOptions, plan: ChannelPlan) -> Result<Self, ProbeError> {
        let started = Instant::now();
        let addr = format!("{}:{}", opts.host, opts.port);
        let tcp = tokio::time::timeout(opts.timeout, TcpStream::connect(&addr))
            .await
            .map_err(|_| ProbeError::connection(format!("TCP connect to {addr} timed out")))?
            .map_err(|e| ProbeError::connection(format!("TCP connect to {addr}: {e}")))?;
        let _ = tcp.set_nodelay(true);
        let local_addr: SocketAddr = tcp
            .local_addr()
            .map_err(|e| ProbeError::connection(format!("local address: {e}")))?;

        let mut channels = Vec::new();
        let codecs = client_codecs(&opts.codecs)?;
        let advertised_codecs = codecs.0.iter().map(|codec| codec.id).collect();
        let mut connector = connector::ClientConnector::new(
            connector_config(opts, codecs, plan.audio.is_some()),
            local_addr,
        );
        if let Some(clipboard) = plan.clipboard {
            connector.attach_static_channel(CliprdrClient::new(Box::new(clipboard)));
            channels.push("cliprdr");
        }
        if let Some(audio) = plan.audio {
            connector.attach_static_channel(Rdpsnd::new(Box::new(audio)));
            channels.push("rdpsnd");
        }
        let mut drdynvc = DrdynvcClient::new()
            .with_dynamic_channel(DisplayControlClient::new(|_caps| Ok(Vec::new())));
        if let Some(audio_input) = plan.audio_input {
            drdynvc = drdynvc.with_dynamic_channel(audio_input);
            channels.push("audio_input");
        }
        connector.attach_static_channel(drdynvc);
        channels.push("drdynvc");

        let mut framed = ironrdp_tokio::TokioFramed::new(tcp);
        let should_upgrade = tokio::time::timeout(
            opts.timeout,
            ironrdp_tokio::connect_begin(&mut framed, &mut connector),
        )
        .await
        .map_err(|_| ProbeError::connection("RDP negotiation timed out"))?
        .map_err(|e| ProbeError::connection(format!("RDP negotiation: {e}")))?;
        let tcp = framed.into_inner_no_leftover();
        let (tls, public_key, fingerprint) =
            tokio::time::timeout(opts.timeout, tls_upgrade(tcp, &opts.host))
                .await
                .map_err(|_| ProbeError::connection("TLS upgrade timed out"))?
                .map_err(ProbeError::connection)?;
        let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
        let mut framed = ironrdp_tokio::TokioFramed::new(tls);
        let mut network_client = ironrdp_tokio::reqwest::ReqwestNetworkClient::new();
        let result = tokio::time::timeout(
            opts.timeout,
            ironrdp_tokio::connect_finalize(
                upgraded,
                connector,
                &mut framed,
                &mut network_client,
                opts.host.clone().into(),
                public_key,
                None,
            ),
        )
        .await
        .map_err(|_| ProbeError::connection("CredSSP/connection finalization timed out"))?
        .map_err(|e| {
            let message = format!("RDP connection finalization: {e}");
            if looks_like_auth_failure(&message) {
                ProbeError {
                    kind: crate::ErrorKind::Auth,
                    message,
                }
            } else {
                ProbeError::connection(message)
            }
        })?;

        let width = result.desktop_size.width;
        let height = result.desktop_size.height;
        let activation_factory = result.activation_factory.clone();
        let active_stage = ActiveStageBuilder {
            static_channels: result.static_channels,
            user_channel_id: result.user_channel_id,
            io_channel_id: result.io_channel_id,
            message_channel_id: result.message_channel_id,
            share_id: result.share_id,
            compression_type: result.compression_type,
            enable_server_pointer: result.enable_server_pointer,
            pointer_software_rendering: result.pointer_software_rendering,
        }
        .build();
        Ok(Self {
            framed,
            active_stage,
            image: DecodedImage::new(PixelFormat::RgbA32, width, height),
            input: InputDatabase::new(),
            activation_factory,
            reactivation: None,
            connected_at: Instant::now(),
            connect_ms: started.elapsed().as_millis() as u64,
            first_graphics_ms: None,
            bytes_in: 0,
            pdus_in: 0,
            graphics_updates: 0,
            pointer_updates: 0,
            fingerprint,
            channels,
            terminated: None,
            empty_updates: 0,
            snapshot: opts.snapshot.clone(),
            advertised_codecs,
            rfx: RfxStats::new(result.compression_type).map_err(ProbeError::connection)?,
            compression: result.compression_type,
        })
    }
}
