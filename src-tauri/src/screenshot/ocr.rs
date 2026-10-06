//! OCR text extraction and automatic sensitive-information redaction.
//!
//! Engines, in order of preference (no user installation needed on Windows
//! or macOS):
//! - Windows: the built-in `Windows.Media.Ocr` engine (Windows 10+).
//! - macOS: the built-in Vision `VNRecognizeTextRequest` (10.15+).
//! - Linux, and a fallback everywhere: the `tesseract` CLI. Linux packages
//!   recommend `tesseract-ocr` + Chinese data so distro installs get it.
//!
//! Word-level bounding boxes feed the auto-redact pass, which locates e-mail
//! addresses, phone numbers and ID-like tokens.

use serde::Serialize;
use std::process::Command;

/// A single OCR'd word with its bounding box in physical pixels.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrWord {
    pub text: String,
    /// `block:paragraph:line`; words sharing it are on one text line.
    #[serde(skip)]
    pub line_key: String,
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

/// `Command` that never flashes a console window on Windows release builds.
fn tesseract_command() -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new("tesseract");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn tesseract_available() -> bool {
    tesseract_command()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Which engine OCR uses on this machine, if any.
pub fn engine_name() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    if super::ocr_windows::available() {
        return Some("windows");
    }
    #[cfg(target_os = "macos")]
    if super::ocr_macos::available() {
        return Some("vision");
    }
    tesseract_available().then_some("tesseract")
}

/// Platform-specific instructions shown when no OCR engine is usable.
pub fn install_hint() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows OCR has no installed recognition language. Open Settings > Time & language > Language & region, add a language (e.g. Chinese (Simplified) or English) including its OCR feature, then retry. Installing Tesseract also works."
    } else if cfg!(target_os = "macos") {
        "macOS text recognition is unavailable on this system. Install Tesseract (`brew install tesseract tesseract-lang`) and retry."
    } else {
        "OCR needs Tesseract. Install it with your package manager, e.g. `sudo apt install tesseract-ocr tesseract-ocr-chi-sim` (Debian/Ubuntu) or `sudo dnf install tesseract tesseract-langpack-chi_sim` (Fedora), then retry."
    }
}

/// Split one recognized line into word boxes. Engines that report only line
/// geometry (Vision) still need per-token boxes for redaction, so each
/// whitespace-separated token gets a slice of the line proportional to its
/// rendered width (CJK characters count double, as they are full-width).
pub fn split_line_words(
    text: &str,
    (x, y, w, h): (f64, f64, f64, f64),
    conf: f32,
    line_key: &str,
) -> Vec<OcrWord> {
    let weight = |c: char| if (c as u32) >= 0x2E80 { 2.0 } else { 1.0 };
    let total = text.chars().map(weight).sum::<f64>().max(1.0);
    let unit = w / total;
    let mut out = Vec::new();
    let mut offset = 0.0;
    let mut token: Option<(usize, f64)> = None;
    let mut push = |token: &str, start: f64, end: f64| {
        out.push(OcrWord {
            text: token.to_string(),
            line_key: line_key.to_string(),
            x: (x + start).round().max(0.0) as u32,
            y: y.round().max(0.0) as u32,
            w: (end - start).round().max(1.0) as u32,
            h: h.round().max(1.0) as u32,
            conf,
        });
    };
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            if let Some((start, start_offset)) = token.take() {
                push(&text[start..i], start_offset, offset);
            }
        } else if token.is_none() {
            token = Some((i, offset));
        }
        offset += weight(c) * unit;
    }
    if let Some((start, start_offset)) = token {
        push(&text[start..], start_offset, offset);
    }
    out
}

/// Reuse the native sensitive-token classifier for the bundled offline engine.
#[tauri::command]
pub fn screenshot_redact_tsv(tsv: String) -> Result<RedactResult, String> {
    if tsv.len() > 8 * 1024 * 1024 { return Err("OCR result exceeds size limit".into()); }
    let words: Vec<_> = parse_tsv_words(&tsv).into_iter().filter(|w| w.conf >= 30.0).collect();
    let boxes = find_sensitive(&words);
    Ok(RedactResult { count: boxes.len(), boxes })
}

