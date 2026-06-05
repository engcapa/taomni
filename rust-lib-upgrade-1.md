# Taomni Rust 后端依赖升级计划

## Context

对 `src-tauri/Cargo.toml` 和 `src-tauri/vendor/russh/Cargo.toml` 中所有 Rust 依赖进行全面版本升级。当前许多依赖落后多个大版本，存在安全风险和 API 债务。升级按风险和复杂度分 5 个批次执行。

### 关键前置约束

1. **russh 0.46 已 vendor**：在 `vendor/russh/src/client/encrypted.rs` 的 `write_auth_request_if_needed()` 中有一个 MFA 键盘交互认证修复。该 bug 已在上游通过 commit [`7c1060fe`](https://github.com/Eugeny/russh/commit/7c1060fe)（"fixed client k-i auth not working as second auth method"，2025-01-16，合入 v0.50.0）修复，通过引入 `AuthRequest::new(method)` 构造函数在 KeyboardInteractive 认证时正确设置 `current` 字段。升级到 russh 0.61 时**不再需要**移植此补丁。
2. **rig-core 版本锁定**：`=0.37.0`（精确版本固定），升级需验证 `#[tool_macro]` 向后兼容性。
3. **rust-version = "1.77.2"**：部分新版本 crate 需要更高 MSRV，可能需要提升。
4. **加密栈 RC 风险**：aes 0.9、cbc 0.2、des 0.9、sha1/sha2 0.11、pbkdf2 0.13 目前仅发布候选版本。
5. **未使用依赖**：`x509-cert` 和 `hound` 在源代码中无任何引用，可直接移除。

---

## Phase 1：安全补丁升级（低风险，无需或极少代码变更）

### 目标
纯 `cargo update` 或仅改版本号的升级，API 完全兼容。

### Cargo.toml 变更

```toml
# 版本号直接 bump
portable-pty = "0.9"    # 0.8→0.9
cpal = { version = "0.17", optional = true }  # 0.15→0.17
```

### 其余通过 `cargo update` 自动升级

tauri, tauri-build, tauri-plugin-log, serde, serde_json, tokio, tokio-util, uuid, tracing, tracing-subscriber, log, base64, chrono, futures, async-trait, async-stream, heck, regex, urlencoding, url, shellexpand, libc, font-kit, flate2, bytes, hex, arboard, zeroize, plist, anyhow, tempfile, winapi, winreg, x11rb, llama-cpp-2, ash

### 代码变更
- **cpal 0.15→0.17**：`src-tauri/src/voice/capture.rs`，~5 行签名调整（`StreamConfig` 字段名变化）
- **portable-pty 0.8→0.9**：`src-tauri/src/terminal/pty.rs`，~2 行（`PtySize` 新增字段）

### 验证
```bash
cd src-tauri && cargo check --all-features && cargo test --lib
```

---

## Phase 2：Minor 升级（API 稳定，影响范围有限）

### 2A: ironrdp 全家桶

| Crate | 当前 | 目标 |
|-------|------|------|
| ironrdp | 0.14.0 | 0.15.0 |
| ironrdp-tls | 0.2.0 | 0.2.1 |
| ironrdp-tokio | 0.8.0 | 0.9.0 |

**影响文件**：`src-tauri/src/rdp/session.rs`（核心，~2750行）、`rdpdr.rs`、`ws.rs`、`transport.rs`、`input.rs`、`cliprdr.rs`、`rdpsnd.rs`、`rfx.rs`、`frame.rs`、`gateway/mod.rs`；`src-tauri/src/servers/rdp.rs`、`servers/rdp/*.rs`（auth, clipboard, display, input, session, tls）

**预计工作量**：中等（10-15 文件，导入路径和类型签名调整。ironrdp 团队通常提供迁移指南）

### 2B: sqlx 0.8→0.9

**影响文件**：`src-tauri/src/database/sql.rs`（1110行）、`src-tauri/src/database/mod.rs`（628行）

**使用模式**：仅运行时 `sqlx::query()` API，无编译时宏。使用 `MySqlConnectOptions`、`PgConnectOptions`、`Column`、`Row`、`TypeInfo` 等。

**预计工作量**：低（2 文件，主要是 SslMode 枚举变体名变化）

### 2C: rcgen 0.13→0.14

**影响文件**：`src-tauri/src/servers/rdp/tls.rs`

**关键变化**：`generate_simple_self_signed` 从返回 `Certificate` 变为 `Result<Certificate, _>`，需添加 `?`。

**预计工作量**：极低（1 文件，2 行）

### 2D: rig-core =0.37.0→=0.38.1

**影响文件**：`src-tauri/src/agent/tools/rig_native.rs`

**预计工作量**：低（1 文件，验证 `Tool` trait 和 `#[tool_macro]` 兼容性）

### 2E: 加密栈

| Crate | 当前 | 目标 | 影响文件 |
|-------|------|------|---------|
| aes | 0.8 | 0.9 | `vnc/rfb.rs`, `import_secrets/crypto.rs`, `import_secrets/tabby.rs` |
| cbc | 0.1 | 0.2 | `import_secrets/crypto.rs`, `import_secrets/tabby.rs` |
| des | 0.8 | 0.9 | `vnc/rfb.rs` |
| sha1 | 0.10 | 0.11 | `vnc/rfb.rs` |
| sha2 | 0.10 | 0.11 | `import_secrets/crypto.rs`, `models/downloader.rs` |
| rand | 0.8 | 0.10 | `terminal/x11_forward.rs`, `vault/crypto.rs`, `rdp/gateway/mod.rs`, `agent/mcp_server.rs`, `vnc/rfb.rs` |
| pbkdf2 | 0.12 | 0.13 | `import_secrets/crypto.rs` |
| generic-array | 0.14 | 1 | `vnc/rfb.rs`, `import_secrets/crypto.rs` |

⚠️ 多个 crate 仅有 RC 版本，升级前需确认稳定版已发布。

**预计工作量**：中等（6 文件，cipher/digest trait 导入路径变化，`finalize()` 返回类型变化）

### 验证
```bash
cd src-tauri && cargo check --all-features && cargo test --lib && cargo test --tests
```

---

## Phase 3：低风险 Major 升级（有破坏性变更但改动量小）

### 3A: thiserror 1→2
- **影响**：`src-tauri/src/llm/mod.rs`, `src-tauri/src/asr/mod.rs`
- **变更**：基本兼容，可能需要为 error enum 添加 `'static` 约束
- **工作量**：极低

### 3B: dirs 5→6
- **影响**：16 个文件，所有 `dirs::home_dir()/config_dir()/cache_dir()` 调用
- **变更**：部分平台返回类型从 `Option<PathBuf>` 变为 `Result<Option<PathBuf>>`，需加 `.ok()` 或 `?`
- **工作量**：低

### 3C: which 6→8
- **影响**：6 个文件（`servers/process.rs`, `servers/nfs.rs`, `servers/vnc.rs`, `servers/iperf.rs`, `servers/rdp/session.rs`, `agent/cc_bridge/mod.rs`）
- **变更**：API 签名兼容，仅版本 bump
- **工作量**：极低

### 3D: 移除未使用依赖
- 移除 `x509-cert = "0.2"`（无任何源文件引用）
- 移除 `hound = "3.5"`（无任何源文件引用）
- **工作量**：极低（删除 Cargo.toml 中 2 行）

### 3E: serde_yaml→serde_yml
- **影响**：`src-tauri/src/session/import_secrets/tabby.rs`
- **变更**：替换 `use serde_yaml::Value` → `use serde_yml::Value`；`serde_yaml::from_str` → `serde_yml::from_str`
- `serde_yml` 是 serde_yaml 的维护分支，API 100% 兼容
- **工作量**：极低（1 文件，~2 行）

### 验证
```bash
cd src-tauri && cargo check --all-features && cargo test --lib
```

---

## Phase 4：高投入 Major 升级（大量文件/深度 API 重写）

### 4A: rusqlite 0.31→0.40

**影响文件（13个）**：`state.rs`, `session/db.rs`, `chat/store.rs`, `vault/db.rs`, `vault/mod.rs`, `history.rs`, `servers/db.rs`, `ai/commands.rs`, `agent/tools/history.rs`, `agent/tools/sessions.rs`, `agent/search/commands.rs`, `agent/commands.rs`, `lib.rs`

**关键变化**：
- `OptionalExtension` 合并入核心，无需显式导入
- `Row::get` 类型参数顺序可能变化
- `bundled` feature 行为变更（SQLite 版本升级）

**预计工作量**：中等（10+ 文件，机械性类型调整为主）

### 4B: reqwest 0.12→0.13

**影响文件（15+个）**：`llm/anthropic.rs`, `llm/openai_compat.rs`, `llm/llama_server.rs`, `models/downloader.rs`, `agent/tools/web_fetch.rs`, `database/clickhouse.rs`, `database/presto.rs`, `agent/search/{brave,google_cse,serper,searxng,exa,tavily,instances,commands}.rs`

**好消息**：reqwest 0.13 已是传递依赖（被 rig-core 和 tauri 插件使用），兼容性窗口已验证。

**关键变化**：hyper 1.x 底层，但高级 API（`Client::new()`, `.get()`, `.post()`, `.json()`, `.send()`, `.text()`, `.bytes()`）保持兼容。需关注 `rustls-tls` feature 命名。

**预计工作量**：低到中等（文件多但改动少，主要是 feature 配置）

### 4C: keyring 3→4

**影响文件**：`src-tauri/src/agent/search/key_storage.rs`（88行）, `src-tauri/src/session/import_secrets/keychain.rs`

**关键变化**：
- `Entry::new(service, name)` → 参数顺序可能交换
- `delete_credential()` → 可能改为 `delete_password()`
- `Error::NoEntry` → 可能改为 `Error::NotFound`

**预计工作量**：低（2 文件，~10 行重写）

### 4D: redis 0.27→1.2

**影响文件**：`src-tauri/src/database/redis_ops.rs`（457行）, `src-tauri/src/database/mod.rs`

**关键变化**：
- `redis::Value` 枚举变体重命名（`BulkString`→`Data`, `Int`→`Integer`）
- 连接 API 可能变化
- RESP3 可能成为默认协议

**预计工作量**：中等（1 核心文件 + 1 类型引用，`Value` 枚举匹配重写）

### 验证
```bash
cd src-tauri && cargo check --all-features && cargo test --lib && cargo test --tests
# 手动测试：SSH连接、数据库查询、LLM API调用、Redis操作
```

---

## Phase 5：tungstenite + enigo（独立的 Major 变更）

### 5A: tungstenite 0.24→0.29 + tokio-tungstenite 0.24→0.29

**影响文件**：`src-tauri/src/rdp/ws.rs`, `src-tauri/src/vnc/ws.rs`

**使用模式**：`tokio_tungstenite::accept_async(stream)`, `Message::Binary/Text/Close` 枚举匹配

**预计工作量**：低（2 文件，API 基本稳定）

### 5B: enigo 0.3→0.6

**影响文件**：`src-tauri/src/servers/rdp/input.rs`（419行）

这是本计划中**单文件变更最大**的一项。enigo 0.6 API 完全重写：

- `Enigo::new(&Settings::default())` → 构造方式可能改为 Builder 模式
- `Keyboard`/`Mouse` trait 分离
- `key()`, `raw()`, `move_mouse()`, `scroll()`, `button()` 方法签名全部变化
- 需验证 macOS `!Send` 约束在 0.6 中如何处理

**预计工作量**：高（1 文件，~200 行重写）

### 验证
```bash
cd src-tauri && cargo check --all-features && cargo test --lib
# 手动测试：RDP输入注入、VNC WebSocket中继
```

---

## Phase 6：russh 0.46→0.61（正常升级，无需 vendor patch）

### MFA 修复情况

当前 vendor patch（`vendor/russh/src/client/encrypted.rs:937-941`）修复了键盘交互认证作为第二认证方法（如密码 partial-success 后 MFA/OTP）时 prompt 被静默丢弃的问题。该 bug 已在上游通过 commit [`7c1060fe`](https://github.com/Eugeny/russh/commit/7c1060fe)（v0.50.0, 2025-01-16）修复——上游 `AuthRequest::new(method)` 构造函数在 KeyboardInteractive 方法时已正确初始化 `current` 字段。**升级时无需移植此补丁。**

### 升级步骤

1. 移除 `vendor/russh/` 目录及 `[patch.crates-io]` 中的 russh 覆盖配置
2. 更新 russh 0.46→0.61、russh-sftp 2.0→2.3、russh-keys 0.46→最新版
3. 适配 6 个使用者文件的 API 变化

### 影响文件

| 文件 | 行数 | 使用内容 |
|------|------|---------|
| `terminal/ssh.rs` | 522 | SSH 客户端 handler |
| `terminal/mod.rs` | 702 | SSH 终端状态管理 |
| `terminal/forwards.rs` | 236 | 端口转发 |
| `filebrowser/sftp.rs` | 822 | SFTP 客户端 |
| `servers/ssh.rs` | 921 | SSH 服务器 |
| `tunnel/mod.rs` | 959 | SSH 隧道 |

### 关键 API 变化（0.46→0.61）

- `CryptoVec` 可能被 `Vec<u8>` 替换
- `ChannelId` 可能变更为新类型包装
- `MethodSet` 可能变更为位标志类型
- `client::Handler` / `server::Handler` trait 签名变化
- 认证流程 API 可能重构

**预计工作量**：高（7 文件，~200 行变更，需充分回归测试 SSH/SFTP/tunnel/server 全部场景）

### 验证
```bash
cd src-tauri && cargo check --all-features && cargo test --lib
# 关键手动测试：
# 1. SSH 密码认证连接
# 2. SSH 密钥认证连接
# 3. SSH 密码+OTP 双因素认证（验证上游 MFA 修复正常工作）
# 4. SFTP 文件浏览/上传/下载
# 5. SSH 隧道（本地/远程/动态端口转发）
# 6. SSH 服务器（接受入站连接）
```

---

## 执行顺序

```
Phase 1（补丁升级）
  ↓
Phase 2（minor 升级：ironrdp + sqlx + rcgen + rig-core + 加密栈）
  ↓
Phase 3（低风险 major：thiserror + dirs + which + 移除未使用 + serde_yaml）
  ↓
Phase 4（高投入 major：rusqlite + reqwest + keyring + redis）
  ↓
Phase 5（独立变更：tungstenite + enigo）
  ↓
Phase 6（russh 0.61 — MFA 修复已在上游合入，移除 vendor patch 即可）
```

每阶段完成后执行：
```bash
cd src-tauri
cargo check --all-features
cargo test --lib
cargo test --tests
cargo build --release
```

---

## 汇总

| Phase | 描述 | 涉及文件数 | 预计工作量 | 风险 |
|-------|------|-----------|-----------|------|
| 1 | 补丁/minor 升级 | ~3 | 0.5 天 | 极低 |
| 2 | ironrdp + sqlx + 加密栈 | ~20 | 2-3 天 | 中 |
| 3 | thiserror/dirs/which/yaml | ~25 | 0.5 天 | 低 |
| 4 | rusqlite + reqwest + keyring + redis | ~30 | 3-5 天 | 中高 |
| 5 | tungstenite + enigo | ~3 | 1-2 天 | 中 |
| 6 | russh 0.46→0.61 | ~7 | 2-4 天 | 高 |

**预估总工期**：9-14 天开发 + 2-3 天回归测试
