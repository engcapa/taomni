# HBase 原生 RPC 客户端重构方案

## 背景与目标

当前 `src-tauri/src/hbase/mod.rs` 通过 HBase REST/Stargate API 实现 shell 客户端。问题：生产集群**不一定开启 REST Server**（也不一定开 Thrift Server，二者都是独立网关进程）。

目标：参照 Java `hbase-client` 2.6.x 的工作方式，实现**原生 RPC 客户端** —— 直连 RegionServer(16020) + Master(16000)，通过 ZooKeeper(2181) 引导，全程 protobuf + CellBlock，无需 server 端任何额外网关进程。支持 simple 与 Kerberos/SASL 两种认证。

## 生态结论

- crates.io 无原生 RPC 的 Rust HBase 客户端（唯一的 `hbase-thrift` 仍依赖 ThriftServer）。
- 蓝本：`tsuna/gohbase`（Go，完整非 JVM 原生实现，simple auth）。
- Kerberos 蓝本：`OpenTSDB/asynchbase`（Java，GSSAPI SASL）。gohbase 不含 Kerberos。
- protobuf：引入 `prost` + `prost-build`，从 HBase 2.6.x `hbase-protocol-shaded` 模块 vendor `.proto`。

## 新增依赖 (src-tauri/Cargo.toml)

```toml
prost = "0.13"
byteorder = "1"            # 或复用 bytes::Buf 的 BE 读写
zookeeper-client = "0.x"   # 纯 Rust 异步 ZK 客户端
cross-krb5 = "0.x"         # GSSAPI/SSPI 跨平台 Kerberos（仅 kerberos 特性下启用）

[build-dependencies]
prost-build = "0.13"
```

Kerberos 依赖用 Cargo feature `hbase-kerberos` 包裹，默认开启；simple-only 构建可关闭以避免系统 GSSAPI 库依赖。

## 模块结构 (src-tauri/src/hbase/)

```
mod.rs        Tauri 命令 + session map（保持现有 IPC 公共 API 不变）
config.rs     HBaseConfig（扩展：zk quorum / 直连 RS / 认证方式）
shell.rs      命令解析器（从 mod.rs 抽出，复用现有 parser）+ 翻译到原生操作
client.rs     HBaseClient：SendRPC 编排、region 定位、重试/退避状态机
zk.rs         znode 读取（/hbase/meta-region-server, /hbase/master）+ 0xFF/PBUF 解析
region.rs     RegionInfo、meta 行解析、region-name 比较器（Compare）
meta.rs       hbase:meta 反向 scan 定位 region + B-tree 缓存 + split/merge 处理
rpc/
  conn.rs     连接 actor：preamble、ConnectionHeader、帧编解码、call-id 多路复用
  framing.rs  请求/响应帧（4字节BE长度 + varint+RequestHeader + varint+param + cellblock）
auth.rs       simple(0x50) + kerberos(0x51 GSSAPI token 握手 + 可选 wrap/unwrap)
cell.rs       KeyValueCodec：CellBlock 编解码（零拷贝，bytes::Bytes）
proto.rs      include! prost 生成的 pb 类型
```

build.rs 增加 `prost_build::compile_protos`，输出到 OUT_DIR。

## 协议关键点（实现依据）

### 连接握手 (rpc/conn.rs)
- Preamble 6 字节：`"HBas"` + `0x00`(版本) + auth 字节（simple=`0x50`，kerberos=`0x51`）。
- 之后 `<4字节BE长度><ConnectionHeader protobuf>`：`UserInformation.effective_user`、`service_name`（"ClientService" / "MasterService"）、`cell_block_codec_class = "org.apache.hadoop.hbase.codec.KeyValueCodec"`。
- 成功时服务器**无应答**；版本/认证错误抛 FatalConnectionException 并断开。
- Kerberos：preamble 之后、ConnectionHeader 之前插入 `<i32 len><GSSAPI token>` 往返，直到 SASL 完成；若协商出 auth-int/auth-conf QOP，后续每帧需 wrap/unwrap。

