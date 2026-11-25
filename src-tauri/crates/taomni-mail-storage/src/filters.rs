//! Persisted mail filters and their rule evaluation.

mod cache;
mod matching;
mod model;
mod planning;
pub mod rules;

pub use cache::{
    CandidateSelection, advance_filter_mark, ensure_filter_mark, filter_mark, load_candidates,
    load_filters, migrate_filter_tables, select_filter_candidates, set_filter_mark, store_filters,
};
pub use model::{
    FilterMessage, MailFilter, MailFilterAction, MailFilterActionKind, MailFilterCondition,
    MailFilterField, MailFilterOp, MailFilterRunResult,
};
pub use planning::{MessagePlan, plan_message, prepare_filters};

use model::{FILTER_FILE_FORMAT, FilterFile};

pub fn serialize_filter_file(filters: Vec<MailFilter>) -> Result<String, String> {
    let file = FilterFile {
        format: FILTER_FILE_FORMAT.into(),
        version: 1,
        filters,
    };
    serde_json::to_string_pretty(&file).map_err(|error| error.to_string())
}

/// Parse an exported filter file or a bare JSON array of filters.
pub fn parse_filter_file(text: &str) -> Result<Vec<MailFilter>, String> {
    if let Ok(file) = serde_json::from_str::<FilterFile>(text) {
        if file.format != FILTER_FILE_FORMAT {
            return Err(format!("not a Taomni filter file ({})", file.format));
        }
        return Ok(file.filters);
    }
    serde_json::from_str::<Vec<MailFilter>>(text).map_err(|e| format!("invalid filter file: {e}"))
}

#[cfg(test)]
mod tests;
