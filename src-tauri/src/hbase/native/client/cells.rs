use super::model::ClientError;
use super::model::ResultRow;
use crate::hbase::native::cell::Cell;
use crate::hbase::native::proto::pb;
use bytes::Bytes;

/// Pull cells out of a Get/Mutate Result (inline or via the cell block).
pub(super) fn result_to_cells(
    result: Option<&pb::Result>,
    cell_block: &Bytes,
) -> Result<Vec<Cell>, ClientError> {
    let Some(result) = result else {
        return Ok(Vec::new());
    };
    let assoc = result.associated_cell_count.unwrap_or(0);
    if assoc > 0 {
        let mut buf = cell_block.clone();
        let mut cells = Vec::with_capacity(assoc as usize);
        for _ in 0..assoc {
            cells.push(Cell::decode(&mut buf).map_err(|e| ClientError::Decode(e.to_string()))?);
        }
        Ok(cells)
    } else {
        Ok(result.cell.iter().map(pb_cell_to_cell).collect())
    }
}

pub(super) fn pb_cell_to_cell(c: &pb::Cell) -> Cell {
    Cell {
        row: Bytes::copy_from_slice(c.row.as_deref().unwrap_or(&[])),
        family: Bytes::copy_from_slice(c.family.as_deref().unwrap_or(&[])),
        qualifier: Bytes::copy_from_slice(c.qualifier.as_deref().unwrap_or(&[])),
        timestamp: c.timestamp.unwrap_or(0),
        cell_type: c.cell_type.unwrap_or(0) as u8,
        value: Bytes::copy_from_slice(c.value.as_deref().unwrap_or(&[])),
    }
}

pub(super) fn cells_to_rows(cells: &[Cell]) -> Vec<ResultRow> {
    cells.iter().map(|c| cell_to_row(&c.row, c)).collect()
}

pub(super) fn cell_to_row(row_key: &[u8], c: &Cell) -> ResultRow {
    // Column is "family:qualifier".
    let mut column = Vec::with_capacity(c.family.len() + 1 + c.qualifier.len());
    column.extend_from_slice(&c.family);
    column.push(b':');
    column.extend_from_slice(&c.qualifier);
    ResultRow {
        row: row_key.to_vec(),
        column,
        timestamp: c.timestamp,
        value: c.value.to_vec(),
    }
}

/// Parse a `family:qualifier` (or bare `family`) into a `Column` spec.
pub(super) fn parse_column(spec: &str) -> pb::Column {
    let (family, qualifier) = split_column(spec);
    pb::Column {
        family,
        qualifier: if qualifier.is_empty() {
            Vec::new()
        } else {
            vec![qualifier]
        },
    }
}

/// Split `family:qualifier` into (family, qualifier) byte vectors. A bare
/// `family` yields an empty qualifier.
pub(super) fn split_column(spec: &str) -> (Vec<u8>, Vec<u8>) {
    match spec.split_once(':') {
        Some((f, q)) => (f.as_bytes().to_vec(), q.as_bytes().to_vec()),
        None => (spec.as_bytes().to_vec(), Vec::new()),
    }
}
