//! SMTP delivery using an endpoint selected by the caller's network policy.

#[cfg(feature = "routed-smtp")]
mod routed;
#[cfg(feature = "routed-smtp")]
pub use routed::{check_routed_connection, send_prepared_response, send_routed_message};

#[cfg(feature = "legacy-smtp")]
mod legacy;
#[cfg(feature = "legacy-smtp")]
pub use legacy::{SmtpClient, SmtpEndpoint};

use crate::tls::certificate_error_hint;

fn send_error(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    let too_big = lower.contains("552")
        || lower.contains("message size")
        || lower.contains("too large")
        || lower.contains("exceeds") && lower.contains("size");
    if too_big {
        format!(
            "SMTP send failed: the message is larger than this server accepts (SIZE limit). Remove or shrink attachments, or share them as links. Server said: {error}"
        )
    } else {
        certificate_error_hint(&format!("SMTP send failed: {error}"), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smtp_size_rejections_get_a_hint() {
        assert!(
            send_error("permanent error (552): 5.3.4 Message size exceeds fixed limit")
                .contains("SIZE limit")
        );
        assert_eq!(
            send_error("permanent error (550): no such user"),
            "SMTP send failed: permanent error (550): no such user"
        );
    }
}