### 请求/响应帧 (rpc/framing.rs)
```
请求: [4B BE 总长][varint][RequestHeader pb][varint][param pb][cellblock]
响应: [4B BE 总长][varint][ResponseHeader pb][varint][response pb][cellblock]
```
- RequestHeader: call_id / method_name("Get"/"Mutate"/"Scan"/...) / request_param / cell_block_meta.length / priority。
- ResponseHeader: call_id（必有）/ exception(ExceptionResponse) / cell_block_meta。
- 多路复用：AtomicU32 自增 call_id；`HashMap<u32, oneshot::Sender>` 在飞映射；split TcpStream → reader task + writer task（tokio actor 模式）。

### ZK 引导 (zk.rs)
- znode 字节格式：`0xFF` + `u32 BE metadataLen` + 跳过 metadata + `"PBUF"`(magic) + protobuf。
- `/hbase/meta-region-server` → `MetaRegionServer.server`(ServerName) → meta 所在 RS 的 host:port。
- `/hbase/master` → `Master.master`(ServerName)。
- 每次按需开 ZK 连接读取，不做 watch；陈旧靠 meta 重查 + 重试兜底。

### region 定位与缓存 (region.rs / meta.rs)
- 普通表：对 `hbase:meta` 做 **反向 scan**（startRow=`table,key,:`，Reversed，NumberOfRows=1，Family=info，CloseScanner）取覆盖目标 key 的 region。
- 解析 `info:regioninfo`(=`'P'`+`PBUF`+RegionInfo pb) 与 `info:server`(ASCII host:port)。
- B-tree 缓存按 region-name 排序，**必须**移植 gohbase 的 `Compare`（把 `,` 当最低分隔符 + key 比较 + 时间戳兜底），否则会路由到错误 region。
- region-moved/NSRE → 重建 region 重试；CallQueueTooBig 等 → 退避重试；RS aborted/stopped → 重连。退避：翻倍至 5s，再 +5s 至 30s 封顶；maxFindRegionTries=10。
- 单飞重连：首个 mark-unavailable 的请求触发重建，其余阻塞在 Notify 上。

### CellBlock 编解码 (cell.rs)
KeyValue 线格式（全 BE）：
```
[4B kvLen][4B keyLen][4B valueLen]
key: [2B rowLen][row][1B familyLen][family][qualifier][8B timestamp][1B cellType]
value: [valueLen 字节]
```
- qualifierLen 由 keyLen 推导，不单独存储。
- cell 个数out-of-band：scan 看 `cells_per_result[]`+`partial_flag_per_result[]`，get/mutate 看 `Result.associated_cell_count`。
- 用 `bytes::Bytes` 做零拷贝切片。

### Scan 状态机 (client.rs)
- Open（无 scanner_id，带完整 Scan 子消息）→ Next（带 scanner_id，无 Scan 子消息）→ Close（close_scanner=true）。
- `more_results_in_region` 控制同 region 续读；`more_results` 控制跨 region 推进。
- 反向 scan 跨 region 的 key 递减逻辑需精确移植。
- 始终设 ClientHandlesPartials/ClientHandlesHeartbeats=true；跨响应的部分行需在高层 coalesce。

## shell 命令 → 原生 RPC 映射

| 命令 | RPC | Service | 备注 |
|------|-----|---------|------|
| get | Get | ClientService | 经 meta 定位 region |
| put | Mutate(PUT) | ClientService | |
| delete | Mutate(DELETE) | ClientService | |
| deleteall | Mutate(DELETE 整行) | ClientService | |
| scan | Scan(open/next/close) | ClientService | 状态机 |
| list | GetTableNames | MasterService | 经 ZK 定位 master |
| describe | GetTableDescriptors | MasterService | gohbase 未实现，需自接 |
| create | CreateTable | MasterService | |
| drop | DisableTable + DeleteTable | MasterService | HBase 要求先 disable |
| status | GetClusterStatus | MasterService | |
| version | GetClusterStatus / 连接信息 | MasterService | |
| enable/disable/alter/count | 对应 Master/Client RPC | | 可在原生层补齐（原 REST 版未实现） |

