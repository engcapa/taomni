pub const SELECTABLE_DB_OBJECT_KINDS: &[&str] = &["table", "view", "materialized_view"];
pub(super) const SUPPORTED_DB_OBJECT_KINDS: &[&str] = &[
    "table",
    "view",
    "materialized_view",
    "procedure",
    "function",
    "trigger",
    "event",
    "sequence",
    "dictionary",
];
pub(super) const MAX_SELECTED_DB_OBJECTS: usize = 128;
pub(super) const MAX_CODE_WORKSPACE_PATHS: usize = 64;
pub(super) const MAX_CODE_WORKSPACE_PATH_LEN: usize = 512;
pub(super) const MAX_CODE_WORKSPACE_ROOTS: usize = 16;
pub(super) const MAX_CODE_WORKSPACE_LOOSE_FILES: usize = 64;
pub(super) const MAX_CODE_WORKSPACE_LSP_DIAGNOSTIC_FILES: usize = 16;
pub(super) const MAX_CODE_WORKSPACE_LSP_MESSAGES: usize = 5;
pub(super) const MAX_CODE_WORKSPACE_LSP_TEXT_LEN: usize = 240;
