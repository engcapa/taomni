use super::model::PrestoResults;
use super::protocol::STREAM_BATCH_ROWS;
use super::values::format_presto_error;
use super::values::json_cell_to_string;
use super::values::presto_columns;
use crate::database::QueryStreamChannel;
use crate::database::QueryStreamEvent;
use crate::database::send_query_stream_event;

pub(super) struct StreamState {
    pub(super) columns_sent: bool,
    pub(super) row_count: u64,
    pub(super) rows_affected: u64,
    pub(super) max_rows: Option<u64>,
    pub(super) limit_reached: bool,
    pub(super) batch: Vec<Vec<Option<String>>>,
}

impl StreamState {
    pub(super) fn new(max_rows: Option<u64>) -> Self {
        Self {
            columns_sent: false,
            row_count: 0,
            rows_affected: 0,
            max_rows: max_rows.filter(|value| *value > 0),
            limit_reached: false,
            batch: Vec::with_capacity(STREAM_BATCH_ROWS),
        }
    }

    pub(super) fn consume_results(
        &mut self,
        results: PrestoResults,
        on_event: &QueryStreamChannel,
    ) -> Result<bool, String> {
        if let Some(error) = results.error {
            return Err(format_presto_error(error));
        }
        if let Some(update_count) = results.update_count {
            self.rows_affected = update_count;
        }
        if !self.columns_sent && !results.columns.is_empty() {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Columns {
                    columns: presto_columns(results.columns),
                },
            )?;
            self.columns_sent = true;
        }
        for row in results.data {
            if self.max_rows.is_some_and(|limit| self.row_count >= limit) {
                self.limit_reached = true;
                return Ok(false);
            }
            self.batch
                .push(row.iter().map(json_cell_to_string).collect());
            self.row_count += 1;
            if self.max_rows.is_some_and(|limit| self.row_count >= limit) {
                self.limit_reached = true;
            }
            if self.batch.len() >= STREAM_BATCH_ROWS {
                send_query_stream_event(
                    on_event,
                    QueryStreamEvent::Rows {
                        rows: std::mem::take(&mut self.batch),
                    },
                )?;
            }
        }
        Ok(!self.limit_reached)
    }

    pub(super) fn finish(
        mut self,
        on_event: &QueryStreamChannel,
        duration_ms: u64,
    ) -> Result<(), String> {
        if !self.batch.is_empty() {
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Rows {
                    rows: std::mem::take(&mut self.batch),
                },
            )?;
        }
        send_query_stream_event(
            on_event,
            QueryStreamEvent::Done {
                rows_affected: self.rows_affected,
                duration_ms,
                warnings: match (self.limit_reached, self.max_rows) {
                    (true, Some(limit)) => vec![format!("Result limited to {limit} rows")],
                    _ => Vec::new(),
                },
            },
        )
    }
}
