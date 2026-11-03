use std::collections::HashSet;

use serde::Serialize;

use crate::orchestration::core::model::{AgentSource, digest};

/// Validated frozen input shared by the prompt renderer and frame collector.
/// Fields are private so a caller cannot detach the digest from its identities.
#[derive(Debug, Clone, Serialize)]
pub struct PackManifest {
    version: u32,
    pack_id: String,
    input_digest: String,
    expected_ids: Vec<String>,
    group_id: String,
    source_ids: Vec<String>,
}

#[derive(Serialize)]
struct CanonicalInput<'a> {
    version: u32,
    pack_id: &'a str,
    group_id: &'a str,
    goal: &'a str,
    sources: Vec<CanonicalSource<'a>>,
    expected_ids: &'a [String],
}

#[derive(Serialize)]
struct CanonicalSource<'a> {
    id: &'a str,
    path: &'a str,
    hash: &'a str,
    content: &'a str,
}

impl PackManifest {
    pub fn new(
        pack_id: &str,
        goal: &str,
        sources: &[AgentSource],
        expected_ids: &[String],
    ) -> Result<Self, String> {
        if !valid_id(pack_id) || goal.trim().is_empty() {
            return Err("INVALID_MANIFEST: a pack ID and goal are required".into());
        }
        if expected_ids.is_empty() || expected_ids.len() > 32 || sources.len() > 25 {
            return Err("INVALID_MANIFEST: invalid item or source count".into());
        }
        let mut ids = expected_ids.to_vec();
        ids.sort();
        if ids.iter().any(|id| !valid_id(id)) || ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err("INVALID_MANIFEST: expected item IDs must be unique".into());
        }
        let mut sources: Vec<_> = sources.iter().collect();
        sources.sort_by(|a, b| a.id.cmp(&b.id));
        let mut source_ids = Vec::with_capacity(sources.len());
        for source in &sources {
            if !valid_id(&source.id)
                || source_ids.last() == Some(&source.id)
                || source.hash != digest(source.content.as_bytes())
            {
                return Err("INVALID_MANIFEST: source identity or content hash mismatch".into());
            }
            source_ids.push(source.id.clone());
        }
        // Struct field order and sorted identities are an explicit canonical
        // serialization, independent of HashMap iteration and caller ordering.
        // Both content and its declared hash are bound, not just the goal.
        let input = CanonicalInput {
            version: 1,
            pack_id,
            group_id: "g1",
            goal,
            sources: sources
                .into_iter()
                .map(|source| CanonicalSource {
                    id: &source.id,
                    path: &source.path,
                    hash: &source.hash,
                    content: &source.content,
                })
                .collect(),
            expected_ids: &ids,
        };
        let bytes =
            serde_json::to_vec(&input).map_err(|_| "INVALID_MANIFEST: cannot encode input")?;
        Ok(Self {
            version: 1,
            pack_id: pack_id.to_owned(),
            input_digest: digest(&bytes),
            expected_ids: ids,
            group_id: "g1".into(),
            source_ids,
        })
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn pack_id(&self) -> &str {
        &self.pack_id
    }

    pub fn input_digest(&self) -> &str {
        &self.input_digest
    }

    pub fn expected_ids(&self) -> &[String] {
        &self.expected_ids
    }

    pub fn group_id(&self) -> &str {
        &self.group_id
    }

    pub fn source_ids(&self) -> &[String] {
        &self.source_ids
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

pub(super) fn exact_ids(value: &serde_json::Value, expected: &[String]) -> bool {
    let Some(ids) = value.as_array() else {
        return false;
    };
    let mut unique = HashSet::new();
    ids.len() == expected.len()
        && ids.iter().all(|id| {
            id.as_str().is_some_and(|id| {
                unique.insert(id) && expected.iter().any(|expected| expected == id)
            })
        })
}
