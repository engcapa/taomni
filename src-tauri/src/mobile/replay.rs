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
}
#[cfg(test)]
mod tests {
    use super::*;
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
