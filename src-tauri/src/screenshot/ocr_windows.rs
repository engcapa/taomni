//! Built-in Windows OCR (`Windows.Media.Ocr`, Windows 10+). Needs no download:
//! it uses the OCR language packs installed with the user's display/input
//! languages (Settings > Time & language > Language adds more).

use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::core::HSTRING;

use super::ocr::OcrWord;

/// Languages tried first; the user's profile languages follow.
const PREFERRED: [&str; 3] = ["zh-Hans-CN", "zh-CN", "en-US"];

pub struct WindowsOcr {
    pub words: Vec<OcrWord>,
    pub langs: String,
}

pub fn available() -> bool {
    OcrEngine::AvailableRecognizerLanguages()
        .and_then(|langs| langs.Size())
        .map(|n| n > 0)
        .unwrap_or(false)
}

/// Engines for the preferred CJK + Latin languages that are installed, else
/// the user-profile engine. Chinese engines also read Latin text, so one
/// engine is usually enough; English is added when Chinese is missing.
fn engines() -> windows::core::Result<Vec<(String, OcrEngine)>> {
    let mut out = Vec::new();
    for tag in PREFERRED {
        let Ok(language) = Language::CreateLanguage(&HSTRING::from(tag)) else {
            continue;
        };
        if !OcrEngine::IsLanguageSupported(&language).unwrap_or(false) {
            continue;
        }
        if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&language) {
            let is_cjk = tag.starts_with("zh");
            out.push((tag.to_string(), engine));
            if is_cjk {
                break;
            }
        }
    }
    if out.is_empty() {
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let tag = engine
            .RecognizerLanguage()
            .and_then(|l| l.LanguageTag())
            .map(|t| t.to_string())
            .unwrap_or_else(|_| "user-profile".into());
        out.push((tag, engine));
    }
    Ok(out)
}

/// Recognize `image` (RGBA). Images larger than the engine's limit are
/// downscaled and boxes mapped back to the original pixel grid.
pub fn recognize(image: &image::RgbaImage) -> Result<WindowsOcr, String> {
    let max = OcrEngine::MaxImageDimension().unwrap_or(10_000).max(1);
    let (w, h) = image.dimensions();
    let k = (max as f64 / w.max(h) as f64).min(1.0);
    let scaled;
    let source = if k < 1.0 {
        scaled = image::imageops::resize(
            image,
            ((w as f64 * k).round() as u32).max(1),
            ((h as f64 * k).round() as u32).max(1),
            image::imageops::FilterType::Triangle,
        );
        &scaled
    } else {
        image
    };
    let mut bgra = source.as_raw().clone();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let buffer = CryptographicBuffer::CreateFromByteArray(&bgra).map_err(|e| e.to_string())?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        source.width() as i32,
        source.height() as i32,
    )
    .and_then(|b| SoftwareBitmap::ConvertWithAlpha(&b, BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied))
    .map_err(|e| format!("prepare OCR bitmap: {e}"))?;
    let engines = engines().map_err(|e| {
        format!("Windows OCR has no installed language ({e}). Add a language with OCR support in Settings > Time & language > Language & region.")
    })?;
    let mut best: Option<WindowsOcr> = None;
    for (tag, engine) in engines {
        let result = engine
            .RecognizeAsync(&bitmap)
            .and_then(|op| op.join())
            .map_err(|e| format!("Windows OCR failed: {e}"))?;
        let mut words = Vec::new();
        let lines = result.Lines().map_err(|e| e.to_string())?;
        for (line_index, line) in lines.into_iter().enumerate() {
            let Ok(line_words) = line.Words() else { continue };
            for word in line_words {
                let (Ok(text), Ok(rect)) = (word.Text(), word.BoundingRect()) else {
                    continue;
                };
                let text = text.to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let inv = 1.0 / k;
                words.push(OcrWord {
                    text,
                    line_key: format!("0:0:{line_index}"),
                    x: (rect.X as f64 * inv).round().max(0.0) as u32,
                    y: (rect.Y as f64 * inv).round().max(0.0) as u32,
                    w: (rect.Width as f64 * inv).round().max(1.0) as u32,
                    h: (rect.Height as f64 * inv).round().max(1.0) as u32,
                    // Windows OCR exposes no confidence; accepted words pass the filter.
                    conf: 100.0,
                });
            }
        }
        let better = best.as_ref().is_none_or(|b| words.len() > b.words.len());
        if better {
            best = Some(WindowsOcr { words, langs: tag });
        }
    }
    best.ok_or_else(|| "Windows OCR is unavailable".to_string())
}
