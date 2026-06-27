<p align="center">
  <a href="https://github.com/engcapa/taomni">
    <img src=".github/assets/taomni-primary-logo.png" alt="Taomni" width="720">
  </a>
</p>

# Taomni

Taomni 是一款为开发者打造的 AI 原生远程工作台，基于 Tauri 2 + React 19 + TypeScript 构建，跨 Linux / macOS / Windows 运行。功能齐全却小巧精致：本地终端、SSH、SFTP、RDP/VNC、隧道、数据库客户端一应俱全，并将 AI 能力贯穿日常工作流。

## 功能

- **终端**：本地终端（PTY）、SSH 终端（russh），支持代理与单级 SSH 跳板机
- **会话管理**：会话/分组持久化，支持从 PuTTY / WSL / Tabby / OpenSSH 配置导入
- **文件传输**：SFTP 浏览与上传/下载传输队列
- **远程桌面**：RDP 客户端、VNC（RFB）查看器，并内置可作为服务端的 RDP server
- **隧道**：本地/远程/动态端口转发，支持开机自启
- **数据库客户端**：MySQL / PostgreSQL（sqlx）、ClickHouse、Redis，以及原生 HBase RPC 客户端；连接可经代理 / SSH 跳板机路由
- **AI 能力**：LLM 驱动的 Shell 命令生成（含安全审计）、Agent 工具执行与 Web 搜索、聊天、Tab 智能补全、语音输入（ASR）
- **凭据库**：argon2 + aes-gcm + 系统 keyring 的加密凭据存储

## 技术栈

- 前端：React 19、TypeScript、Vite、Tailwind CSS、xterm.js、CodeMirror 6
- 桌面端：Tauri 2、Rust（tokio 异步）
- 终端与协议：portable-pty、russh、russh-sftp、ironrdp（RDP）、自实现 RFB（VNC）
- 数据库：sqlx（MySQL/PostgreSQL）、redis-rs、原生 HBase（prost + ZooKeeper）
- AI：rig-core、llama.cpp sidecar、可选 sherpa-onnx 语音转写
- 状态与存储：Zustand、SQLite（rusqlite）

## 环境要求

- Node.js 18+
- pnpm
- Rust 1.94+
- protoc（Protocol Buffers 编译器，原生 HBase 客户端构建需要）
- Tauri 所需系统依赖（Windows 上的 WebView2、Linux 上的 webkit2gtk）

安装依赖：

```bash
pnpm install
```

## 开发

启动桌面应用开发模式：

```bash
pnpm tauri dev
```

仅启动前端 Vite 服务：

```bash
pnpm dev
```

Tauri 开发模式下 Vite 使用 `1420` 端口；仅启动前端（`pnpm dev`）时使用 `5000` 端口，并以 `src/stubs/` 中的桩实现替代 Tauri API。

## 构建与打包

构建前端静态资源：

```bash
pnpm build
```

构建产物输出到：

```text
dist/
```

打包 Tauri 桌面应用：

```bash
pnpm tauri build
```

该命令会先执行 `pnpm build`，再按当前平台生成桌面应用安装包/可执行文件。打包产物通常位于：

```text
src-tauri/target/release/bundle/
```

直接运行 release 可执行文件时，可在：

```text
src-tauri/target/release/
```

## 版本与发布

应用版本号统一维护在根目录 `package.json` 的 `version` 字段。`src-tauri/tauri.conf.json` 通过 `../package.json` 读取同一个版本，避免 Tauri bundle 版本与前端包版本分叉。

`src-tauri/Cargo.toml` 中的 `version` 是 Rust crate 元数据；除非需要发布 Rust crate 或在后端代码中使用 `CARGO_PKG_VERSION`，否则应用发布版本以 `package.json` 为准。

发布 tag 使用 `v<version>` 格式，需与 `package.json` 的 `version` 保持一致。例如版本 `0.2.10` 对应：

```bash
git tag v0.2.10
git push origin v0.2.10
```

GitHub Actions 会在推送 `v*` tag、发布 GitHub Release，或手动运行 `Release Bundle` workflow 时构建桌面 bundle。发布触发时 workflow 会校验 tag 是否等于 `v` + `package.json` 版本；手动运行时不填 tag 只生成 workflow artifacts，填写 tag 则会上传到对应 Release。

## 测试

```bash
pnpm test
```

## 目录结构

```text
src/                 React 前端代码
src/components/      UI 组件
src/layouts/         主布局
src/lib/             IPC 与工具函数
src/stores/          前端状态管理
src-tauri/           Tauri/Rust 后端代码
src-tauri/src/       Rust 模块
```
