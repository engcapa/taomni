use super::*;

use std::time::Duration;

use tokio::net::TcpStream;

/// Live RDP fixtures commonly use a self-signed certificate. Keep the
/// production default fail-closed, while letting an operator explicitly
/// supply the known SHA-256 leaf pin for ignored live tests.
fn apply_live_certificate_pin(options: &mut RdpOptions) {
    let Ok(pin) = std::env::var("TAOMNI_RDP_LIVE_CERTIFICATE_FINGERPRINT") else {
        return;
    };
    if !pin.trim().is_empty() {
        options.certificate_fingerprint = Some(pin);
    }
}

mod input_and_channels;
mod live_credssp;
