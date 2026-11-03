use serde_json::Value;
use std::collections::HashSet;

use crate::orchestration::core::model::{AgentArtifact, digest};

use super::manifest::exact_ids;
use super::{FrameCollector, Item, MAX_ITEM};

impl FrameCollector {
    pub(super) fn record(&mut self, value: Value) -> Result<(), String> {
        if self.ended {
            return Err("INVALID_FRAME: data after pack end".into());
        }
        self.identities(&value)?;
        let kind = value["type"]
            .as_str()
            .ok_or("INVALID_FRAME: missing type")?;
        if !self.started && kind != "pack_start" {
            return Err("INVALID_FRAME: missing pack start".into());
        }
        match kind {
            "pack_start" => self.start(&value)?,
            "item_header" => self.header(&value)?,
            "item_chunk" => self.chunk(&value)?,
            "item_end" => self.item_end(&value)?,
            "group_end" => {
                if self.current.is_some()
                    || self.group_ended
                    || value["group_id"].as_str() != Some(self.manifest.group_id())
                    || !self.items_match(&value["item_ids"])
                {
                    return Err("INVALID_FRAME: incomplete publication group".into());
                }
                self.group_ended = true;
            }
            "pack_end" => {
                if !self.group_ended
                    || self.current.is_some()
                    || !self.items_match(&value["item_ids"])
                    || !value["blocked_ids"].as_array().is_some_and(Vec::is_empty)
                {
                    return Err("INVALID_FRAME: incomplete pack manifest".into());
                }
                self.ended = true;
            }
            _ => return Err("INVALID_FRAME: unsupported record".into()),
        }
        Ok(())
    }

    fn identities(&self, value: &Value) -> Result<(), String> {
        // Optional repeated identities must never contradict the frozen input.
        for (field, expected) in [
            ("pack_id", self.manifest.pack_id()),
            ("input_digest", self.manifest.input_digest()),
            ("group_id", self.manifest.group_id()),
        ] {
            if value
                .get(field)
                .is_some_and(|v| v.as_str() != Some(expected))
            {
                return Err("INVALID_FRAME: manifest identity mismatch".into());
            }
        }
        if value
            .get("expected_ids")
            .is_some_and(|v| !exact_ids(v, self.manifest.expected_ids()))
            || value
                .get("source_ids")
                .is_some_and(|v| !exact_ids(v, self.manifest.source_ids()))
            || value.get("publication_groups").is_some_and(|v| {
                v.as_array().is_none_or(|groups| {
                    groups.len() != 1 || groups[0].as_str() != Some(self.manifest.group_id())
                })
            })
        {
            return Err("INVALID_FRAME: manifest members mismatch".into());
        }
        Ok(())
    }

    fn start(&mut self, value: &Value) -> Result<(), String> {
        if self.started
            || value["pack_id"].as_str() != Some(self.manifest.pack_id())
            || value["input_digest"].as_str() != Some(self.manifest.input_digest())
            || value["version"].as_u64() != Some(u64::from(self.manifest.version()))
        {
            return Err("INVALID_FRAME: pack identity mismatch".into());
        }
        self.started = true;
        Ok(())
    }

    fn header(&mut self, value: &Value) -> Result<(), String> {
        let id = value["item_id"]
            .as_str()
            .ok_or("INVALID_FRAME: missing item ID")?;
        if self.current.is_some()
            || self.group_ended
            || !self
                .manifest
                .expected_ids()
                .iter()
                .any(|expected| expected == id)
            || self.completed.contains(id)
            || value["group_id"].as_str() != Some(self.manifest.group_id())
        {
            return Err("INVALID_FRAME: invalid item ownership".into());
        }
        let refs = value["source_refs"]
            .as_array()
            .ok_or("INVALID_FRAME: source_refs must be an explicit list")?;
        let mut unique = HashSet::new();
        if !refs.iter().all(|value| {
            value.as_str().is_some_and(|id| {
                unique.insert(id) && self.manifest.source_ids().iter().any(|source| source == id)
            })
        }) {
            return Err("INVALID_FRAME: source_refs must contain unique known source IDs".into());
        }
        let format = value["format"].as_str().unwrap_or("markdown");
        if format != "markdown" {
            return Err("UNSUPPORTED_OUTPUT: only document candidates are enabled".into());
        }
        self.current = Some(Item {
            id: id.into(),
            name: value["name"]
                .as_str()
                .unwrap_or(id)
                .chars()
                .take(120)
                .collect(),
            format: format.into(),
            next: 0,
            text: String::new(),
        });
        Ok(())
    }

    fn chunk(&mut self, value: &Value) -> Result<(), String> {
        let item = self
            .current
            .as_mut()
            .ok_or("INVALID_FRAME: chunk has no item")?;
        if value["item_id"].as_str() != Some(&item.id) || value["seq"].as_u64() != Some(item.next) {
            return Err("INVALID_FRAME: out-of-order item chunk".into());
        }
        let text = value["text"]
            .as_str()
            .ok_or("INVALID_FRAME: missing chunk text")?;
        if item.text.len() + text.len() > MAX_ITEM {
            return Err("FRAME_LIMIT: item is too large".into());
        }
        item.text.push_str(text);
        item.next += 1;
        Ok(())
    }

    fn item_end(&mut self, value: &Value) -> Result<(), String> {
        let item = self
            .current
            .as_ref()
            .ok_or("INVALID_FRAME: item end has no item")?;
        if value["item_id"].as_str() != Some(&item.id)
            || value["chunk_count"].as_u64() != Some(item.next)
            || value["status"].as_str() != Some("candidate")
            || item.text.is_empty()
        {
            return Err("INVALID_FRAME: item was not complete".into());
        }
        let item = self.current.take().expect("item was checked above");
        self.completed.insert(item.id.clone());
        self.saved.push(AgentArtifact {
            id: uuid::Uuid::new_v4().to_string(),
            item_id: item.id,
            name: item.name,
            format: item.format,
            hash: digest(item.text.as_bytes()),
            content: item.text,
            status: "candidate".into(),
        });
        Ok(())
    }

    fn items_match(&self, value: &Value) -> bool {
        exact_ids(value, self.manifest.expected_ids())
            && self.completed.len() == self.manifest.expected_ids().len()
    }
}
