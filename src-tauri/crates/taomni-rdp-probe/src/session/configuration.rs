use super::model::ConnectOptions;
use crate::ProbeError;
use ironrdp::connector;
use ironrdp::connector::Credentials;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::rdp::capability_sets::BitmapCodecs;
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp::pdu::rdp::capability_sets::client_codecs_capabilities;
use ironrdp::pdu::rdp::client_info::CompressionType;
use ironrdp::pdu::rdp::client_info::PerformanceFlags;
use ironrdp::pdu::rdp::client_info::TimezoneInfo;
use std::sync::Arc;

pub(super) const MSTSC_LIKE_CODECS: &str = "remotefx,qoi:off,qoiz:off";

pub(super) fn parse_compression(value: &str) -> Result<Option<CompressionType>, ProbeError> {
    match value {
        "none" => Ok(None),
        "k8" => Ok(Some(CompressionType::K8)),
        "k64" => Ok(Some(CompressionType::K64)),
        "rdp6" => Ok(Some(CompressionType::Rdp6)),
        "rdp61" => Ok(Some(CompressionType::Rdp61)),
        _ => Err(ProbeError::usage(
            "--compression expects none|k8|k64|rdp6|rdp61",
        )),
    }
}

pub(super) fn compression_name(value: Option<CompressionType>) -> &'static str {
    match value {
        None => "none",
        Some(CompressionType::K8) => "k8",
        Some(CompressionType::K64) => "k64",
        Some(CompressionType::Rdp6) => "rdp6",
        Some(CompressionType::Rdp61) => "rdp61",
    }
}

/// Resolve `--codecs`. `qoi`/`qoiz` are only known to ironrdp-pdu builds with
/// those features, so `name:off` for an absent codec is dropped instead of
/// failing the whole list.
pub(super) fn client_codecs(config: &[String]) -> Result<BitmapCodecs, ProbeError> {
    let refs: Vec<&str> = config.iter().map(String::as_str).collect();
    match client_codecs_capabilities(&refs) {
        Ok(codecs) => Ok(codecs),
        Err(first) => {
            let enabled: Vec<&str> = refs
                .iter()
                .copied()
                .filter(|c| !c.ends_with(":off"))
                .collect();
            client_codecs_capabilities(&enabled)
                .map_err(|_| ProbeError::usage(format!("--codecs {}: {first}", config.join(","))))
        }
    }
}

pub(super) fn connector_config(
    opts: &ConnectOptions,
    codecs: BitmapCodecs,
    audio_playback: bool,
) -> connector::Config {
    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: opts.user.clone(),
            password: opts.password.clone(),
        },
        domain: opts.domain.clone(),
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        alternate_shell: opts.alternate_shell.clone(),
        work_dir: opts.work_dir.clone(),
        desktop_size: connector::DesktopSize {
            width: opts.width,
            height: opts.height,
        },
        desktop_scale_factor: 0,
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: false,
            color_depth: 32,
            codecs,
        }),
        client_build: 0,
        client_name: "taomni-probe".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: MajorPlatformType::WINDOWS,
        enable_server_pointer: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: audio_playback,
        pointer_software_rendering: false,
        performance_flags: PerformanceFlags::DISABLE_WALLPAPER
            | PerformanceFlags::DISABLE_MENUANIMATIONS
            | PerformanceFlags::DISABLE_CURSOR_SHADOW,
        hardware_id: None,
        license_cache: None::<Arc<dyn connector::LicenseCache>>,
        timezone_info: TimezoneInfo::default(),
        compression_type: opts.compression,
        multitransport_flags: None,
    }
}

/// Errors from the CredSSP stage that mean "the server refused these
/// credentials" rather than "the transport failed".
pub(super) fn looks_like_auth_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    [
        "logon",
        "credssp",
        "authentication",
        "ntlm",
        "access denied",
        "access_denied",
        "invalid credentials",
        "0xc000006d",
        "0x8009030c",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub(super) fn codec_name(id: u8) -> String {
    match id {
        3 => "remotefx".to_string(),
        0x0A => "qoi".to_string(),
        0x0B => "qoiz".to_string(),
        other => format!("codec-{other}"),
    }
}
