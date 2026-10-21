//! Structural Search (ED-PARITY-009): Java AST template matching.
//!
//! A template such as `System.out.println($arg$);` is parsed with the same
//! tree-sitter Java grammar as the searched sources; `$name$` placeholders
//! become variables that match exactly one AST node. Matching compares node
//! kinds and leaf token text, so comments, string contents and similarly named
//! calls (`print`, `System.err`) never match. There is intentionally no
//! regex/text fallback: an unsupported language or pattern returns a typed
//! `unavailable`/`error` response instead of an empty or approximate result.

mod model;

mod lifecycle;

mod pattern;

mod matching;

mod results;

mod files;

mod search;

mod commands;

#[cfg(test)]
mod tests;

pub use model::{
    BACKEND_ID, GRAMMAR_VERSION, PARSER_VERSION, StructuralActiveFile, StructuralBackendInfo,
    StructuralCapture, StructuralContainer, StructuralErrorCode, StructuralMatch,
    StructuralPosition, StructuralQuery, StructuralQueryVariable, StructuralSearchBuffer,
    StructuralSearchCapabilities, StructuralSearchRequest, StructuralSearchResponse,
    StructuralSearchRoot, StructuralSearchStats, StructuralUnavailableReason,
};

pub use lifecycle::StructuralSearchState;

pub use search::run_structural_search;

pub use commands::{
    structural_search_cancel, structural_search_capabilities, structural_search_run,
};

pub(crate) use commands::{
    __cmd__structural_search_cancel, __cmd__structural_search_capabilities,
    __cmd__structural_search_run, __tauri_command_name_structural_search_cancel,
    __tauri_command_name_structural_search_capabilities,
    __tauri_command_name_structural_search_run,
};
