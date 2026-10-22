use crate::terminal::network::NetworkSettings;
use russh::Pty;
use russh::client;
use russh::kex;
use russh::keys::ssh_key::Algorithm as SshAlgorithm;
use russh::keys::ssh_key::EcdsaCurve;
use russh::keys::ssh_key::HashAlg;
use russh::mac;
use std::borrow::Cow;
use std::sync::Arc;

pub(super) const COMPAT_KEX_ORDER: &[kex::Name] = &[
    kex::CURVE25519,
    kex::CURVE25519_PRE_RFC_8731,
    kex::ECDH_SHA2_NISTP256,
    kex::ECDH_SHA2_NISTP384,
    kex::ECDH_SHA2_NISTP521,
    kex::DH_G16_SHA512,
    kex::DH_G14_SHA256,
    kex::DH_G14_SHA1,
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_SUPPORT_AS_SERVER,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
];

pub(super) const COMPAT_HOST_KEY_ORDER: &[SshAlgorithm] = &[
    SshAlgorithm::Ed25519,
    SshAlgorithm::Ecdsa {
        curve: EcdsaCurve::NistP256,
    },
    SshAlgorithm::Ecdsa {
        curve: EcdsaCurve::NistP384,
    },
    SshAlgorithm::Ecdsa {
        curve: EcdsaCurve::NistP521,
    },
    SshAlgorithm::Rsa {
        hash: Some(HashAlg::Sha512),
    },
    SshAlgorithm::Rsa {
        hash: Some(HashAlg::Sha256),
    },
    SshAlgorithm::Rsa { hash: None },
];

/// MAC algorithms offered to the server. This mirrors russh's modern default
/// (`SAFE_HMAC_ORDER`) but appends the SHA-1 HMACs that russh 0.61 dropped from
/// its built-in default. Some legacy servers (older OpenSSH, Dropbear, embedded
/// devices) only support hmac-sha1; without it the handshake fails with
/// "No common Mac algorithm". The SHA-1 variants are listed last so modern
/// servers still negotiate a SHA-2 MAC and only old servers fall back to SHA-1.
/// Note: russh 0.61 implements only these MAC names — hmac-md5, umac-64,
/// hmac-ripemd160 and the *-96 truncated variants are not available, so
/// hmac-sha1 is the only legacy MAC we can offer.
pub(super) const COMPAT_MAC_ORDER: &[mac::Name] = &[
    mac::HMAC_SHA512_ETM,
    mac::HMAC_SHA256_ETM,
    mac::HMAC_SHA512,
    mac::HMAC_SHA256,
    mac::HMAC_SHA1_ETM,
    mac::HMAC_SHA1,
];

pub(super) const DEFAULT_PTY_MODES: &[(Pty, u32)] = &[
    (Pty::VINTR, 3),
    (Pty::VQUIT, 28),
    (Pty::VERASE, 127),
    (Pty::VKILL, 21),
    (Pty::VEOF, 4),
    (Pty::VSTART, 17),
    (Pty::VSTOP, 19),
    (Pty::VSUSP, 26),
    (Pty::VREPRINT, 18),
    (Pty::VWERASE, 23),
    (Pty::VLNEXT, 22),
    (Pty::IGNPAR, 0),
    (Pty::PARMRK, 0),
    (Pty::INPCK, 0),
    (Pty::ISTRIP, 0),
    (Pty::INLCR, 0),
    (Pty::IGNCR, 0),
    (Pty::ICRNL, 1),
    (Pty::IXON, 1),
    (Pty::IXANY, 0),
    (Pty::IXOFF, 0),
    (Pty::IMAXBEL, 1),
    (Pty::IUTF8, 1),
    (Pty::ISIG, 1),
    (Pty::ICANON, 1),
    (Pty::ECHO, 1),
    (Pty::ECHOE, 1),
    (Pty::ECHOK, 1),
    (Pty::ECHONL, 0),
    (Pty::NOFLSH, 0),
    (Pty::TOSTOP, 0),
    (Pty::IEXTEN, 1),
    (Pty::ECHOCTL, 1),
    (Pty::ECHOKE, 1),
    (Pty::OPOST, 1),
    (Pty::OLCUC, 0),
    (Pty::ONLCR, 1),
    (Pty::OCRNL, 0),
    (Pty::ONOCR, 0),
    (Pty::ONLRET, 0),
    (Pty::CS7, 0),
    (Pty::CS8, 1),
    (Pty::PARENB, 0),
    (Pty::PARODD, 0),
    (Pty::TTY_OP_ISPEED, 38400),
    (Pty::TTY_OP_OSPEED, 38400),
];

pub(super) fn build_client_config(network: Option<&NetworkSettings>) -> Arc<client::Config> {
    let mut cfg = client::Config::default();
    let preferred = cfg.preferred.clone();
    cfg.preferred = russh::Preferred {
        kex: Cow::Borrowed(COMPAT_KEX_ORDER),
        key: Cow::Borrowed(COMPAT_HOST_KEY_ORDER),
        cipher: preferred.cipher,
        mac: Cow::Borrowed(COMPAT_MAC_ORDER),
        compression: preferred.compression,
    };
    if let Some(n) = network {
        if let Some(d) = n.keepalive_duration() {
            cfg.keepalive_interval = Some(d);
            cfg.keepalive_max = 3;
        }
    }
    Arc::new(cfg)
}
