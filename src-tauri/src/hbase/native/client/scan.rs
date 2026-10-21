use super::cells::cell_to_row;
use super::cells::parse_column;
use super::cells::pb_cell_to_cell;
use super::connection::NativeClient;
use super::model::ClientError;
use super::model::ResultRow;
use super::regions::region_specifier;
use crate::hbase::native::cell::Cell;
use crate::hbase::native::proto::pb;
use crate::hbase::native::region;
use crate::hbase::native::rpc::conn::RpcConnection;
use bytes::Bytes;
use prost::Message;

impl NativeClient {
    /// Scan a table, returning up to `limit` cells, walking across regions.
    pub async fn scan(
        &self,
        table: &str,
        limit: usize,
        start_row: Option<&[u8]>,
        stop_row: Option<&[u8]>,
        columns: &[String],
    ) -> Result<Vec<ResultRow>, ClientError> {
        let qualified = self.qualify(table);
        let mut out: Vec<ResultRow> = Vec::new();
        let mut next_row: Vec<u8> = start_row.map(|r| r.to_vec()).unwrap_or_default();
        let column_specs: Vec<pb::Column> = columns.iter().map(|c| parse_column(c)).collect();

        for _ in 0..10_000 {
            if out.len() >= limit {
                break;
            }
            let loc = self.locate_region(&qualified, &next_row).await?;
            let conn = self.region_connection(&loc.server).await?;

            let scan = pb::Scan {
                column: column_specs.clone(),
                start_row: Some(next_row.clone()),
                stop_row: stop_row.map(|s| s.to_vec()),
                max_versions: Some(1),
                ..Default::default()
            };
            let remaining = limit - out.len();
            let rows = scan_once(
                &conn,
                region_specifier(&loc),
                scan,
                remaining.min(1000) as u32,
            )
            .await?;
            for (row_key, cells) in &rows {
                for c in cells {
                    out.push(cell_to_row(row_key, c));
                    if out.len() >= limit {
                        break;
                    }
                }
            }

            let end = loc.end_key().to_vec();
            if end.is_empty() {
                break;
            }
            if let Some(stop) = stop_row {
                if end.as_slice() >= stop {
                    break;
                }
            }
            next_row = end;
        }
        Ok(out)
    }
}

/// Open a scanner, read one batch of up to `number_of_rows`, then close it.
/// Returns `(row_key, cells)` pairs. Used both for meta lookups and (per
/// region) user scans.
pub(super) async fn scan_once(
    conn: &RpcConnection,
    region: pb::RegionSpecifier,
    scan: pb::Scan,
    number_of_rows: u32,
) -> Result<Vec<(Vec<u8>, Vec<Cell>)>, ClientError> {
    // Open: send the Scan, get a scanner_id + first batch.
    let open = pb::ScanRequest {
        region: Some(region),
        scan: Some(scan),
        number_of_rows: Some(number_of_rows),
        client_handles_partials: Some(true),
        client_handles_heartbeats: Some(true),
        ..Default::default()
    };
    let resp = conn.call("Scan", Some(open.encode_to_vec()), None).await?;
    let scan_resp =
        pb::ScanResponse::decode(resp.param).map_err(|e| ClientError::Decode(e.to_string()))?;
    let scanner_id = scan_resp.scanner_id;

    let mut rows = parse_scan_batch(&scan_resp, &resp.cell_block)?;

    // Pull more batches from the same region while results remain and we are
    // under the requested row count.
    let mut more_in_region = scan_resp.more_results_in_region.unwrap_or(false);
    if let Some(sid) = scanner_id {
        let mut guard = 0;
        while more_in_region && (rows.len() as u32) < number_of_rows && guard < 10_000 {
            guard += 1;
            let next = pb::ScanRequest {
                scanner_id: Some(sid),
                number_of_rows: Some(number_of_rows - rows.len() as u32),
                client_handles_partials: Some(true),
                client_handles_heartbeats: Some(true),
                ..Default::default()
            };
            let resp = conn.call("Scan", Some(next.encode_to_vec()), None).await?;
            let batch = pb::ScanResponse::decode(resp.param)
                .map_err(|e| ClientError::Decode(e.to_string()))?;
            let parsed = parse_scan_batch(&batch, &resp.cell_block)?;
            if parsed.is_empty() && !batch.more_results_in_region.unwrap_or(false) {
                break;
            }
            rows.extend(parsed);
            more_in_region = batch.more_results_in_region.unwrap_or(false);
        }

        // Best-effort close.
        let close = pb::ScanRequest {
            scanner_id: Some(sid),
            close_scanner: Some(true),
            number_of_rows: Some(0),
            ..Default::default()
        };
        let _ = conn.call("Scan", Some(close.encode_to_vec()), None).await;
    }

    Ok(rows)
}

/// Reconstruct `(row_key, cells)` from a ScanResponse + its cell block. Cells
/// arrive either inline (`results`) or in the cell block split by
/// `cells_per_result`.
pub(super) fn parse_scan_batch(
    resp: &pb::ScanResponse,
    cell_block: &Bytes,
) -> Result<Vec<(Vec<u8>, Vec<Cell>)>, ClientError> {
    let mut out = Vec::new();

    if !resp.cells_per_result.is_empty() {
        // Cells are in the cell block; split by the per-result counts.
        let mut buf = cell_block.clone();
        for &count in &resp.cells_per_result {
            let mut cells = Vec::with_capacity(count as usize);
            for _ in 0..count {
                let c = Cell::decode(&mut buf).map_err(|e| ClientError::Decode(e.to_string()))?;
                cells.push(c);
            }
            let row_key = cells.first().map(|c| c.row.to_vec()).unwrap_or_default();
            out.push((row_key, cells));
        }
    } else {
        // Cells are pb'd inline in `results`.
        for result in &resp.results {
            let cells: Vec<Cell> = result.cell.iter().map(pb_cell_to_cell).collect();
            let row_key = cells.first().map(|c| c.row.to_vec()).unwrap_or_default();
            out.push((row_key, cells));
        }
    }
    Ok(out)
}
