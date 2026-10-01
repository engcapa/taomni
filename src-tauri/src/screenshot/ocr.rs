//! OCR text extraction and automatic sensitive-information redaction.
//!
//! Uses the `tesseract` CLI when available (no linked native dependency, so
//! the build stays portable across Windows / Linux / macOS). TSV output gives
//! word-level bounding boxes, which the auto-redact pass uses to locate
//! e-mail addresses, phone numbers and ID-like tokens.

use serde::Serialize;
use std::process::Command;

/// A single OCR'd word with its bounding box in physical pixels.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub conf: f32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub words: Vec<OcrWord>,
    /// Which languages were requested (best effort).
    pub langs: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactBox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// What kind of sensitive token was matched (`email`, `phone`, `id`).
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactResult {
    pub boxes: Vec<RedactBox>,
    pub count: usize,
}

fn tesseract_available() -> bool {
    Command::new("tesseract")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run tesseract on `path`, requesting TSV output for word boxes.
/// Returns `(tsv_text, langs_used)`.
fn run_tesseract_tsv(path: &str) -> Result<(String, String), String> {
    if !tesseract_available() {
        return Err(
            "tesseract is not installed. Install it to use OCR (e.g. `brew install tesseract`, `apt install tesseract-ocr tesseract-ocr-chi-sim`)."
                .to_string(),
        );
    }
    // Prefer Chinese+English; fall back to English only when the Chinese data
    // files are missing.
    for langs in ["chi_sim+eng", "eng"] {
        let out = Command::new("tesseract")
            .arg(path)
            .arg("stdout")
            .arg("-l")
            .arg(langs)
            .arg("tsv")
            .output()
            .map_err(|e| format!("run tesseract: {e}"))?;
        if out.status.success() {
            let tsv = String::from_utf8_lossy(&out.stdout).into_owned();
            return Ok((tsv, langs.to_string()));
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        // Missing language data -> try the next fallback.
        if !stderr.contains("Error opening data file")
            && !stderr.contains("Failed loading language")
        {
            return Err(format!("tesseract failed: {}", stderr.trim()));
        }
    }
    Err("tesseract failed: no usable language data".to_string())
}

/// Parse tesseract TSV output (level 5 = word rows).
fn parse_tsv_words(tsv: &str) -> Vec<OcrWord> {
    let mut words = Vec::new();
    let mut lines = tsv.lines();
    let header = lines.next().unwrap_or("");
    if !header.starts_with("level") {
        return words;
    }
    for line in lines {
        let cols: Vec<&str> = line.split('\t').collect();
        // level, page_num, block_num, par_num, line_num, word_num,
        // left, top, width, height, conf, text
        if cols.len() < 12 || cols[0] != "5" {
            continue;
        }
        let text = cols[11].trim().to_string();
        if text.is_empty() {
            continue;
        }
        let parse_u = |s: &str| s.parse::<u32>().unwrap_or(0);
        words.push(OcrWord {
            x: parse_u(cols[6]),
            y: parse_u(cols[7]),
            w: parse_u(cols[8]),
            h: parse_u(cols[9]),
            conf: cols[10].parse::<f32>().unwrap_or(-1.0),
            text,
        });
    }
    words
}

/// Run OCR on an image file. Blocking; call from `spawn_blocking`.
pub fn ocr_image(path: &str) -> Result<OcrResult, String> {
    let (tsv, langs) = run_tesseract_tsv(path)?;
    let words: Vec<OcrWord> = parse_tsv_words(&tsv)
        .into_iter()
        .filter(|w| w.conf >= 30.0)
        .collect();
    // Reconstruct reading-order text: group words by line (y overlap).
    let mut text = String::new();
    let mut sorted = words.clone();
    sorted.sort_by(|a, b| {
        let ay = a.y / 10;
        let by = b.y / 10;
        ay.cmp(&by).then(a.x.cmp(&b.x))
    });
    let mut last_line = u32::MAX;
    for w in &sorted {
        let line = w.y / 10;
        if line != last_line {
            if !text.is_empty() {
                text.push('\n');
            }
            last_line = line;
        } else if !text.is_empty() && !text.ends_with('\n') {
            text.push(' ');
        }
        text.push_str(&w.text);
    }
    Ok(OcrResult { text, words, langs })
}

fn is_email(token: &str) -> bool {
    let token = token.trim_matches(|c: char| {
        !c.is_alphanumeric() && c != '@' && c != '.' && c != '_' && c != '-'
    });
    let parts: Vec<&str> = token.split('@').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return false;
    }
    parts[1].contains('.') && !parts[1].starts_with('.') && !parts[1].ends_with('.')
}

fn is_phone(token: &str) -> bool {
    let digits: String = token.chars().filter(|c| c.is_ascii_digit()).collect();
    // Chinese mobile (11 digits starting with 1), landline-ish, or
    // international with separators: 7-15 digits total.
    if digits.len() == 11 && digits.starts_with('1') {
        return true;
    }
    if (7..=15).contains(&digits.len()) && token.chars().any(|c| c == '-' || c == ' ' || c == '+') {
        return true;
    }
    false
}

fn is_id_like(token: &str) -> bool {
    // Chinese ID: 18 chars (17 digits + digit/X).
    let t = token.trim();
    if t.len() != 18 {
        return false;
    }
    let (head, tail) = t.split_at(17);
    if !head.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let last = tail.chars().next().unwrap_or(' ');
    last.is_ascii_digit() || last == 'X' || last == 'x'
}

/// Find sensitive tokens among OCR words and return their boxes.
pub fn find_sensitive(words: &[OcrWord]) -> Vec<RedactBox> {
    let mut boxes = Vec::new();
    for w in words {
        let kind = if is_email(&w.text) {
            "email"
        } else if is_phone(&w.text) {
            "phone"
        } else if is_id_like(&w.text) {
            "id"
        } else {
            continue;
        };
        // Slightly expand the box so the redaction fully covers the glyphs.
        let pad_x = (w.w as f32 * 0.05) as u32;
        let pad_y = (w.h as f32 * 0.1) as u32;
        boxes.push(RedactBox {
            x: w.x.saturating_sub(pad_x),
            y: w.y.saturating_sub(pad_y),
            w: w.w + pad_x * 2,
            h: w.h + pad_y * 2,
            kind: kind.to_string(),
        });
    }
    boxes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_detection() {
        assert!(is_email("user@example.com"));
        assert!(is_email("a.b_c-1@sub.domain.co"));
        assert!(!is_email("not-an-email"));
        assert!(!is_email("user@nodot"));
        assert!(!is_email("@example.com"));
    }

    #[test]
    fn phone_detection() {
        assert!(is_phone("13812345678"));
        assert!(is_phone("+86 138-1234-5678"));
        assert!(is_phone("010-12345678"));
        assert!(!is_phone("12345"));
        assert!(!is_phone("hello world"));
    }

    #[test]
    fn id_detection() {
        assert!(is_id_like("110101199001011234"));
        assert!(is_id_like("11010119900101123X"));
        assert!(!is_id_like("11010119900101123"));
        assert!(!is_id_like("not an id"));
    }

    #[test]
    fn tsv_parsing() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t100\t30\t95.5\thello\n5\t1\t1\t1\t1\t2\t120\t20\t80\t30\t96.0\tuser@example.com\n";
        let words = parse_tsv_words(tsv);
        assert_eq!(words.len(), 2);
        assert_eq!(words[1].text, "user@example.com");
        assert_eq!(words[1].x, 120);
        let boxes = find_sensitive(&words);
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].kind, "email");
    }
}
