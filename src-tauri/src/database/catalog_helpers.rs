use super::model::ForeignKeyInfo;

pub(super) const DEFAULT_METADATA_SEARCH_LIMIT: usize = 100;
pub(super) const MAX_METADATA_SEARCH_LIMIT: usize = 500;

pub(super) fn metadata_search_limit(limit: Option<u32>) -> usize {
    usize::try_from(limit.unwrap_or(DEFAULT_METADATA_SEARCH_LIMIT as u32))
        .unwrap_or(MAX_METADATA_SEARCH_LIMIT)
        .clamp(1, MAX_METADATA_SEARCH_LIMIT)
}

pub(crate) fn group_foreign_keys(
    rows: impl Iterator<Item = (String, String, Option<String>, String, String)>,
) -> Vec<ForeignKeyInfo> {
    let mut result: Vec<ForeignKeyInfo> = Vec::new();
    for (name, column, referenced_schema, referenced_table, referenced_column) in rows {
        if let Some(existing) = result.last_mut().filter(|foreign_key| {
            foreign_key.name == name
                && foreign_key.referenced_schema == referenced_schema
                && foreign_key.referenced_table == referenced_table
        }) {
            existing.columns.push(column);
            existing.referenced_columns.push(referenced_column);
        } else {
            result.push(ForeignKeyInfo {
                name,
                columns: vec![column],
                referenced_schema,
                referenced_table,
                referenced_columns: vec![referenced_column],
            });
        }
    }
    result
}
