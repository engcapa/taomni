const MAX_EVENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Event {
    pub kind: String,
    pub data: String,
}

/// Byte-oriented framing: UTF-8 is decoded only after a whole line is available.
/// Handles LF, CRLF and CR, including CRLF and codepoints split across reads.
#[derive(Default)]
pub(super) struct SseDecoder {
    line: Vec<u8>,
    data: String,
    kind: String,
    has_data: bool,
    skip_lf: bool,
    started: bool,
}

impl SseDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Event>, String> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => {
                    self.end_line(&mut events)?;
                    self.skip_lf = true;
                }
                b'\n' => self.end_line(&mut events)?,
                _ => {
                    if self.line.len() >= MAX_EVENT_BYTES {
                        return Err("Invocation SSE line exceeds size limit".into());
                    }
                    self.line.push(byte);
                }
            }
        }
        Ok(events)
    }

    fn end_line(&mut self, events: &mut Vec<Event>) -> Result<(), String> {
        let line = std::mem::take(&mut self.line);
        let mut line =
            std::str::from_utf8(&line).map_err(|_| "Invalid UTF-8 in invocation SSE stream")?;
        if !self.started {
            self.started = true;
            line = line.strip_prefix('\u{feff}').unwrap_or(line);
        }
        if line.is_empty() {
            if self.has_data {
                self.data.pop(); // Remove only the final SSE-inserted newline.
                events.push(Event {
                    kind: std::mem::take(&mut self.kind),
                    data: std::mem::take(&mut self.data),
                });
                self.has_data = false;
            }
            self.kind.clear();
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "data" => {
                if self.data.len() + value.len() + 1 > MAX_EVENT_BYTES {
                    return Err("Invocation SSE event exceeds size limit".into());
                }
                self.data.push_str(value);
                self.data.push('\n');
                self.has_data = true;
            }
            "event" => self.kind = value.to_owned(),
            _ => {} // id/retry never cause reconnection or another invocation.
        }
        Ok(())
    }

    pub fn finish(self) -> Result<(), String> {
        // Do not turn an unterminated partial data event into a successful stop.
        if !self.line.is_empty() || self.has_data {
            Err("Invocation stream ended inside an SSE event".into())
        } else {
            Ok(())
        }
    }
}
