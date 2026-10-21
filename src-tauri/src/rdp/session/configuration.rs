use super::*;

/// Bitmap codecs offered to the server. Every codec in this list must also be
/// decodable by ironrdp-session; QOI/QOIZ decoding comes from the `qoi`/`qoiz`
/// features of the `ironrdp` dependency (see Cargo.toml). The servers RDP
/// loopback tests guard this pairing against Taomni's own server.
pub(crate) fn client_bitmap_codecs() -> ironrdp::pdu::rdp::capability_sets::BitmapCodecs {
    ironrdp::pdu::rdp::capability_sets::client_codecs_capabilities(&["remotefx"])
        .unwrap_or_default()
}

pub(super) fn build_ironrdp_config(cfg: &RdpConnectionSettings) -> connector::Config {
    let mut performance_flags = IronPerformanceFlags::empty();
    if !cfg.options.performance.wallpaper {
        performance_flags |= IronPerformanceFlags::DISABLE_WALLPAPER;
    }
    if cfg.options.performance.disable_full_window_drag {
        performance_flags |= IronPerformanceFlags::DISABLE_FULLWINDOWDRAG;
    }
    if cfg.options.performance.disable_menu_animations {
        performance_flags |= IronPerformanceFlags::DISABLE_MENUANIMATIONS;
    }
    if !cfg.options.performance.themes {
        performance_flags |= IronPerformanceFlags::DISABLE_THEMING;
    }
    if cfg.options.performance.disable_cursor_shadow {
        performance_flags |= IronPerformanceFlags::DISABLE_CURSOR_SHADOW;
    }
    if cfg.options.performance.font_smooth {
        performance_flags |= IronPerformanceFlags::ENABLE_FONT_SMOOTHING;
    }

    let width = normalize_width(cfg.options.screen_w);
    let height = cfg.options.screen_h.clamp(200, 8192);
    let color_depth = match cfg.options.color_depth {
        15 | 16 | 24 | 32 => u32::from(cfg.options.color_depth),
        _ => 32,
    };
    let codecs = client_bitmap_codecs();

    connector::Config {
        credentials: Credentials::UsernamePassword {
            username: cfg.username.clone().unwrap_or_default(),
            password: cfg.password.clone().unwrap_or_default(),
        },
        domain: cfg.options.domain.clone().filter(|s| !s.trim().is_empty()),
        enable_tls: !cfg.options.nla,
        enable_credssp: cfg.options.nla,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        alternate_shell: String::new(),
        work_dir: String::new(),
        desktop_size: connector::DesktopSize { width, height },
        desktop_scale_factor: 0,
        bitmap: Some(connector::BitmapConfig {
            lossy_compression: false,
            color_depth,
            codecs,
        }),
        // Use FreeRDP's interoperability build. xrdp 0.9 treats builds <= 419
        // as legacy clients and omits resize reactivation even after accepting
        // Display Control, leaving the decoder at the original desktop size.
        client_build: 18_363,
        client_name: "taomni".to_owned(),
        client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
        platform: platform_type(),
        enable_server_pointer: true,
        request_data: None,
        autologon: !cfg.options.nla && (cfg.username.is_some() || cfg.password.is_some()),
        enable_audio_playback: cfg.options.redirect_audio == "play",
        // The WebView renders server-provided cursor shapes as a native CSS
        // cursor. Compositing the pointer into the framebuffer would make its
        // movement wait for remote graphics updates and feel noticeably slow.
        pointer_software_rendering: false,
        performance_flags,
        hardware_id: None,
        license_cache: None::<Arc<dyn connector::LicenseCache>>,
        timezone_info: TimezoneInfo::default(),
        compression_type: Some(ironrdp::pdu::rdp::client_info::CompressionType::Rdp61),
        multitransport_flags: None,
    }
}

pub(super) fn normalize_width(width: u16) -> u16 {
    let clamped = width.clamp(200, 8192);
    if clamped % 2 == 0 {
        clamped
    } else {
        clamped - 1
    }
}

pub(super) fn platform_type() -> MajorPlatformType {
    #[cfg(windows)]
    {
        MajorPlatformType::WINDOWS
    }
    #[cfg(target_os = "macos")]
    {
        MajorPlatformType::MACINTOSH
    }
    #[cfg(target_os = "ios")]
    {
        MajorPlatformType::IOS
    }
    #[cfg(target_os = "android")]
    {
        MajorPlatformType::ANDROID
    }
    #[cfg(all(
        not(windows),
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    ))]
    {
        MajorPlatformType::UNIX
    }
}

pub(super) fn install_rustls_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
