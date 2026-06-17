# HBase Thrift2 IDL (Aliyun Lindorm / HBase 增强版)

`hbase.thrift` is the official ApsaraDB-for-HBase / LindormTable Thrift2 interface
definition, downloaded verbatim from Aliyun:

    https://hbaseuepublic.oss-cn-beijing.aliyuncs.com/hbase.thrift

It is the standard Apache HBase `THBaseService` IDL
(`namespace java com.alibaba.hbase.thrift2.generated`).

## Why it's vendored

The Thrift2-over-HTTP backend (`src/hbase/thrift/`) talks to Lindorm's port
9190 gateway using `TBinaryProtocol` over HTTP with `ACCESSKEYID` /
`ACCESSSIGNATURE` auth headers. The Rust bindings are **pre-generated and
committed** to `src/hbase/thrift/idl.rs` so the build needs no Thrift compiler
(mirrors how the native RPC backend commits its prost output rather than
requiring protoc-at-build).

## Regenerating `idl.rs`

Only needed when the IDL changes. Requires the `thrift` compiler (any 0.1x):

    thrift -out src/hbase/thrift --gen rs src-tauri/thrift/hbase.thrift
    mv src/hbase/thrift/hbase.rs src/hbase/thrift/idl.rs   # if the output name differs

The two `optional keyword is ignored in argument lists` warnings are expected
and harmless. Do not hand-edit `idl.rs`.
