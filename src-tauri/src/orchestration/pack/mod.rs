mod manifest;
mod records;

#[cfg(test)]
mod tests;

pub use manifest::PackManifest;

use crate::orchestration::core::model::AgentArtifact;
use std::collections::HashSet;

const MAX_RECORD: usize = 64 * 1024;
const MAX_ITEM: usize = 512 * 1024;

/// Owns one attempt's immutable manifest and candidate queue. Drain the queue
/// even when feed/finish returns Err: earlier complete items are still safe
/// candidates, not a claim that their publication group passed validation.
pub struct FrameCollector {
    manifest: PackManifest,
    buffer: Vec<u8>,
    started: bool,
    ended: bool,
    group_ended: bool,
    current: Option<Item>,
    completed: HashSet<String>,
    saved: Vec<AgentArtifact>,
    failure: Option<String>,
}

struct Item {
    id: String,
    name: String,
    format: String,
    next: u64,
    text: String,
}

impl FrameCollector {
    pub fn new(manifest: &PackManifest) -> Self {
        Self {
            manifest: manifest.clone(),
            buffer: Vec::new(),
            started: false,
            ended: false,
            group_ended: false,
            current: None,
            completed: HashSet::new(),
            saved: Vec::new(),
            failure: None,
        }
    }

    pub fn feed(&mut self, text: &str) -> Result<(), String> {
        self.feed_bytes(text.as_bytes())
    }

    /// Byte-oriented input also supports UTF-8 codepoints split across reads.
    /// The normal LLM callback can use feed(&str) without lossy conversion.
    pub fn feed_bytes(&mut self, bytes: &[u8]) -> Result<(), String> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = self.feed_inner(bytes);
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result
    }

    fn feed_inner(&mut self, bytes: &[u8]) -> Result<(), String> {
        // Accumulate only a bounded physical record, never the whole response.
        for segment in bytes.split_inclusive(|byte| *byte == b'\n') {
            let complete = segment.last() == Some(&b'\n');
            let segment = if complete {
                &segment[..segment.len() - 1]
            } else {
                segment
            };
            if self.buffer.len() + segment.len() > MAX_RECORD {
                return Err("FRAME_LIMIT: output record is too large".into());
            }
            self.buffer.extend_from_slice(segment);
            if complete {
                self.line()?;
            }
        }
        Ok(())
    }

    fn line(&mut self) -> Result<(), String> {
        let bytes = std::mem::take(&mut self.buffer);
        let line = std::str::from_utf8(&bytes)
            .map_err(|_| "INVALID_FRAME: invalid UTF-8 in NDJSON record")?
            .trim();
        if line.is_empty() {
            return Ok(());
        }
        let value =
            serde_json::from_str(line).map_err(|_| "INVALID_FRAME: malformed NDJSON record")?;
        self.record(value)
    }

    pub fn drain_saved(&mut self) -> Vec<AgentArtifact> {
        std::mem::take(&mut self.saved)
    }

    pub fn finish(&mut self) -> Result<(), String> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        // A final NDJSON record may omit its final newline, but must still be a
        // complete JSON record with an explicit pack_end and closed group.
        let result: Result<(), String> = (|| {
            if !self.buffer.is_empty() {
                self.line()?;
            }
            if !self.ended || self.current.is_some() {
                return Err(
                    "INCOMPLETE_PACK: retain complete candidates and request explicit recovery"
                        .into(),
                );
            }
            Ok(())
        })();
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result
    }
}
