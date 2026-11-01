//! Wire fields match larksuite/oapi-sdk-go ws/pbbp2.pb.go. See implementation record.
use prost::Message;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq, Message)]
pub struct Header {
    #[prost(string, required, tag = "1")]
    pub key: String,
    #[prost(string, required, tag = "2")]
    pub value: String,
}
#[derive(Clone, PartialEq, Message)]
pub struct Frame {
    #[prost(uint64, required, tag = "1")]
    pub seq_id: u64,
    #[prost(uint64, required, tag = "2")]
    pub log_id: u64,
    #[prost(int32, required, tag = "3")]
    pub service: i32,
    #[prost(int32, required, tag = "4")]
    pub method: i32,
    #[prost(message, repeated, tag = "5")]
    pub headers: Vec<Header>,
    #[prost(string, optional, tag = "6")]
    pub payload_encoding: Option<String>,
    #[prost(string, optional, tag = "7")]
    pub payload_type: Option<String>,
    #[prost(bytes = "vec", optional, tag = "8")]
    pub payload: Option<Vec<u8>>,
    #[prost(string, optional, tag = "9")]
    pub log_id_new: Option<String>,
}
impl Frame {
    pub fn header(&self, key: &str) -> &str {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
            .unwrap_or("")
    }
    pub fn ping(service: i32) -> Self {
        Self {
            service,
            headers: vec![Header {
                key: "type".into(),
                value: "ping".into(),
            }],
            ..Default::default()
        }
    }
    pub fn response(mut self, accepted: bool, data: Option<serde_json::Value>) -> Self {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let data = data.map(|v| STANDARD.encode(v.to_string()));
        self.payload = Some(
            serde_json::json!({"code":if accepted {200} else {500},"headers":{},"data":data})
                .to_string()
                .into_bytes(),
        );
        self.headers.push(Header {
            key: "biz_rt".into(),
            value: "0".into(),
        });
        self
    }
}
struct Parts {
    created: Instant,
    chunks: Vec<Option<Vec<u8>>>,
    bytes: usize,
}
#[derive(Default)]
pub struct Fragments {
    pending: HashMap<String, Parts>,
}
impl Fragments {
    pub fn accept(&mut self, frame: &Frame) -> Result<Option<Vec<u8>>, String> {
        self.pending
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(5));
        let bytes = frame.payload.as_deref().unwrap_or_default();
        if bytes.len() > 256 * 1024
            || frame
                .payload_encoding
                .as_deref()
                .is_some_and(|s| !s.is_empty())
        {
            return Err("unsupported_feishu_payload".into());
        }
        let sum = match frame.header("sum") {
            "" => 1,
            v => v.parse::<usize>().map_err(|_| "invalid_fragment")?,
        };
        if sum == 1 {
            return Ok(Some(bytes.to_vec()));
        }
        let seq = frame
            .header("seq")
            .parse::<usize>()
            .map_err(|_| "invalid_fragment")?;
        let id = frame.header("message_id");
        if sum == 0 || sum > 64 || seq >= sum || id.is_empty() || id.len() > 256 {
            return Err("invalid_fragment".into());
        }
        if !self.pending.contains_key(id) && self.pending.len() >= 16 {
            return Err("fragment_capacity".into());
        }
        let p = self.pending.entry(id.into()).or_insert_with(|| Parts {
            created: Instant::now(),
            chunks: vec![None; sum],
            bytes: 0,
        });
        if p.chunks.len() != sum {
            return Err("invalid_fragment".into());
        }
        if let Some(old) = &p.chunks[seq] {
            if old != bytes {
                return Err("conflicting_fragment".into());
            }
        } else {
            p.bytes += bytes.len();
            if p.bytes > 256 * 1024 {
                self.pending.remove(id);
                return Err("payload_too_large".into());
            }
            p.chunks[seq] = Some(bytes.to_vec());
        }
        if p.chunks.iter().any(Option::is_none) {
            return Ok(None);
        }
        let p = self.pending.remove(id).unwrap();
        Ok(Some(p.chunks.into_iter().flatten().flatten().collect()))
    }
}
