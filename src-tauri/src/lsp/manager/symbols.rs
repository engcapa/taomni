use crate::lsp::LspManager;
use crate::lsp::LspSession;
use crate::lsp::LspSessionEntry;
use crate::lsp::LspWorkspaceSymbol;
use crate::lsp::MAX_WORKSPACE_SYMBOL_PROVIDERS;
use crate::lsp::MAX_WORKSPACE_SYMBOL_RAW_BYTES;
use crate::lsp::MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES;
use crate::lsp::WorkspaceSymbolResolutionBatch;
use crate::lsp::WorkspaceSymbolResolutionEntry;
use crate::lsp::capabilities;
use crate::lsp::navigation::parse_workspace_symbol;
use crate::lsp::session;
use crate::lsp::workspace_symbols;
use crate::lsp::workspace_symbols::WorkspaceSymbolsAggregation;
use crate::lsp::workspace_symbols::aggregate_workspace_symbol_responses;
use crate::lsp::workspace_symbols::begin_workspace_symbol_query;
use crate::lsp::workspace_symbols::merge_workspace_symbol_values;
use crate::lsp::workspace_symbols::parse_workspace_symbol_resolve_token;
use crate::lsp::workspace_symbols::prune_workspace_symbol_resolution_batches;
use crate::lsp::workspace_symbols::push_workspace_symbol_diagnostic;
use serde_json::json;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;
use tokio::io::AsyncReadExt;

