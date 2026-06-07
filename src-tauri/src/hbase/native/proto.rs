//! Generated HBase protobuf types (package `hbase.pb`).
//!
//! The wire definitions are vendored under `src-tauri/proto/` and compiled by
//! `build.rs` via prost-build. prost emits one file per proto package; HBase
//! puts every message in `hbase.pb`, so the whole client surface lands in a
//! single generated module that we re-export here as `pb`.
//!
//! `google.protobuf.Any` (used by Procedure.proto) is mapped by prost-build to
//! `::prost_types::Any`, so there is no separate generated `google` module.
#![allow(clippy::all)]

pub mod pb {
    include!(concat!(env!("OUT_DIR"), "/hbase.pb.rs"));
}
