use super::files::collect_buffers;
use super::files::collect_files;
use super::files::file_error;
use super::files::read_search_source;
use super::matching::Matcher;
use super::matching::build_filters;
use super::model::MAX_MATCHES;
use super::model::StructuralErrorCode;
use super::model::StructuralMatch;
use super::model::StructuralSearchRequest;
use super::model::StructuralSearchResponse;
use super::model::StructuralSearchStats;
use super::model::StructuralUnavailableReason;
use super::model::backend_info;
use super::pattern::PatternError;
use super::pattern::compile_pattern;
use super::pattern::java_parser;
use super::results::match_tree;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Instant;

pub(super) fn error_response(request_id: &str, error: PatternError) -> StructuralSearchResponse {
    StructuralSearchResponse::Error {
        request_id: request_id.to_string(),
        code: error.code,
        message: error.message,
    }
}

/// Run one request to completion (or cancellation). Pure with respect to Tauri
/// state so it can be unit-tested against real files.
pub fn run_structural_search(
    request: &StructuralSearchRequest,
    cancelled: &AtomicBool,
) -> StructuralSearchResponse {
    let started = Instant::now();
    let request_id = request.request_id.as_str();
    let query = &request.query;
    if query.schema_version != 1 {
        return error_response(
            request_id,
            PatternError {
                code: StructuralErrorCode::InvalidRequest,
                message: format!(
                    "Unsupported structural query schema version {}",
                    query.schema_version
                ),
            },
        );
    }
    if query.language_id != "java" {
        return StructuralSearchResponse::Unavailable {
            request_id: request_id.to_string(),
            reason: StructuralUnavailableReason::UnsupportedLanguage,
            message: format!(
                "Structural Search has no parser backend for '{}'; only Java is available",
                query.language_id
            ),
        };
    }
    if query.replacement.is_some() {
        return error_response(
            request_id,
            PatternError::unsupported("Structural Replace is not supported by this backend"),
        );
    }
    if request.roots.is_empty() {
        return error_response(
            request_id,
            PatternError {
                code: StructuralErrorCode::InvalidRequest,
                message: "At least one workspace root is required".to_string(),
            },
        );
    }
    let pattern = match compile_pattern(&query.pattern) {
        Ok(pattern) => pattern,
        Err(error) => return error_response(request_id, error),
    };
    let filters = match build_filters(query, &pattern.variables) {
        Ok(filters) => filters,
        Err(error) => return error_response(request_id, error),
    };
    let matcher = Matcher {
        pattern: &pattern,
        filters,
        match_case: query.match_case,
    };
    let buffers = match collect_buffers(request) {
        Ok(buffers) => buffers,
        Err(error) => return error_response(request_id, error),
    };
    let files = match collect_files(
        &request.roots,
        &query.scope,
        request.active_file.as_ref(),
        &buffers,
        cancelled,
    ) {
        Ok(files) => files,
        Err(error) => return error_response(request_id, error),
    };
    let mut parser = match java_parser() {
        Ok(parser) => parser,
        Err(message) => {
            return StructuralSearchResponse::Unavailable {
                request_id: request_id.to_string(),
                reason: StructuralUnavailableReason::BackendMissing,
                message,
            };
        }
    };

    let mut stats = StructuralSearchStats {
        files_scanned: 0,
        files_with_parse_errors: 0,
        elapsed_ms: 0,
    };
    let mut matches = Vec::new();
    let mut truncated = false;
    for file in &files {
        if cancelled.load(Ordering::Relaxed) {
            stats.elapsed_ms = started.elapsed().as_millis() as u64;
            return StructuralSearchResponse::Cancelled {
                request_id: request_id.to_string(),
                stats,
            };
        }
        let bytes = match read_search_source(
            &file.absolute,
            buffers
                .get(&(file.root_index, file.relative.clone()))
                .copied(),
        ) {
            Ok(bytes) => bytes,
            Err(error) => return error_response(request_id, error),
        };
        let Some(tree) = parser.parse(&bytes, None) else {
            return error_response(
                request_id,
                file_error(
                    StructuralErrorCode::FileParse,
                    &file.absolute,
                    "Java parser did not complete",
                ),
            );
        };
        stats.files_scanned += 1;
        if tree.root_node().has_error() {
            stats.files_with_parse_errors += 1;
        }
        let remaining = MAX_MATCHES.saturating_sub(matches.len());
        let root = &request.roots[file.root_index];
        for hit in match_tree(&matcher, &tree, &bytes, remaining + 1) {
            if matches.len() >= MAX_MATCHES {
                truncated = true;
                break;
            }
            matches.push(StructuralMatch {
                root_id: root.id.clone(),
                root_name: root.name.clone(),
                path: file.relative.clone(),
                start: hit.start,
                end: hit.end,
                start_byte: hit.start_byte,
                end_byte: hit.end_byte,
                line_text: hit.line_text,
                matched_text: hit.matched_text,
                captures: hit.captures,
                containers: hit.containers,
            });
        }
        if truncated {
            break;
        }
    }
    if cancelled.load(Ordering::Relaxed) {
        stats.elapsed_ms = started.elapsed().as_millis() as u64;
        return StructuralSearchResponse::Cancelled {
            request_id: request_id.to_string(),
            stats,
        };
    }
    stats.elapsed_ms = started.elapsed().as_millis() as u64;
    StructuralSearchResponse::Ok {
        request_id: request_id.to_string(),
        backend: backend_info(),
        matches,
        truncated,
        stats,
    }
}