/// Run tesseract on `path`, requesting TSV output for word boxes.
/// Returns `(tsv_text, langs_used)`.
fn run_tesseract_tsv(path: &str) -> Result<(String, String), String> {
    if !tesseract_available() {
        return Err(install_hint().to_string());
    }
    // Prefer Chinese+English; fall back to English only when the Chinese data
    // files are missing.
    for langs in ["chi_sim+eng", "eng"] {
        let out = tesseract_command()
            .arg(path)
            .arg("stdout")
            .arg("-l")
            .arg(langs)
            .arg("-c")
            .arg("tessedit_create_tsv=1")
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
            line_key: format!("{}:{}:{}", cols[2], cols[3], cols[4]),
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

/// Reading-order text: tesseract already emits words in reading order;
/// lines break on its own line keys.
fn words_to_text(words: &[OcrWord]) -> String {
    let mut text = String::new();
    let mut last_line: Option<&str> = None;
    for w in words {
        match last_line {
            Some(line) if line == w.line_key => text.push(' '),
            Some(_) => text.push('\n'),
            None => {}
        }
        text.push_str(&w.text);
        last_line = Some(&w.line_key);
    }
    text
}

/// Run OCR on an image file with the best available engine. Blocking; call
/// from `spawn_blocking`. A built-in engine that fails falls back to
/// tesseract when it is installed.
pub fn ocr_image(path: &str) -> Result<OcrResult, String> {
    #[allow(unused_mut)]
    let mut native_error: Option<String> = None;
    #[cfg(target_os = "windows")]
    if super::ocr_windows::available() {
        let attempt = image::open(path)
            .map_err(|e| format!("read image for OCR: {e}"))
            .and_then(|image| super::ocr_windows::recognize(&image.to_rgba8()));
        match attempt {
            Ok(result) => return Ok(finish(result.words, format!("windows:{}", result.langs))),
            Err(error) => native_error = Some(error),
        }
    }
    #[cfg(target_os = "macos")]
    if super::ocr_macos::available() {
        let attempt = std::fs::read(path)
            .map_err(|e| format!("read image for OCR: {e}"))
            .and_then(|bytes| {
                let (w, h) = image::image_dimensions(path).map_err(|e| e.to_string())?;
                super::ocr_macos::recognize(&bytes, w, h)
            });
        match attempt {
            Ok(result) => return Ok(finish(result.words, format!("vision:{}", result.langs))),
            Err(error) => native_error = Some(error),
        }
    }
    match run_tesseract_tsv(path) {
        Ok((tsv, langs)) => Ok(finish(parse_tsv_words(&tsv), langs)),
        Err(error) => Err(match native_error {
            Some(native) => format!("{native}\n{error}"),
            None => error,
        }),
    }
}

fn finish(words: Vec<OcrWord>, langs: String) -> OcrResult {
    let words: Vec<OcrWord> = words.into_iter().filter(|w| w.conf >= 30.0).collect();
    let text = words_to_text(&words);
    OcrResult { text, words, langs }
}

fn is_email(token: &str) -> bool {
    let token = token.trim_matches(|c: char| {
        !c.is_alphanumeric() && c != '@' && c != '.' && c != '_' && c != '-'
    });
    let parts: Vec<&str> = token.split('@').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return false;
    }
    let domain = parts[1];
    domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && domain
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
}

/// Calendar dates and times are digit runs with separators too; never
/// treat them as phone numbers.
fn looks_like_date_or_time(token: &str) -> bool {
    let groups: Vec<&str> = token
        .split(|c: char| matches!(c, '-' | '/' | '.' | ':'))
        .collect();
    if groups.len() < 2
        || groups
            .iter()
            .any(|g| g.is_empty() || !g.chars().all(|c| c.is_ascii_digit()))
    {
        return false;
    }
    let nums: Vec<u32> = groups.iter().filter_map(|g| g.parse().ok()).collect();
    let is_year = |g: &str, n: u32| g.len() == 4 && (1900..=2100).contains(&n);
    match nums.as_slice() {
        // YYYY-MM-DD / YYYY-MM
        [y, m, rest @ ..] if is_year(groups[0], *y) && (1..=12).contains(m) => {
            rest.first().is_none_or(|d| (1..=31).contains(d))
        }
        // DD/MM/YYYY or MM/DD/YYYY
        [a, b, y] if is_year(groups[2], *y) => (1..=31).contains(a) && (1..=31).contains(b),
        // HH:MM(:SS)
        [h, m, ..] if token.contains(':') => *h < 24 && *m < 60,
        _ => false,
    }
}

fn is_phone(token: &str) -> bool {
    let trimmed = token.trim_matches(|c: char| !c.is_ascii_digit() && c != '+' && c != '(');
    if trimmed.is_empty() || looks_like_date_or_time(trimmed) {
        return false;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | ' ' | '(' | ')' | '.'))
    {
        return false;
    }
    let digits: String = trimmed.chars().filter(|c| c.is_ascii_digit()).collect();
    // Chinese mobile: 11 digits, 1[3-9]...
    if digits.len() == 11 && digits.starts_with('1') && matches!(digits.as_bytes()[1], b'3'..=b'9')
    {
        return true;
    }
    // Chinese mobile with country code.
    if digits.len() == 13 && digits.starts_with("861") {
        return true;
    }
    // International / landline written with separators.
    let has_sep = trimmed
        .chars()
        .any(|c| matches!(c, '-' | ' ' | '+' | '(' | ')'));
    (8..=15).contains(&digits.len()) && has_sep
}

