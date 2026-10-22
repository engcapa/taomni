use super::cells::cells_to_rows;
use super::cells::parse_column;
use super::cells::result_to_cells;
use super::cells::split_column;
use super::connection::NativeClient;
use super::model::ClientError;
use super::model::ResultRow;
use super::regions::region_specifier;
use crate::hbase::native::cell;
use crate::hbase::native::cell::Cell;
use crate::hbase::native::proto::pb;
use bytes::Bytes;
use prost::Message;

impl NativeClient {
    // ---- data plane --------------------------------------------------------

    /// Get a single row, optionally restricted to one `family:qualifier`.
    pub async fn get(
        &self,
        table: &str,
        row: &[u8],
        column: Option<&str>,
    ) -> Result<Vec<ResultRow>, ClientError> {
        let qualified = self.qualify(table);
        let columns = column.map(|c| vec![parse_column(c)]).unwrap_or_default();
        let get = pb::Get {
            row: row.to_vec(),
            column: columns,
            max_versions: Some(1),
            ..Default::default()
        };

        self.with_region_retry(&qualified, row, |loc, conn| {
            let get = get.clone();
            async move {
                let req = pb::GetRequest {
                    region: region_specifier(&loc),
                    get,
                };
                let resp = conn.call("Get", Some(req.encode_to_vec()), None).await?;
                let get_resp = pb::GetResponse::decode(resp.param)
                    .map_err(|e| ClientError::Decode(e.to_string()))?;
                let cells = result_to_cells(get_resp.result.as_ref(), &resp.cell_block)?;
                Ok(cells_to_rows(&cells))
            }
        })
        .await
    }

    /// Put a single cell.
    pub async fn put(
        &self,
        table: &str,
        row: &[u8],
        column: &str,
        value: &[u8],
    ) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let (family, qualifier) = split_column(column);
        let cell = Cell {
            row: Bytes::copy_from_slice(row),
            family: Bytes::copy_from_slice(&family),
            qualifier: Bytes::copy_from_slice(&qualifier),
            timestamp: cell::LATEST_TIMESTAMP,
            cell_type: cell::cell_type::PUT,
            value: Bytes::copy_from_slice(value),
        };
        let mutation = pb::MutationProto {
            row: Some(row.to_vec()),
            mutate_type: Some(pb::mutation_proto::MutationType::Put as i32),
            associated_cell_count: Some(1),
            ..Default::default()
        };
        let cell_block = cell::encode_cell_block(&[cell]).to_vec();

        self.with_region_retry(&qualified, row, |loc, conn| {
            let mutation = mutation.clone();
            let cell_block = cell_block.clone();
            async move {
                let req = pb::MutateRequest {
                    region: region_specifier(&loc),
                    mutation,
                    condition: None,
                    nonce_group: None,
                };
                conn.call("Mutate", Some(req.encode_to_vec()), Some(cell_block))
                    .await?;
                Ok(())
            }
        })
        .await
    }

    /// Delete a single column (all versions) of a row.
    pub async fn delete(&self, table: &str, row: &[u8], column: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let (family, qualifier) = split_column(column);
        let mutation = pb::MutationProto {
            row: Some(row.to_vec()),
            mutate_type: Some(pb::mutation_proto::MutationType::Delete as i32),
            column_value: vec![pb::mutation_proto::ColumnValue {
                family: family.clone(),
                qualifier_value: vec![pb::mutation_proto::column_value::QualifierValue {
                    qualifier: Some(qualifier.clone()),
                    value: None,
                    timestamp: Some(cell::LATEST_TIMESTAMP),
                    delete_type: Some(
                        pb::mutation_proto::DeleteType::DeleteMultipleVersions as i32,
                    ),
                    tags: None,
                }],
            }],
            ..Default::default()
        };

        self.with_region_retry(&qualified, row, |loc, conn| {
            let mutation = mutation.clone();
            async move {
                let req = pb::MutateRequest {
                    region: region_specifier(&loc),
                    mutation,
                    condition: None,
                    nonce_group: None,
                };
                conn.call("Mutate", Some(req.encode_to_vec()), None).await?;
                Ok(())
            }
        })
        .await
    }

    /// Delete an entire row (all families/columns).
    pub async fn delete_all(&self, table: &str, row: &[u8]) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let mutation = pb::MutationProto {
            row: Some(row.to_vec()),
            mutate_type: Some(pb::mutation_proto::MutationType::Delete as i32),
            ..Default::default()
        };
        self.with_region_retry(&qualified, row, |loc, conn| {
            let mutation = mutation.clone();
            async move {
                let req = pb::MutateRequest {
                    region: region_specifier(&loc),
                    mutation,
                    condition: None,
                    nonce_group: None,
                };
                conn.call("Mutate", Some(req.encode_to_vec()), None).await?;
                Ok(())
            }
        })
        .await
    }
}
