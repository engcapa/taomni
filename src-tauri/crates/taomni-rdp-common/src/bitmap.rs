//! Bitmap capability offer shared with server decoder-contract tests.

/// Every advertised codec must be decodable by the endpoint's session driver.
/// The application keeps IronRDP's QOI/QOIZ decoder features enabled together
/// with this offer; the server loopback contracts verify the pairing.
pub fn client_bitmap_codecs() -> ironrdp_pdu::rdp::capability_sets::BitmapCodecs {
    ironrdp_pdu::rdp::capability_sets::client_codecs_capabilities(&["remotefx"]).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironrdp_pdu::rdp::capability_sets::CodecProperty;

    #[test]
    fn client_offer_keeps_remotefx_and_lossless_codecs() {
        let codecs = client_bitmap_codecs();
        assert!(
            codecs
                .0
                .iter()
                .any(|codec| matches!(codec.property, CodecProperty::RemoteFx(_)))
        );
        assert!(
            codecs
                .0
                .iter()
                .any(|codec| matches!(codec.property, CodecProperty::Qoi))
        );
        assert!(
            codecs
                .0
                .iter()
                .any(|codec| matches!(codec.property, CodecProperty::QoiZ))
        );
    }
}