fn is_id_like(token: &str) -> bool {
    // Chinese ID: 18 chars (17 digits + digit/X). Strip surrounding labels
    // and punctuation such as `ID:` or a trailing comma.
    let start = token
        .find(|c: char| c.is_ascii_digit())
        .unwrap_or(token.len());
    let t = token[start..].trim_end_matches(|c: char| !c.is_ascii_alphanumeric());
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

fn classify(token: &str) -> Option<&'static str> {
    if is_email(token) {
        Some("email")
    } else if is_id_like(token) {
        Some("id")
    } else if is_phone(token) {
        Some("phone")
    } else {
        None
    }
}

fn union_box(words: &[OcrWord], kind: &str) -> RedactBox {
    let x0 = words.iter().map(|w| w.x).min().unwrap_or(0);
    let y0 = words.iter().map(|w| w.y).min().unwrap_or(0);
    let x1 = words.iter().map(|w| w.x + w.w).max().unwrap_or(0);
    let y1 = words.iter().map(|w| w.y + w.h).max().unwrap_or(0);
    let (w, h) = (x1 - x0, y1 - y0);
    // Slightly expand the box so the redaction fully covers the glyphs.
    let pad_x = ((w as f32 * 0.04) as u32).max(2);
    let pad_y = ((h as f32 * 0.12) as u32).max(2);
    RedactBox {
        x: x0.saturating_sub(pad_x),
        y: y0.saturating_sub(pad_y),
        w: w + pad_x * 2,
        h: h + pad_y * 2,
        kind: kind.to_string(),
    }
}

fn numeric_part(text: &str) -> bool {
    text.chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '(' | ')' | '.'))
}

