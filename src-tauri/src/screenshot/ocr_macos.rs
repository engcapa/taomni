//! Built-in macOS OCR (Vision `VNRecognizeTextRequest`, macOS 10.15+;
//! Simplified Chinese on 13+). Ships with the OS, so nothing is installed.

use objc2::AnyThread;
use objc2::rc::Retained;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
use objc2_vision::{
    VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
};

use super::ocr::{OcrWord, split_line_words};

pub struct MacOcr {
    pub words: Vec<OcrWord>,
    pub langs: String,
}

pub fn available() -> bool {
    // Present on every supported macOS (Taomni requires 10.15+).
    true
}

/// Recognize a PNG-encoded image of `width`x`height` physical pixels.
pub fn recognize(png: &[u8], width: u32, height: u32) -> Result<MacOcr, String> {
    objc2::rc::autoreleasepool(|_| recognize_inner(png, width, height))
}

fn recognize_inner(png: &[u8], width: u32, height: u32) -> Result<MacOcr, String> {
    let data = NSData::with_bytes(png);
    let options = NSDictionary::new();
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &options,
    );
    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    request.setUsesLanguageCorrection(true);
    // Only request languages this OS version supports; Chinese needs 13+.
    let supported: Vec<String> = unsafe { request.supportedRecognitionLanguagesAndReturnError() }
        .map(|langs| langs.iter().map(|l| l.to_string()).collect())
        .unwrap_or_default();
    let wanted: Vec<&str> = ["zh-Hans", "en-US"]
        .into_iter()
        .filter(|l| supported.iter().any(|s| s == l))
        .collect();
    let langs = if wanted.is_empty() { vec!["en-US"] } else { wanted };
    let ns_langs: Vec<Retained<NSString>> = langs.iter().map(|l| NSString::from_str(l)).collect();
    request.setRecognitionLanguages(&NSArray::from_retained_slice(&ns_langs));
    let requests: Retained<NSArray<VNRequest>> =
        NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(request.clone()))]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("macOS Vision OCR failed: {}", e.localizedDescription()))?;
    let mut words = Vec::new();
    if let Some(observations) = request.results() {
        for (line_index, observation) in observations.iter().enumerate() {
            let candidates = observation.topCandidates(1);
            let Some(best) = candidates.firstObject() else { continue };
            let text = best.string().to_string();
            if text.trim().is_empty() {
                continue;
            }
            // Normalized, bottom-left origin -> top-left physical pixels.
            let b = unsafe { observation.boundingBox() };
            let x = (b.origin.x * width as f64).max(0.0);
            let w = (b.size.width * width as f64).max(1.0);
            let h = (b.size.height * height as f64).max(1.0);
            let y = ((1.0 - b.origin.y - b.size.height) * height as f64).max(0.0);
            let conf = best.confidence() * 100.0;
            words.extend(split_line_words(&text, (x, y, w, h), conf, &format!("0:0:{line_index}")));
        }
    }
    Ok(MacOcr { words, langs: langs.join("+") })
}
