use super::connection::NativeClient;
use crate::hbase::native::proto::pb;

impl NativeClient {
    /// Resolve a table name to its fully-qualified (namespace:qualifier) form.
    pub fn qualify(&self, table: &str) -> String {
        let t = table.trim();
        if t.contains(':') {
            return t.to_string();
        }
        match self.cfg.namespace.as_deref() {
            Some(ns) if !ns.is_empty() => format!("{ns}:{t}"),
            _ => t.to_string(),
        }
    }

    /// Split a qualified table name into (namespace, qualifier) byte vectors.
    pub(super) fn split_table(qualified: &str) -> (Vec<u8>, Vec<u8>) {
        match qualified.split_once(':') {
            Some((ns, q)) => (ns.as_bytes().to_vec(), q.as_bytes().to_vec()),
            None => (b"default".to_vec(), qualified.as_bytes().to_vec()),
        }
    }

    pub(super) fn table_name_pb(qualified: &str) -> pb::TableName {
        let (ns, q) = Self::split_table(qualified);
        pb::TableName {
            namespace: ns,
            qualifier: q,
        }
    }
}

/// Render a `TableName` proto as `namespace:qualifier` (dropping `default:`).
pub(super) fn qualify_table_name(tn: &pb::TableName) -> String {
    let ns = String::from_utf8_lossy(&tn.namespace);
    let q = String::from_utf8_lossy(&tn.qualifier);
    if ns == "default" || ns.is_empty() {
        q.into_owned()
    } else {
        format!("{ns}:{q}")
    }
}