/// Find sensitive tokens among OCR words and return their boxes. Tesseract
/// splits `+86 138-1234-5678` into several words, so runs of up to four
/// adjacent numeric words on one line are also tried (longest run first).
pub fn find_sensitive(words: &[OcrWord]) -> Vec<RedactBox> {
    let mut boxes = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let mut matched = None;
        for len in (1..=4).rev() {
            let end = i + len;
            if end > words.len() {
                continue;
            }
            let run = &words[i..end];
            if len > 1
                && (run.iter().any(|w| w.line_key != run[0].line_key)
                    || run.iter().any(|w| !numeric_part(&w.text)))
            {
                continue;
            }
            let joined = run
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(kind) = classify(&joined) {
                matched = Some((len, kind));
                break;
            }
        }
        match matched {
            Some((len, kind)) => {
                boxes.push(union_box(&words[i..i + len], kind));
                i += len;
            }
            None => i += 1,
        }
    }
    boxes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, x: u32, line: &str) -> OcrWord {
        OcrWord {
            text: text.to_string(),
            line_key: line.to_string(),
            x,
            y: 20,
            w: 10 * text.len() as u32,
            h: 30,
            conf: 95.0,
        }
    }

    #[test]
    fn email_detection() {
        assert!(is_email("user@example.com"));
        assert!(is_email("a.b_c-1@sub.domain.co"));
        assert!(is_email("(user@example.com),"));
        assert!(!is_email("not-an-email"));
        assert!(!is_email("user@nodot"));
        assert!(!is_email("@example.com"));
        assert!(!is_email("v1.2@3.4"));
    }

    #[test]
    fn phone_detection() {
        assert!(is_phone("13812345678"));
        assert!(is_phone("+86 138-1234-5678"));
        assert!(is_phone("010-12345678"));
        assert!(is_phone("(415) 555-0132"));
        assert!(!is_phone("12345"));
        assert!(!is_phone("hello world"));
        assert!(!is_phone("12345678901"), "1[0-2] is not a mobile prefix");
    }

    #[test]
    fn dates_and_times_are_not_phones() {
        for token in [
            "2024-01-01",
            "2024/12/31",
            "31/12/2024",
            "2024-01",
            "12:30:45",
            "2024.01.01",
        ] {
            assert!(!is_phone(token), "{token} misdetected as phone");
        }
    }

    #[test]
    fn id_detection() {
        assert!(is_id_like("110101199001011234"));
        assert!(is_id_like("11010119900101123X"));
        assert!(is_id_like("ID:110101199001011234,"));
        assert!(!is_id_like("11010119900101123"));
        assert!(!is_id_like("not an id"));
    }

    #[test]
    fn split_phone_numbers_are_joined() {
        let words = vec![
            word("Call", 0, "1:1:1"),
            word("+86", 60, "1:1:1"),
            word("138-1234-5678", 100, "1:1:1"),
            word("now", 240, "1:1:1"),
        ];
        let boxes = find_sensitive(&words);
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].kind, "phone");
        assert!(boxes[0].x <= 60 && boxes[0].x + boxes[0].w >= 230);
    }

    #[test]
    fn runs_do_not_cross_lines() {
        let words = vec![word("+86", 0, "1:1:1"), word("138-1234-5678", 0, "1:1:2")];
        let boxes = find_sensitive(&words);
        // Only the second line's number is a phone on its own.
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].w, 130 + 2 * 5);
    }

    #[test]
    fn line_boxes_split_into_proportional_word_boxes() {
        let words = split_line_words(
            "mail user@example.com now",
            (100.0, 50.0, 250.0, 20.0),
            90.0,
            "0:0:1",
        );
        let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["mail", "user@example.com", "now"]);
        // 25 chars over 250px -> 10px per char.
        assert_eq!((words[0].x, words[0].w), (100, 40));
        assert_eq!((words[1].x, words[1].w), (150, 160));
        assert_eq!((words[2].x, words[2].w), (320, 30));
        assert!(
            words
                .iter()
                .all(|w| w.y == 50 && w.h == 20 && w.line_key == "0:0:1")
        );
        let boxes = find_sensitive(&words);
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].kind, "email");
    }

    #[test]
    fn cjk_tokens_count_as_full_width() {
        // 2 CJK (weight 4) + space + 11 digits = 16 units over 160px.
        let words = split_line_words("电话 13812345678", (0.0, 0.0, 160.0, 20.0), 90.0, "k");
        assert_eq!(words.len(), 2);
        assert_eq!((words[0].x, words[0].w), (0, 40));
        assert_eq!((words[1].x, words[1].w), (50, 110));
        assert_eq!(find_sensitive(&words)[0].kind, "phone");
    }

    #[test]
    fn low_confidence_words_are_dropped_for_every_engine() {
        let mut low = word("noise", 0, "1:1:1");
        low.conf = 10.0;
        let result = finish(vec![low, word("kept", 60, "1:1:1")], "test".into());
        assert_eq!(result.text, "kept");
        assert_eq!(result.words.len(), 1);
    }

    #[test]
    fn tsv_parsing_and_text_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
5\t1\t1\t1\t1\t1\t10\t20\t100\t30\t95.5\thello\n\
5\t1\t1\t1\t1\t2\t120\t20\t80\t30\t96.0\tuser@example.com\n\
5\t1\t1\t1\t2\t1\t10\t60\t80\t30\t96.0\t2024-01-01\n";
        let words = parse_tsv_words(tsv);
        assert_eq!(words.len(), 3);
        assert_eq!(words[1].text, "user@example.com");
        assert_eq!(words[1].x, 120);
        assert_eq!(words_to_text(&words), "hello user@example.com\n2024-01-01");
        let boxes = find_sensitive(&words);
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].kind, "email");
    }
}
