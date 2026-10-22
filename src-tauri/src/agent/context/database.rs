use super::limits::MAX_SELECTED_DB_OBJECTS;
use super::limits::SELECTABLE_DB_OBJECT_KINDS;
use super::limits::SUPPORTED_DB_OBJECT_KINDS;
use super::paths::clean_opt;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentDbSelectedObject {
    #[serde(default)]
    pub catalog: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(alias = "table")]
    pub name: String,
    pub kind: String,
}

impl AgentDbSelectedObject {
    pub fn normalized(&self) -> Option<Self> {
        let name = self.name.trim();
        if name.is_empty() {
            return None;
        }
        let kind = self.kind.trim();
        if !SUPPORTED_DB_OBJECT_KINDS.contains(&kind) {
            return None;
        }
        Some(Self {
            catalog: clean_opt(self.catalog.as_deref()),
            schema: clean_opt(self.schema.as_deref()),
            name: name.to_string(),
            kind: kind.to_string(),
        })
    }

    pub fn is_selectable(&self) -> bool {
        SELECTABLE_DB_OBJECT_KINDS.contains(&self.kind.as_str())
    }

    pub fn display_name(&self) -> String {
        let mut parts = Vec::new();
        if let Some(catalog) = self
            .catalog
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(catalog);
        }
        if let Some(schema) = self
            .schema
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            parts.push(schema);
        }
        parts.push(self.name.trim());
        parts.join(".")
    }
}

pub fn normalize_selected_objects(objects: &[AgentDbSelectedObject]) -> Vec<AgentDbSelectedObject> {
    let mut out: Vec<AgentDbSelectedObject> = Vec::new();
    for object in objects {
        let Some(normalized) = object.normalized() else {
            continue;
        };
        if out.iter().any(|existing| existing == &normalized) {
            continue;
        }
        out.push(normalized);
        if out.len() >= MAX_SELECTED_DB_OBJECTS {
            break;
        }
    }
    out
}
