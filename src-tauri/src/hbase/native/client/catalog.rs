use super::connection::NativeClient;
use super::model::ClientError;
use super::model::FamilyDesc;
use super::names::qualify_table_name;
use crate::hbase::native::proto::pb;

impl NativeClient {
    /// List user table names.
    pub async fn list_tables(&self) -> Result<Vec<String>, ClientError> {
        let master = self.master().await?;
        let req = pb::GetTableNamesRequest::default();
        let (resp, _) = master
            .call_pb::<_, pb::GetTableNamesResponse>("GetTableNames", &req, None)
            .await?;
        Ok(resp
            .table_names
            .into_iter()
            .map(|tn| qualify_table_name(&tn))
            .collect())
    }

    /// Describe a table's column families.
    pub async fn describe_table(
        &self,
        table: &str,
    ) -> Result<(String, Vec<FamilyDesc>), ClientError> {
        let qualified = self.qualify(table);
        let master = self.master().await?;
        let req = pb::GetTableDescriptorsRequest {
            table_names: vec![Self::table_name_pb(&qualified)],
            ..Default::default()
        };
        let (resp, _) = master
            .call_pb::<_, pb::GetTableDescriptorsResponse>("GetTableDescriptors", &req, None)
            .await?;
        let schema = resp
            .table_schema
            .into_iter()
            .next()
            .ok_or_else(|| ClientError::Region(format!("table not found: {qualified}")))?;
        let name = schema
            .table_name
            .as_ref()
            .map(qualify_table_name)
            .unwrap_or_else(|| qualified.clone());
        let families = schema
            .column_families
            .into_iter()
            .map(|cf| {
                let mut attributes = std::collections::BTreeMap::new();
                for attr in &cf.attributes {
                    attributes.insert(
                        String::from_utf8_lossy(&attr.first).into_owned(),
                        String::from_utf8_lossy(&attr.second).into_owned(),
                    );
                }
                for conf in &cf.configuration {
                    attributes.insert(conf.name.clone(), conf.value.clone());
                }
                FamilyDesc {
                    name: String::from_utf8_lossy(&cf.name).into_owned(),
                    attributes,
                }
            })
            .collect();
        Ok((name, families))
    }

    /// Cluster status as key/value pairs.
    pub async fn cluster_status(&self) -> Result<Vec<(String, String)>, ClientError> {
        let master = self.master().await?;
        let req = pb::GetClusterStatusRequest::default();
        let (resp, _) = master
            .call_pb::<_, pb::GetClusterStatusResponse>("GetClusterStatus", &req, None)
            .await?;
        let s = resp.cluster_status;
        let mut out = Vec::new();
        if let Some(v) = s.hbase_version {
            out.push(("hbaseVersion".into(), v.version));
        }
        out.push(("liveServers".into(), s.live_servers.len().to_string()));
        out.push(("deadServers".into(), s.dead_servers.len().to_string()));
        out.push((
            "regionsInTransition".into(),
            s.regions_in_transition.len().to_string(),
        ));
        if let Some(b) = s.balancer_on {
            out.push(("balancerOn".into(), b.to_string()));
        }
        if let Some(cid) = s.cluster_id {
            out.push(("clusterId".into(), cid.cluster_id));
        }
        Ok(out)
    }
}
