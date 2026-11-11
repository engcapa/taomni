//! A text tail, deliberately not a virtual terminal screen snapshot.
use std::collections::VecDeque;
const MAX_LINES: usize = 1000;
const MAX_BYTES: usize = 512 * 1024;
const MAX_LINE: usize = 16 * 1024;

#[derive(Default)]
pub struct Replay {
    lines: VecDeque<String>,
    line: String,
    pending: Vec<u8>,
    carriage: bool,
    truncated: bool,
    bytes: usize,
}
impl Replay {
    pub fn push(&mut self, data: &[u8]) {
        self.pending.extend_from_slice(data);
        let mut text = String::new();
        let mut offset = 0;
        while offset < self.pending.len() {
            match std::str::from_utf8(&self.pending[offset..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    offset = self.pending.len();
                }
                Err(error) => {
                    let end = offset + error.valid_up_to();
                    text.push_str(std::str::from_utf8(&self.pending[offset..end]).unwrap());
                    offset = end;
                    if let Some(length) = error.error_len() {
                        text.push('�');
                        offset += length;
                    } else {
                        break;
                    } // retain at most three incomplete UTF-8 bytes
                }
            }
        }
        self.pending.drain(..offset);
        for ch in text.chars() {
            if self.carriage && ch != '\n' {
                self.line.clear();
                self.truncated = false;
            }
            self.carriage = false;
            match ch {
                '\r' => self.carriage = true,
                '\n' => {
                    let line = std::mem::take(&mut self.line);
                    self.bytes += line.len();
                    self.lines.push_back(line);
                    self.truncated = false;
                }
                _ if !self.truncated => {
                    if self.line.len() + ch.len_utf8() > MAX_LINE - 32 {
                        self.line.push_str(" …[truncated]");
                        self.truncated = true;
                    } else {
                        self.line.push(ch);
                    }
                }
                _ => {}
            }
        }
        while self.lines.len() + 1 > MAX_LINES || self.bytes + self.line.len() > MAX_BYTES {
            if let Some(old) = self.lines.pop_front() {
                self.bytes -= old.len();
            } else {
                break;
            }
        }
    }
    pub fn lines(&self) -> Vec<String> {
        self.lines
            .iter()
            .cloned()
            .chain(std::iter::once(self.line.clone()))
            .collect()
    }

    pub fn summary(&self) -> String {
        std::iter::once(&self.line)
            .chain(self.lines.iter().rev())
            .find_map(|line| {
                let cleaned = plain_line(line);
                (!cleaned.is_empty()).then(|| cleaned.chars().take(160).collect())
            })
            .unwrap_or_default()
    }

    /// Most recent cleaned output, for a chat-sized snapshot. Lines are taken
    /// from the end so a busy terminal shows what just happened; when the cap
    /// is exceeded the oldest visible text is dropped, not the newest.
    pub fn tail(&self, max_lines: usize, max_chars: usize) -> String {
        let mut lines: Vec<String> = Vec::new();
        for line in self.lines().iter().rev() {
            let clean = plain_line(line);
            if clean.is_empty() && lines.is_empty() {
                continue;
            }
            lines.push(clean);
            if lines.len() >= max_lines.max(1) {
                break;
            }
        }
        lines.reverse();
        while lines.last().is_some_and(|line| line.is_empty()) {
            lines.pop();
        }
        let text = lines.join("\n");
        if text.chars().count() <= max_chars {
            return text;
        }
        let skip = text.chars().count() - max_chars.max(1);
        let mut clipped: String = text.chars().skip(skip).collect();
        clipped.insert(0, '…');
        clipped
    }
}

fn plain_line(line: &str) -> String {
    let mut clean = String::new();
    let mut chars = line.chars();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    let mut previous_escape = false;
                    for c in chars.by_ref() {
                        if c == '\x07' || (c == '\\' && previous_escape) {
                            break;
                        }
                        previous_escape = c == '\x1b';
                    }
                }
                _ => {}
            }
            continue;
        }
        if !ch.is_control() {
            clean.push(ch);
        }
    }
    clean.trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_uses_latest_nonempty_clean_line() {
        let mut r = Replay::default();
        r.push(b"old output\n\x1b[31mDatabase maintenance\x1b[0m\n\n");
        assert_eq!(r.summary(), "Database maintenance");
        r.push(b"\x1b[32mReady without newline\x1b[0m");
        assert_eq!(r.summary(), "Ready without newline");
        r.push(b"\x1b]0;title\x07");
        assert_eq!(r.summary(), "Ready without newline");
    }

    #[test]
    fn tail_keeps_the_newest_clean_lines() {
        let mut r = Replay::default();
        r.push(b"one\r\n\x1b[32mtwo\x1b[0m\r\nthree\r\n");
        assert_eq!(r.tail(2, 100), "two\nthree");
        assert_eq!(r.tail(10, 100), "one\ntwo\nthree");
        assert_eq!(r.tail(10, 5), "…three");
        r.push(b"\n\n");
        assert_eq!(r.tail(2, 100), "two\nthree");
        r.push(b"partial");
        assert_eq!(r.tail(1, 100), "partial");
    }

    #[test]
    fn summary_caps_long_output() {
        let mut r = Replay::default();
        r.push(format!("{}\n", "x".repeat(300)).as_bytes());
        assert_eq!(r.summary().chars().count(), 160);
    }

    #[test]
    fn malformed_chunks_are_iterative_and_preserve_trailing_ascii() {
        let mut r = Replay::default();
        r.push(&vec![0xff; 65536]);
        r.push(b"\nend\xffok");
        assert_eq!(r.lines().last().unwrap(), "end�ok");
        assert!(r.pending.is_empty());
    }

    #[test]
    fn bounded_tail_handles_split_unicode_and_carriage_returns() {
        let mut r = Replay::default();
        r.push(&[0xe4, 0xb8]);
        r.push(&[0xad, b'\r']);
        r.push(b"20%\r100%\r\nnext");
        assert_eq!(r.lines(), vec!["100%", "next"]);
        let mut r = Replay::default();
        r.push(&[0xe4]);
        r.push(&[0xb8, 0xad]);
        assert_eq!(r.lines(), vec!["中"]);
        r.push(&vec![b'x'; 1_000_000]);
        assert!(r.lines()[0].len() <= MAX_LINE);
        assert!(r.lines()[0].contains("truncated"));
        for _ in 0..2000 {
            r.push(b"\nline");
        }
        assert_eq!(r.lines().len(), MAX_LINES);
        assert!(r.lines().iter().map(String::len).sum::<usize>() <= MAX_BYTES);
    }
}