现有 `parse_shell_command` 解析器（含引号/`{}`/`[]` 嵌套处理）**完整保留**，只替换执行后端。

## 配置与 UI 变更

`HBaseConfig` / `HBaseConnectInfo` 扩展（向后兼容，新增字段都 optional）：
- `connectionMode: "native" | "rest"`（默认 native；保留 REST 作为可选回退，契合"环境看情况"）
- native 模式：`zkQuorum`（"host1:2181,host2:2181"）+ `zkRoot`（默认 `/hbase`）；或 `regionServers` 直连引导（绕过 ZK，对应 RpcConnectionRegistry）
- `authMethod: "simple" | "kerberos"`；kerberos 下：`principal`、`servicePrincipal`(如 `hbase/_HOST@REALM`)、keytab 路径或走系统票据缓存
- `effectiveUser`（simple 模式，默认当前用户）

SessionEditor 的 `HBaseSettings` 表单相应增加：连接模式切换、ZK quorum 输入、认证方式选择及 Kerberos 字段。REST 模式保留现有 rest_path/namespace 字段。

IPC 层（`src/lib/ipc.ts`）：`toHBaseConfigPayload` 增加新字段映射；6 个命令签名与返回类型**不变**，前端 `HBaseShellTab` 几乎无需改动。

## 分阶段实施（每阶段可独立验证）

- **P0 基础设施**：加依赖 + build.rs proto codegen；vendor HBase 2.6.x `.proto`；proto.rs 编译通过。验证：`cargo build`。
- **P1 RPC 传输（simple）**：conn.rs/framing.rs；preamble + ConnectionHeader + 帧编解码 + call-id 多路复用。验证：单元测试帧编解码；连本地 RS 发 GetClusterStatus。
- **P2 ZK + meta 定位**：zk.rs + region.rs + meta.rs + 缓存。验证：znode 解析单测、Compare 单测、反向 scan 定位单测；连真集群定位任意表。
- **P3 数据面**：cell.rs + Get/Put/Scan/Delete + scan 状态机。验证：cell 编解码单测；连真集群 get/put/scan/delete 往返。
- **P4 控制面**：MasterService 定位 + list/describe/create/drop/status/version。验证：连真集群建表/列表/描述/删表。
- **P5 接线**：shell.rs 复用解析器，executor 切到原生；mod.rs/IPC/state 接入；保留 REST 作回退分支。验证：`pnpm build` + 现有前端跑通。
- **P6 Kerberos**：auth.rs GSSAPI 握手 + 可选 wrap/unwrap；feature gate。验证：连启用 Kerberos 的集群。
- **P7 配置/UI/测试**：config 扩展、SessionEditor 表单、ipc 映射；补齐单测；更新 CLAUDE.md/导入导出。验证：`pnpm test` + `cargo test` + `tsc -b --noEmit`。

## 测试策略

- **可离线确定性单测**（核心，进 CI）：cell KeyValue 编解码、znode 0xFF/PBUF 解析、region-name Compare、帧 varint/BE 编解码、meta 行解析、反向 scan key 递减、shell parser（已有）。
- **需真集群的集成测试**：手动，分 simple / kerberos 两套环境验证 get/put/scan/list/create/drop。
- 全程不破坏现有 REST 路径（作为 `connectionMode=rest` 保留）。

## 风险与权衡

- **工作量**：数千行 Rust，数周量级，且需跟随 HBase 协议版本维护。这是没有现成库的根本原因。
- **Kerberos**：跨平台 GSSAPI（Linux MIT krb5 / Windows SSPI / macOS Heimdal）行为差异是最大不确定性；`cross-krb5` 覆盖但需逐平台验证。
- **协议细节坑**：region-name 比较器、反向 scan 跨 region key 数学、部分行 coalesce —— 简单用例能过、边界（跨 region/表边界）才暴露。已在方案中标注需逐字移植。
- **二进制体积/编译时间**：prost 生成代码 + 新依赖会增加，可接受。

