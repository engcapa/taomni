//! Neither the read scratch buffer nor a complete sensitive JSON line ever
//! lives in a String/BufReader/Value. Buffer growth clears the old allocation.
use serde::Deserialize;
use serde_json::value::RawValue;
use std::io::{self, Read};
use taomni_plugin_api::RequestId;
use zeroize::{Zeroize, Zeroizing};

pub(crate) const MAX_FRAME: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
pub(crate) struct Envelope<'a> {
    pub jsonrpc: &'a str,
    pub id: Option<RequestId>,
    pub method: Option<&'a str>,
    #[serde(borrow)]
    pub result: Option<&'a RawValue>,
    #[serde(borrow)]
    pub error: Option<&'a RawValue>,
}

pub(crate) struct LineReader<R> {
    reader: R,
    scratch: Zeroizing<[u8; 8192]>,
    position: usize,
    filled: usize,
}

impl<R: Read> LineReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            scratch: Zeroizing::new([0; 8192]),
            position: 0,
            filled: 0,
        }
    }

    pub fn next(&mut self) -> io::Result<Option<Zeroizing<Vec<u8>>>> {
        let mut line = Zeroizing::new(Vec::with_capacity(512));
        loop {
            if self.position == self.filled {
                self.scratch.zeroize();
                self.filled = self.reader.read(self.scratch.as_mut_slice())?;
                self.position = 0;
                if self.filled == 0 {
                    return if line.is_empty() {
                        Ok(None)
                    } else {
                        Err(invalid_frame())
                    };
                }
            }
            let available = &self.scratch[self.position..self.filled];
            let count = available.iter().position(|byte| *byte == b'\n');
            let end = count.unwrap_or(available.len());
            let needed = line.len().checked_add(end).ok_or_else(invalid_frame)?;
            if needed > MAX_FRAME {
                return Err(invalid_frame());
            }
            if needed > line.capacity() {
                let mut replacement =
                    Zeroizing::new(Vec::with_capacity(needed.max(line.capacity() * 2)));
                replacement.extend_from_slice(&line);
                line.zeroize();
                line = replacement;
            }
            line.extend_from_slice(&available[..end]);
            let consumed = end + usize::from(count.is_some());
            self.scratch[self.position..self.position + consumed].zeroize();
            self.position += consumed;
            if count.is_some() {
                return Ok(Some(line));
            }
        }
    }
}

pub(crate) fn invalid_frame() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid plugin control frame")
}
