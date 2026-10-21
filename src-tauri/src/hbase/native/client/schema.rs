use super::connection::NativeClient;
use super::model::ClientError;
use crate::hbase::native::proto::pb;
use crate::hbase::native::rpc::conn::RpcConnection;
use std::time::Duration;

impl NativeClient {
    /// Create a table with the given column families.
    pub async fn create_table(
        &self,
        table: &str,
        families: &[(String, std::collections::BTreeMap<String, String>)],
    ) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let column_families = families
            .iter()
            .map(|(name, attrs)| pb::ColumnFamilySchema {
                name: name.as_bytes().to_vec(),
                attributes: attrs
                    .iter()
                    .map(|(k, v)| pb::BytesBytesPair {
                        first: k.as_bytes().to_vec(),
                        second: v.as_bytes().to_vec(),
                    })
                    .collect(),
                configuration: Vec::new(),
            })
            .collect();
        let req = pb::CreateTableRequest {
            table_schema: pb::TableSchema {
                table_name: Some(Self::table_name_pb(&qualified)),
                attributes: Vec::new(),
                column_families,
                configuration: Vec::new(),
            },
            split_keys: Vec::new(),
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::CreateTableResponse>("CreateTable", &req, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Poll `GetProcedureResult` until the master procedure `proc_id` finishes.
    pub(super) async fn wait_for_procedure(
        &self,
        master: &RpcConnection,
        proc_id: u64,
    ) -> Result<(), ClientError> {
        let deadline = std::time::Instant::now() + self.cfg.timeout.max(Duration::from_secs(30));
        loop {
            let req = pb::GetProcedureResultRequest { proc_id };
            let (resp, _) = master
                .call_pb::<_, pb::GetProcedureResultResponse>("getProcedureResult", &req, None)
                .await?;
            use pb::get_procedure_result_response::State;
            match State::try_from(resp.state).unwrap_or(State::Running) {
                State::Finished => {
                    if let Some(exc) = resp.exception {
                        return Err(ClientError::Rpc(format!(
                            "procedure {proc_id} failed: {}",
                            exc.generic_exception
                                .and_then(|g| g.message)
                                .unwrap_or_else(|| "unknown".into())
                        )));
                    }
                    return Ok(());
                }
                State::NotFound => return Ok(()), // already reaped = done
                State::Running => {
                    if std::time::Instant::now() >= deadline {
                        return Err(ClientError::Rpc(format!(
                            "timed out waiting for procedure {proc_id}"
                        )));
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }
    }

    /// Disable then delete a table.
    pub async fn drop_table(&self, table: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let tn = Self::table_name_pb(&qualified);

        // HBase requires a table to be disabled before deletion. Ignore "not
        // enabled" errors so a second drop / already-disabled table still works.
        let disable = pb::DisableTableRequest {
            table_name: tn.clone(),
            nonce_group: None,
            nonce: None,
        };
        match master
            .call_pb::<_, pb::DisableTableResponse>("DisableTable", &disable, None)
            .await
        {
            Ok((resp, _)) => {
                if let Some(proc_id) = resp.proc_id {
                    self.wait_for_procedure(&master, proc_id).await?;
                }
            }
            Err(e) => {
                // Tolerate "table already disabled" style errors; surface others.
                let msg = e.to_string();
                if !msg.contains("TableNotEnabled") && !msg.contains("not enabled") {
                    return Err(ClientError::Rpc(msg));
                }
            }
        }

        let del = pb::DeleteTableRequest {
            table_name: tn,
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::DeleteTableResponse>("DeleteTable", &del, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Enable a table.
    pub async fn enable_table(&self, table: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let req = pb::EnableTableRequest {
            table_name: Self::table_name_pb(&qualified),
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::EnableTableResponse>("EnableTable", &req, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Disable a table.
    pub async fn disable_table(&self, table: &str) -> Result<(), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let req = pb::DisableTableRequest {
            table_name: Self::table_name_pb(&qualified),
            nonce_group: None,
            nonce: None,
        };
        let (resp, _) = master
            .call_pb::<_, pb::DisableTableResponse>("DisableTable", &req, None)
            .await?;
        if let Some(proc_id) = resp.proc_id {
            self.wait_for_procedure(&master, proc_id).await?;
        }
        Ok(())
    }

    /// Add or modify column families (`alter`). For each spec, an existing
    /// family is modified, a new one is added. Returns the number of families
    /// changed.
    pub async fn alter_table(
        &self,
        table: &str,
        families: &[(String, std::collections::BTreeMap<String, String>)],
    ) -> Result<usize, ClientError> {
        let qualified = self.qualify(table);
        let (_, existing) = self.describe_table(table).await?;
        let existing_names: Vec<String> = existing.into_iter().map(|f| f.name).collect();
        let master = self.master().await?;
        let tn = Self::table_name_pb(&qualified);
        for (name, attrs) in families {
            let cf = pb::ColumnFamilySchema {
                name: name.as_bytes().to_vec(),
                attributes: attrs
                    .iter()
                    .map(|(k, v)| pb::BytesBytesPair {
                        first: k.as_bytes().to_vec(),
                        second: v.as_bytes().to_vec(),
                    })
                    .collect(),
                configuration: Vec::new(),
            };
            let proc_id = if existing_names.iter().any(|n| n == name) {
                let req = pb::ModifyColumnRequest {
                    table_name: tn.clone(),
                    column_families: cf,
                    nonce_group: None,
                    nonce: None,
                };
                master
                    .call_pb::<_, pb::ModifyColumnResponse>("ModifyColumn", &req, None)
                    .await?
                    .0
                    .proc_id
            } else {
                let req = pb::AddColumnRequest {
                    table_name: tn.clone(),
                    column_families: cf,
                    nonce_group: None,
                    nonce: None,
                };
                master
                    .call_pb::<_, pb::AddColumnResponse>("AddColumn", &req, None)
                    .await?
                    .0
                    .proc_id
            };
            if let Some(proc_id) = proc_id {
                self.wait_for_procedure(&master, proc_id).await?;
            }
        }
        Ok(families.len())
    }
}