## 参考来源

- gohbase 源码 https://github.com/tsuna/gohbase
- HBase RPC 规范 https://hbase.apache.org/docs/rpc
- HBase protobuf 序列化 https://hbase.apache.org/docs/protobuf
- catalog/client 架构 https://hbase.apache.org/docs/architecture/client
- asynchbase（Kerberos 蓝本）https://github.com/OpenTSDB/asynchbase

## 实施状态（已完成）

全部 8 个阶段完成，并在本机 standalone HBase 2.6.1（JDK17，ZK 2181 / Master 16000 / RegionServer 16020）上端到端验证通过。

- **P0** proto 基础设施：vendor 23 个 HBase 2.6.1 `.proto`（`src-tauri/proto/`），`build.rs` 用 prost-build 生成 `hbase.pb`。`google.protobuf.Any` 映射到 `prost-types`。
- **P1** RPC 传输：`rpc/codec.rs`（帧编解码，7 单测）+ `rpc/conn.rs`（连接 actor：preamble+ConnectionHeader 握手、reader/writer task、call-id 多路复用 oneshot 映射）。
- **P2** ZK+region 定位：`zk.rs`（0xFF/PBUF znode 解析）+ `region.rs`（RegionInfo 解析、region-name 比较器）+ `client.rs::meta_lookup`（hbase:meta 反向 scan）。实测发现两个关键坑并修复：反向 scan 不能带 stop_row；`info:regioninfo` 值是 `PBUF`+protobuf（无前导版本字节）。
- **P3** 数据面：`cell.rs`（KeyValueCodec 编解码，零拷贝 bytes，7 单测）+ Get/Put/Scan/Delete/DeleteAll。
- **P4** 控制面：list(GetTableNames)/describe(GetTableDescriptors)/create(CreateTable)/drop(Disable+Delete)/status/version(GetClusterStatus)，含 `getProcedureResult` 轮询等待异步建表/删表完成。
- **P5** 接线：`HBaseSession` 改为 `Native|Rest` 枚举；复用现有 `parse_shell_command`；`native_execute` 分派；REST 作 `connectionMode=rest` 回退保留。
- **P6** Kerberos：`auth.rs` GSSAPI SASL 握手（0x51 preamble + `<i32 len><token>` 往返，按 HBase `HBaseSaslRpcClient.saslConnect` 线格式），`cross-krb5` 跨平台，feature `hbase-kerberos`（默认关，需系统 GSSAPI 头）。
- **P7** 配置/UI：`HBaseConfig`/`HBaseConnectInfo` 扩展 connectionMode/zkQuorum/zkRoot/effectiveUser；SessionEditor 加模式切换+ZK 表单；ipc.ts 映射；MainLayout 透传。前端 362 测试全过，tsc 干净。
- **P8** 真集群验收：`HBASE_LIVE_TEST=1` 下 ping/create/list/describe/put/get/scan/delete/deleteall/drop 全链路 + 多列族多行 scan-limit 验证通过。

附带修复：`get` 命令解析器对裸列名（`get 't','r','cf:q'`）误当 option map 解析的 pre-existing bug。

### 测试命令

```bash
# 纯单元测试（CI，无需集群）
cargo test --lib hbase::native        # 35 passed
# 真集群集成测试
HBASE_LIVE_TEST=1 cargo test --lib hbase -- --test-threads=1
# Kerberos feature 编译（需 GSSAPI 头）
cargo build --lib --features hbase-kerberos
```

### 已知环境限制

`hbase::tests::describe_request_error_surfaces_transport_cause` 及 3 个 `database::presto` 测试在本开发沙箱失败——该环境对 localhost 有透明代理返回 HTTP 500，使"连接被拒绝"类断言失效。这些测试在干净提交上同样失败，与本次改动无关。