impl LspManager {
    /// Query every ready language-server session in a workspace for
    /// `workspace/symbol`. The old command path queried only the session that
    /// owned the active document, which silently dropped symbols from other
    /// roots and languages in a multi-root project.
    pub(in crate::lsp) async fn workspace_symbols(
        &self,
        workspace_id: &str,
        query: &str,
    ) -> Result<WorkspaceSymbolsAggregation, String> {
        let query_id = self
            .next_workspace_symbol_query_id
            .fetch_add(1, Ordering::SeqCst);
        let cancellation = {
            let mut queries = self.workspace_symbol_queries.lock().await;
            begin_workspace_symbol_query(&mut queries, workspace_id, query_id)
        };
        let sessions: Vec<Arc<LspSession>> = {
            let guard = self.sessions.lock().await;
            let mut sessions = guard
                .values()
                .filter_map(|entry| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some(session.clone())
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            sessions.sort_by(|left, right| left.key.map_key().cmp(&right.key.map_key()));
            sessions
        };

        let session_count = sessions.len() as u32;
        let provider_limit_reached = sessions.len() > MAX_WORKSPACE_SYMBOL_PROVIDERS;

        let capability_checks = sessions
            .into_iter()
            .take(MAX_WORKSPACE_SYMBOL_PROVIDERS)
            .map(|session| async move {
                let capabilities = session.capabilities.read().await;
                let capabilities = capabilities.as_ref()?;
                capabilities
                    .workspace_symbol
                    .then_some((session.clone(), capabilities.workspace_symbol_resolve))
            });
        let capable = futures::future::join_all(capability_checks)
            .await
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let provider_count = capable.len() as u32;
        // `capable` is collected only from the bounded session prefix, so all
        // other ready sessions (including sessions without the capability and
        // sessions beyond the fan-out limit) are intentionally skipped.
        let skipped_provider_count = session_count.saturating_sub(provider_count);
        let responses = futures::future::join_all(
            capable
                .into_iter()
                .take(MAX_WORKSPACE_SYMBOL_PROVIDERS)
                .map(|(session, supports_resolve)| {
                    let cancellation = cancellation.clone();
                    async move {
                        let label = session.preset.display_name.clone();
                        let result = session
                            .request_with_cancellation(
                                "workspace/symbol",
                                json!({ "query": query }),
                                &cancellation,
                            )
                            .await;
                        (label, session.key.map_key(), supports_resolve, result)
                    }
                }),
        )
        .await;
        let mut aggregation = aggregate_workspace_symbol_responses(
            responses,
            session_count,
            provider_count,
            skipped_provider_count,
            provider_limit_reached,
        );
        // Serialize the latest-query check with replacement so an old query
        // cannot pass the check and then populate the resolve cache after a
        // newer query starts.
        let mut queries = self.workspace_symbol_queries.lock().await;
        let is_latest = queries
            .get(workspace_id)
            .is_some_and(|(current_id, _)| *current_id == query_id);
        if cancellation.is_cancelled() || !is_latest {
            return Err("Workspace symbol query was superseded by a newer query".into());
        }
        self.cache_workspace_symbol_resolutions(workspace_id, &mut aggregation)
            .await;
        queries.remove(workspace_id);
        Ok(aggregation)
    }

    pub(in crate::lsp) async fn cache_workspace_symbol_resolutions(
        &self,
        workspace_id: &str,
        aggregation: &mut WorkspaceSymbolsAggregation,
    ) {
        if !aggregation
            .symbols
            .iter()
            .any(|symbol| symbol.raw.is_some())
        {
            return;
        }

        let sessions = {
            let sessions = self.sessions.lock().await;
            sessions
                .iter()
                .filter_map(|(key, entry)| match entry {
                    LspSessionEntry::Ready(session) if session.key.workspace_id == workspace_id => {
                        Some((key.clone(), Arc::downgrade(session)))
                    }
                    _ => None,
                })
                .collect::<HashMap<_, _>>()
        };
        let batch_id = uuid::Uuid::new_v4().simple().to_string();
        let mut bytes = 0usize;
        let mut entries = HashMap::new();
        let mut skipped = 0usize;
        for (index, symbol) in aggregation.symbols.iter_mut().enumerate() {
            let Some(raw) = symbol.raw.take() else {
                continue;
            };
            let Some(provider_session_key) = symbol.provider_session_key.take() else {
                skipped += 1;
                continue;
            };
            let raw_bytes = match serde_json::to_vec(&raw) {
                Ok(value) => value.len(),
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let Some(session) = sessions.get(&provider_session_key) else {
                skipped += 1;
                continue;
            };
            if raw_bytes > MAX_WORKSPACE_SYMBOL_RAW_BYTES
                || bytes.saturating_add(raw_bytes) > MAX_WORKSPACE_SYMBOL_RESOLUTION_BATCH_BYTES
            {
                skipped += 1;
                continue;
            }
            let entry_id = index.to_string();
            entries.insert(
                entry_id.clone(),
                WorkspaceSymbolResolutionEntry {
                    session: session.clone(),
                    raw,
                },
            );
            bytes += raw_bytes;
            symbol.resolve_token = Some(format!("{batch_id}:{entry_id}"));
        }
        if entries.is_empty() {
            if skipped > 0 {
                push_workspace_symbol_diagnostic(
                    &mut aggregation.diagnostics,
                    "Workspace symbol resolve payloads exceeded the bounded cache".into(),
                );
                aggregation.complete = false;
                aggregation.truncated = true;
            }
            return;
        }

        let now = Instant::now();
        let mut batches = self.workspace_symbol_resolutions.lock().await;
        prune_workspace_symbol_resolution_batches(&mut batches, now);
        batches.insert(
            batch_id,
            WorkspaceSymbolResolutionBatch {
                workspace_id: workspace_id.to_string(),
                created_at: now,
                bytes,
                entries,
            },
        );
        prune_workspace_symbol_resolution_batches(&mut batches, now);
        if skipped > 0 {
            push_workspace_symbol_diagnostic(
                &mut aggregation.diagnostics,
                format!("{skipped} workspace symbol resolve payloads exceeded the bounded cache"),
            );
            aggregation.complete = false;
            aggregation.truncated = true;
        }
    }

    pub(in crate::lsp) async fn resolve_workspace_symbol(
        &self,
        workspace_id: &str,
        resolve_token: &str,
    ) -> Result<LspWorkspaceSymbol, String> {
        let (batch_id, entry_id) = parse_workspace_symbol_resolve_token(resolve_token)?;
        let entry = {
            let now = Instant::now();
            let mut batches = self.workspace_symbol_resolutions.lock().await;
            prune_workspace_symbol_resolution_batches(&mut batches, now);
            let batch = batches
                .get(batch_id)
                .ok_or_else(|| "Workspace symbol resolve token expired".to_string())?;
            if batch.workspace_id != workspace_id {
                return Err("Workspace symbol resolve token belongs to another workspace".into());
            }
            batch
                .entries
                .get(entry_id)
                .cloned()
                .ok_or_else(|| "Workspace symbol resolve token is invalid".to_string())?
        };
        let session = entry
            .session
            .upgrade()
            .ok_or_else(|| "Workspace symbol provider session is no longer active".to_string())?;
        if session.key.workspace_id != workspace_id {
            return Err("Workspace symbol provider session changed".into());
        }
        let resolved = session
            .request("workspaceSymbol/resolve", entry.raw.clone())
            .await?;
        let merged = merge_workspace_symbol_values(&entry.raw, &resolved);
        let symbol = parse_workspace_symbol(&merged)
            .ok_or_else(|| "workspaceSymbol/resolve returned an invalid symbol".to_string())?;
        if !symbol.resolved {
            return Err("workspaceSymbol/resolve did not return a source range".into());
        }
        Ok(symbol)
    }
}
