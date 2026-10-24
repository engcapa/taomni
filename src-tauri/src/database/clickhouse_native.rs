//! Native TCP protocol owner. Each operation owns its pool, so cancellation
//! closes the connection and never returns an incomplete packet stream to reuse.
use super::{
    ColumnInfo, DbConfig, QueryResult, QueryStreamChannel, QueryStreamEvent,
    send_query_stream_event,
};
use clickhouse_rs::types::{Block, ColumnType, FromSql, FromSqlResult, ValueRef};
use clickhouse_rs::{Options, Pool};
use futures::{FutureExt, StreamExt};
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct NativeClient {
    options: Options,
    timeout: Duration,
}

impl NativeClient {
    pub(super) fn new(config: &DbConfig, password: Option<&str>) -> Result<Self, String> {
        let host = if config.host.contains(':') {
            format!("[{}]", config.host)
        } else {
            config.host.clone()
        };
        let address = reqwest::Url::parse(&format!("tcp://{host}:{}", config.port))
            .map_err(|_| "Invalid ClickHouse native endpoint")?;
        let timeout = Duration::from_secs(config.timeout_secs.filter(|n| *n > 0).unwrap_or(15));
        let options = Options::new(address)
            .username(
                config
                    .username
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("default"),
            )
            .password(password.unwrap_or(""))
            .secure(config.ssl)
            .pool_min(0)
            .pool_max(1)
            .send_retries(0)
            .connection_timeout(timeout)
            .query_timeout(timeout)
            .ping_timeout(timeout)
            .execute_timeout(Some(timeout));
        Ok(Self { options, timeout })
    }

    pub(super) async fn execute(
        &self,
        database: &str,
        sql: &str,
        token: &CancellationToken,
    ) -> Result<QueryResult, String> {
        let sql = super::clickhouse_native_sql::native_sql(sql)?;
        let sql = sql.as_ref();
        let start = Instant::now();
        let pool = Pool::new(self.options.clone().database(database));
        let operation = async {
            let mut handle = pool.get_handle().await.map_err(native_error)?;
            let block = handle.query(sql).fetch_all().await.map_err(native_error)?;
            Ok(QueryResult {
                columns: columns(&block),
                rows: rows(&block, block.row_count())?,
                rows_affected: block.row_count() as u64,
                duration_ms: start.elapsed().as_millis() as u64,
                warnings: vec![],
            })
        };
        tokio::select! {
            _ = token.cancelled() => Err("Query cancelled".into()),
            result = guarded_operation(self.timeout, operation) => result,
        }
    }

    pub(super) async fn execute_stream(
        &self,
        database: &str,
        sql: &str,
        max_rows: Option<u64>,
        token: &CancellationToken,
        on_event: &QueryStreamChannel,
    ) -> Result<(), String> {
        let sql = super::clickhouse_native_sql::native_sql(sql)?;
        let sql = sql.as_ref();
        let start = Instant::now();
        let pool = Pool::new(self.options.clone().database(database));
        let operation = async {
            let mut handle = pool.get_handle().await.map_err(native_error)?;
            let mut stream = handle.query(sql).stream_blocks();
            let mut sent_columns = false;
            let mut count = 0;
            let mut limited = false;
            let limit = max_rows.filter(|n| *n > 0);
            while let Some(block) = stream.next().await {
                let block = block.map_err(native_error)?;
                if !sent_columns && block.column_count() > 0 {
                    send_query_stream_event(
                        on_event,
                        QueryStreamEvent::Columns {
                            columns: columns(&block),
                        },
                    )?;
                    sent_columns = true;
                }
                let take = limit
                    .map(|limit| (limit - count).min(block.row_count() as u64) as usize)
                    .unwrap_or(block.row_count());
                let data = rows(&block, take)?;
                for batch in data.chunks(100) {
                    send_query_stream_event(
                        on_event,
                        QueryStreamEvent::Rows {
                            rows: batch.to_vec(),
                        },
                    )?;
                }
                count += take as u64;
                if limit.is_some_and(|n| count >= n) {
                    limited = true;
                    break;
                }
            }
            send_query_stream_event(
                on_event,
                QueryStreamEvent::Done {
                    rows_affected: count,
                    duration_ms: start.elapsed().as_millis() as u64,
                    warnings: if limited {
                        vec![format!("Result limited to {count} rows")]
                    } else {
                        vec![]
                    },
                },
            )
        };
        tokio::select! {
            _ = token.cancelled() => Err("Query cancelled".into()),
            result = guarded_operation(self.timeout, operation) => result,
        }
    }
}

// clickhouse-rs can panic on EOF during its Hello exchange (including a server
// closing after rejecting credentials). Keep that dependency failure inside
// the per-operation connection owner so the IPC always resolves and retries
// use a fresh connection. Never reuse the partially decoded stream.
async fn guarded_operation<T>(
    timeout: Duration,
    operation: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    tokio::time::timeout(timeout, AssertUnwindSafe(operation).catch_unwind())
        .await
        .map_err(|_| "ClickHouse native query timed out")?
        .map_err(|_| "ClickHouse native connection ended unexpectedly; check credentials, server logs and protocol/TLS settings")?
}

fn native_error(error: impl std::fmt::Display) -> String {
    format!("ClickHouse native: {error}")
}

fn columns<K: ColumnType>(block: &Block<K>) -> Vec<ColumnInfo> {
    block
        .columns()
        .iter()
        .map(|column| ColumnInfo {
            name: column.name().into(),
            type_name: column.sql_type().to_string().into_owned(),
        })
        .collect()
}

struct Cell(Option<String>);
impl<'a> FromSql<'a> for Cell {
    fn from_sql(value: ValueRef<'a>) -> FromSqlResult<Self> {
        match value {
            ValueRef::Nullable(value) => match value.right() {
                Some(value) => Self::from_sql(*value),
                None => Ok(Self(None)),
            },
            value => Ok(Self(Some(value.to_string()))),
        }
    }
}

fn rows<K: ColumnType>(block: &Block<K>, count: usize) -> Result<Vec<Vec<Option<String>>>, String> {
    (0..count)
        .map(|row| {
            (0..block.column_count())
                .map(|column| {
                    block
                        .get::<Cell, _>(row, column)
                        .map(|cell| cell.0)
                        .map_err(native_error)
                })
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn early_server_disconnect_returns_an_error_for_each_fresh_attempt() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config: DbConfig = serde_json::from_value(serde_json::json!({
            "engine": "ClickHouse", "host": "127.0.0.1",
            "port": listener.local_addr().unwrap().port(), "timeoutSecs": 2
        }))
        .unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut hello = [0; 512];
                assert!(socket.read(&mut hello).await.unwrap() > 0);
                // A server may close before returning Hello or an Exception.
                drop(socket);
            }
        });
        let client = NativeClient::new(&config, Some("rejected")).unwrap();
        for _ in 0..2 {
            let error = client
                .execute("default", "SELECT 1", &CancellationToken::new())
                .await
                .unwrap_err();
            assert!(error.contains("ClickHouse native"), "{error}");
        }
        server.await.unwrap();
    }

    #[test]
    fn native_values_keep_null_distinct_from_empty_and_preserve_integer_precision() {
        let block = Block::new()
            .column("id", vec![u64::MAX])
            .column("empty", vec![""])
            .column("missing", vec![None::<u8>]);
        assert_eq!(
            rows(&block, 1).unwrap(),
            vec![vec![Some(u64::MAX.to_string()), Some("".into()), None]]
        );
        assert_eq!(columns(&block)[0].type_name, "UInt64");
    }
}
