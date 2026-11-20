//! MFA decodes the frames granted by the core for the invoking window.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::Value;
use taomni_plugin_api::{ErrorCode, RpcError, services::visit_luma_frames};
use taomni_plugin_sdk::Operation;

pub(super) const METHOD: &str = "mfa_scan_screen_codes";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scan {}

pub(super) fn capture_texts(
    operation: &Operation,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    serde_json::from_value::<Scan>(params.unwrap_or_else(|| serde_json::json!({})))
        .map_err(|_| RpcError::from_code(ErrorCode::InvalidParams))?;
    let bytes = operation.capture_still()?;
    let texts = decode(&bytes, &|| operation.check_current())?;
    serde_json::to_value(texts).map_err(|_| RpcError::from_code(ErrorCode::InternalError))
}

fn decode(bytes: &[u8], check: &dyn Fn() -> Result<(), RpcError>) -> Result<Vec<String>, RpcError> {
    let mut scanner = quircs::Quirc::default();
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    let mut inverted = Vec::new();
    // The transport has already checked the container without copying the
    // pixels. Reuse the detector and inverted-polarity buffer across displays.
    visit_luma_frames(bytes, |frame| {
        let mut read = |pixels: &[u8]| {
            check()?;
            for candidate in scanner.identify(frame.width as usize, frame.height as usize, pixels) {
                check()?;
                if let Ok(code) = candidate
                    && let Ok(data) = code.decode()
                    && let Ok(text) = String::from_utf8(data.payload)
                    && !text.is_empty()
                    && seen.insert(text.clone())
                {
                    found.push(text);
                }
            }
            check()
        };
        read(frame.luma)?;
        inverted.clear();
        inverted.extend(frame.luma.iter().map(|pixel| !pixel));
        read(&inverted)
    })?;
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    use taomni_plugin_api::services::{LumaFrameRef, encode_luma_frames};

    #[test]
    fn decodes_each_real_frame_and_deduplicates_existing_qr_values() {
        let fixture = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../qa-ui-auto-tests/synthetic-fixtures/mfa/hotp-qa-bank.png"
        ));
        let mut decoder = png::Decoder::new(std::io::Cursor::new(fixture));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().unwrap();
        let mut data = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut data).unwrap();
        let samples = info.color_type.samples();
        let luma = data[..info.buffer_size()]
            .chunks_exact(samples)
            .map(|pixel| pixel[0])
            .collect::<Vec<_>>();
        let frame = |luma| LumaFrameRef {
            width: info.width,
            height: info.height,
            luma,
        };
        let inverted: Vec<_> = luma.iter().map(|pixel| !pixel).collect();
        let frames = encode_luma_frames(&[frame(&luma), frame(&inverted)]).unwrap();
        let values = decode(&frames, &|| Ok(())).unwrap();
        assert_eq!(values.len(), 1);
        assert!(values[0].starts_with("otpauth://hotp/"));
        let inverted_only = encode_luma_frames(&[frame(&inverted)]).unwrap();
        assert_eq!(decode(&inverted_only, &|| Ok(())).unwrap(), values);
        assert!(
            decode(&frames, &|| Err(RpcError::from_code(
                ErrorCode::RequestCancelled
            )))
            .is_err()
        );
        let blank = encode_luma_frames(&[LumaFrameRef {
            width: 100,
            height: 100,
            luma: &[255; 10_000],
        }])
        .unwrap();
        assert!(decode(&blank, &|| Ok(())).unwrap().is_empty());
    }
}
