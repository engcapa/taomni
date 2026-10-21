use super::connection::NativeClient;
use super::limits::BACKOFF_START_MS;
use super::limits::MAX_RETRIES;
use super::model::ClientError;
use super::scan::scan_once;
use crate::hbase::native::proto::pb;
use crate::hbase::native::region;
use crate::hbase::native::region::RegionLocation;
use crate::hbase::native::rpc::conn::RpcConnection;
use std::time::Duration;

impl NativeClient {
    // ---- region location ---------------------------------------------------

    /// Locate the region serving `(table, row)`, using the cache when possible.
    pub(super) async fn locate_region(
        &self,
        qualified_table: &str,
        row: &[u8],
    ) -> Result<RegionLocation, ClientError> {
        let cache_key = format!("{qualified_table}\x00{}", String::from_utf8_lossy(row));
        if let Some(loc) = self.region_cache.read().await.get(&cache_key).cloned() {
            if loc.contains(row) {
                return Ok(loc);
            }
        }
        let loc = self.meta_lookup(qualified_table, row).await?;
        self.region_cache
            .write()
            .await
            .insert(cache_key, loc.clone());
        Ok(loc)
    }

    /// Invalidate any cached region location for `(table, row)`.
    pub(super) async fn invalidate_region(&self, qualified_table: &str, row: &[u8]) {
        let cache_key = format!("{qualified_table}\x00{}", String::from_utf8_lossy(row));
        self.region_cache.write().await.remove(&cache_key);
    }

    /// Reverse-scan `hbase:meta` for the single region covering `(table, row)`.
    pub(super) async fn meta_lookup(
        &self,
        qualified_table: &str,
        row: &[u8],
    ) -> Result<RegionLocation, ClientError> {
        let meta = self.meta_connection().await?;
        let search_key = region::meta_search_key(qualified_table, row);

        // A reversed scan from `table,row,:` returns the greatest meta row <=
        // the search key — i.e. the region whose range contains `row`. We fetch
        // a single row, so no stop_row is needed; supplying one with reversed
        // semantics risks excluding the very region we are looking for.
        let scan = pb::Scan {
            column: vec![pb::Column {
                family: b"info".to_vec(),
                qualifier: vec![],
            }],
            start_row: Some(search_key),
            reversed: Some(true),
            max_versions: Some(1),
            ..Default::default()
        };

        let region_spec = meta_region_specifier();
        let rows = scan_once(&meta, region_spec, scan, 1).await?;
        let (row_key, cells) = rows
            .into_iter()
            .next()
            .ok_or_else(|| ClientError::Region(format!("no meta entry for {qualified_table}")))?;
        // Guard against landing on a different table's region (e.g. when the
        // target table has no regions yet): verify the row key's table prefix.
        let prefix = region::meta_table_start_key(qualified_table);
        if !row_key.starts_with(&prefix) {
            return Err(ClientError::Region(format!(
                "no meta entry for {qualified_table}"
            )));
        }
        region::region_from_meta_cells(&row_key, &cells)
            .map_err(|e| ClientError::Region(e.to_string()))
    }

    /// Run `op` against the region serving `(table, row)`, invalidating the
    /// cache and retrying on NotServingRegion / connection errors.
    pub(super) async fn with_region_retry<F, Fut, T>(
        &self,
        qualified_table: &str,
        row: &[u8],
        op: F,
    ) -> Result<T, ClientError>
    where
        F: Fn(RegionLocation, RpcConnection) -> Fut,
        Fut: std::future::Future<Output = Result<T, ClientError>>,
    {
        let mut backoff = BACKOFF_START_MS;
        let mut last_err: Option<ClientError> = None;
        for attempt in 0..MAX_RETRIES {
            let loc = match self.locate_region(qualified_table, row).await {
                Ok(l) => l,
                Err(e) => {
                    last_err = Some(e);
                    self.invalidate_region(qualified_table, row).await;
                    tokio::time::sleep(Duration::from_millis(backoff)).await;
                    backoff = (backoff * 2).min(5000);
                    continue;
                }
            };
            let conn = match self.region_connection(&loc.server).await {
                Ok(c) => c,
                Err(e) => {
                    last_err = Some(e);
                    self.drop_region_connection(&loc.server).await;
                    self.invalidate_region(qualified_table, row).await;
                    tokio::time::sleep(Duration::from_millis(backoff)).await;
                    backoff = (backoff * 2).min(5000);
                    continue;
                }
            };
            match op(loc.clone(), conn).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    if is_retryable(&e) && attempt + 1 < MAX_RETRIES {
                        self.invalidate_region(qualified_table, row).await;
                        self.drop_region_connection(&loc.server).await;
                        tokio::time::sleep(Duration::from_millis(backoff)).await;
                        backoff = (backoff * 2).min(5000);
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| ClientError::Region("region retries exhausted".into())))
    }
}

// ---- free helpers ----------------------------------------------------------

/// Build a RegionSpecifier (by region name) for a located region.
pub(super) fn region_specifier(loc: &RegionLocation) -> pb::RegionSpecifier {
    pb::RegionSpecifier {
        r#type: pb::region_specifier::RegionSpecifierType::RegionName as i32,
        value: loc.region_name.clone(),
    }
}

/// RegionSpecifier for the (single, well-known) `hbase:meta,,1` region.
pub(super) fn meta_region_specifier() -> pb::RegionSpecifier {
    pb::RegionSpecifier {
        r#type: pb::region_specifier::RegionSpecifierType::RegionName as i32,
        value: b"hbase:meta,,1".to_vec(),
    }
}

/// Whether a client error warrants a region-relocate + retry.
pub(super) fn is_retryable(e: &ClientError) -> bool {
    let msg = e.to_string();
    msg.contains("NotServingRegion")
        || msg.contains("RegionMoved")
        || msg.contains("RegionOpening")
        || msg.contains("connection closed")
        || msg.contains("transport error")
        || msg.contains("CallQueueTooBig")
        || msg.contains("RegionTooBusy")
}
