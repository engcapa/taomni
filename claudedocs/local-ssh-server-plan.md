# Local SSH/SFTP Server 完善计划

> 范围：`src-tauri/src/servers/ssh.rs` + 前端 `SshSettings` / `serversStore`  
> 定位：开发者工具内嵌的轻量 SSH/SFTP 服务（对标 MobaXterm Local SSH），**不是** OpenSSH 完整替代、**不是** PAM/系统账号网关  
> 制定日期：2026-07-19  
> 基线：russh 0.46 + russh-sftp 2 + portable-pty

---

## 1. 一句话现状

**三端协议层已可用**：密码/公钥认证、交互 Shell（PTY）、SFTP 子系统、路径禁锢、启停/日志均已打通；近期补上了 UI `authorizedKeyPath` 读文件。  
主要缺口在 **host key 持久化、exec/非交互命令、多密钥、SFTP 语义完善、UX 与安全加固**，而非跨平台分叉。

---

## 2. 现状盘点

### 2.1 已完成 ✅

| 能力 | 说明 |
|------|------|
| 进程内监听 / 启停 | `TcpListener` + cancel token；端口占用启动期报错 |
| 密码认证 | 配置 `password` 精确匹配 |
| 公钥认证 | 内联 `authorizedKey` 或文件 `authorizedKeyPath` |
| 用户白名单 | `allowedUsers` 逗号分隔；空=任意用户名 |
| 交互 Shell + PTY | `portable-pty` 默认本地 shell，`rootDir` 作 cwd |
| 终端 resize | `window_change_request` |
| SFTP 子系统 | open/read/write/close、opendir/readdir、mkdir/rmdir/remove/rename、stat/lstat/fstat/realpath |
| 路径禁锢 | `confine_path` 拒绝 `..` 逃逸；单测覆盖 |
| 安全默认 | 无密码且无公钥时拒绝启动 |
| 前端表单 | 认证方式 / 密码 / 密钥文件 / 允许用户 / SFTP 根目录 |
| 管理窗口 | 独立 OS 窗口 + 实时日志 |

### 2.2 明确不做 / 非目标 ⛔

| 项 | 理由 |
|----|------|
| PAM / 系统账号登录 | 与 vault 凭据模型冲突；权限与提权风险高；文档已声明 NOT OS/PAM gateway |
| 完整 OpenSSH 功能面 | 过重；定位是临时共享本机 shell/文件 |
| Agent forwarding | 安全面过大，开发工具场景收益低 |
| 多用户 OS 会话隔离 | 只开当前用户身份下的 shell |

### 2.3 缺口与优先级

| 优先级 | 缺口 | 影响 |
|--------|------|------|
| **P0** | Host key 每次启动随机生成 | 客户端每次都 TOFU 告警，体验差、易被忽略真中间人 |
| **P0** | `exec` 未实现 | `ssh host cmd`、部分自动化/scp 路径失败 |
| **P1** | 多 authorized keys | 只能配一把公钥，团队协作不便 |
| **P1** | SFTP `setstat`/`fsetstat` 空实现 | 时间戳/权限上传后不落盘（目前 accept-and-ignore） |
| **P1** | Shell 环境与登录 shell | 无 `env` 请求、未必走 login shell；PATH/rc 可能与预期不符 |
| **P2** | SCP 兼容 / 子系统边界 | 依赖 exec 或 sftp；需回归 scp/rsync 场景 |
| **P2** | 并发会话限制与审计 | 无 max sessions、无简单连接日志策略 |
| **P2** | UI 文案误导 | 「OS credentials」易误解为系统账号 |
| **P0** | ~~端口转发（local/remote/dynamic）~~ | ✅ 已实现：`direct-tcpip`（`-L`/`-D`）+ `tcpip-forward`（`-R`） |
| **P3** | Host key 算法可选 / 指纹展示 | 运维友好，非阻塞 |
| **P3** | 密钥类型扩展测试 | 当前偏 Ed25519 解析路径；RSA 需回归 |

---

## 3. 分阶段计划

### Phase S0 — 体验止血（约 0.5–1 人日）

**目标**：去掉「每次连都警告」；文案诚实。

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| S0-1 | Host key 持久化到 `<app-data>/ssh-server/host_ed25519`（或 PEM）；首次生成、之后复用 | 重启服务后 `ssh-keyscan` 指纹不变 |
| S0-2 | 前端展示 host key 指纹（SHA256），日志启动时打印一行 | UI 或 Server output 可见 |
| S0-3 | 将「OS credentials」改为「Password」类文案（en + zh-CN）；tooltip 说明非系统账号 | 无「系统登录」误解 |
| S0-4 | 启动失败提示：缺凭据 / 端口占用 / rootDir 无效 分类更清晰 | 错误可操作 |

**依赖**：无  
**风险**：低

---

### Phase S1 — 命令与自动化（约 1–2 人日）

**目标**：支持非交互 `ssh user@host command` 与常见自动化。

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| S1-1 | 实现 `exec_request`：无 PTY 时用 pipe 跑命令；有 PTY 时在 shell 中执行 | `ssh -p N user@127.0.0.1 'echo hi'` 返回 0 与输出 |
| S1-2 | 正确上报 `exit_status` / EOF / close | 客户端 `$?` 与 shell 一致 |
| S1-3 | 可选：`subsystem_request` 已支持 sftp；确认 scp 走 sftp 或 exec 的兼容路径 | OpenSSH `scp`/`sftp` 上传下载成功 |
| S1-4 | 单测或集成测：mock 或本机 loopback | CI 可跑至少 1 条 exec 烟雾 |

**依赖**：S0 非必须  
**风险**：中（portable-pty 无 PTY 的 Command 路径与取消令牌）

---

### Phase S2 — 认证与密钥（约 1–1.5 人日）

**目标**：多密钥、文件格式健壮。

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| S2-1 | `authorizedKeyPath` 支持多行 authorized_keys（全部加载，匹配任一） | 文件内 2 把不同公钥均可登录 |
| S2-2 | 内联多密钥：UI 多行文本或重复字段（二选一，优先文件多行） | 文档与表单一致 |
| S2-3 | 解析失败时指出行号/算法错误 | 日志可定位 |
| S2-4 | 可选：同时启用密码+公钥（已部分支持）；UI 增加「Both」或始终双开 | 两种方式都能进 |

**依赖**：无  
**风险**：低

---

### Phase S3 — SFTP 语义与权限（约 1–2 人日）

**目标**：上传工具不再 silently ignore 元数据。

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| S3-1 | `setstat`/`fsetstat`：在平台允许范围内应用 mtime/atime；mode 尽力（Unix chmod，Windows 跳过或映射） | `sftp` 上传后时间戳合理 |
| S3-2 | 符号链接：`readlink`/`symlink` 若库支持则实现；否则明确 OpUnsupported | 行为可预期 |
| S3-3 | 大文件/稀疏：确认 read/write offset 路径；压测百 MB | 无损坏、无 OOM 尖刺 |
| S3-4 | Windows 路径显示：客户端仍见 `/`，本地正确映射盘符/长路径 | Win 主机 SFTP 浏览正常 |

**依赖**：无  
**风险**：中（Windows 权限模型）

---

### Phase S4 — 会话质量与运维（约 1–2 人日）

**目标**：更像「可长期开着的小服务」。

| 任务 ID | 内容 | 验收 |
|---------|------|------|
| S4-1 | 最大并发连接数配置（默认合理上限，如 8） | 超限拒绝并打日志 |
| S4-2 | `env` 请求白名单（PATH、LANG 等可选）或忽略并文档化 | 不静默丢关键 env 若声明支持 |
| S4-3 | Login shell 选项（`-l` / `bash -l`）可配置 | 用户 rc 生效 |
| S4-4 | 连接审计行：peer、user、auth 方式、session 时长 | 日志可 grep |
| S4-5 |（可选）失败认证简单节流 | 暴力尝试被拖慢 |

**依赖**：S0 建议先做  
**风险**：低–中

---

### Phase S5 — 高级能力

| 任务 ID | 内容 | 状态 |
|---------|------|------|
| S5-1 | direct-tcpip（`-L`/`-D`）+ tcpip-forward / cancel（`-R`）双向桥接 | ✅ 已实现（`ssh.rs`） |
| S5-2 | X11 forwarding | 按需；已有客户端 X11 路径 |
| S5-3 | 多 host key 算法（RSA+Ed25519） | 极老客户端兼容 |
| S5-4 | 只读 SFTP 模式 | 分享目录场景 |
| S5-5 | 端口转发目标白名单 / `PermitOpen` 风格限制 | 安全加固，可选 |

#### S5-1 验收（端口转发）

| 客户端操作 | 服务端行为 |
|------------|------------|
| `ssh -L 18080:127.0.0.1:8080 -p N user@host` | `direct-tcpip` 连到本机 8080 并桥接 |
| `ssh -D 1080 -p N user@host` + SOCKS 客户端 | 一串 `direct-tcpip` 到各目标 |
| `ssh -R 19000:127.0.0.1:3000 -p N user@host` | 服务端监听 19000，入站开 `forwarded-tcpip` |
| `ssh -R 0:127.0.0.1:3000 ...` | 服务端分配端口并在 reply 中返回 |
| 会话断开 / cancel-tcpip-forward | 反向监听停止 |

---

## 4. 跨平台注意点

| 平台 | Shell | 文件系统 | 备注 |
|------|-------|----------|------|
| Windows | PowerShell/cmd via portable-pty | 盘符映射、权限弱 | exec 默认 shell 与本地终端一致 |
| macOS | zsh/bash | 权限正常 | TCC 不影响 SSH 服务本身 |
| Linux | 用户默认 shell | chmod/symlink 完整 | 低端口需 root 或 setcap，文档提示用 >1024 |

**无平台分叉的核心代码路径**应继续保持；平台差异集中在 PTY 启动参数与 setstat。

---

## 5. 测试矩阵（最低要求）

| 场景 | Win | macOS | Linux |
|------|:---:|:-----:|:-----:|
| 密码登录 + shell | 手测 | 手测 | 手测 |
| 公钥文件登录 | 手测 | 手测 | 手测 |
| SFTP 上下传 | 手测 | 手测 | 手测 |
| `ssh host uname`（exec） | S1 后 | S1 后 | S1 后 |
| 重启后 host key 稳定 | S0 后 | S0 后 | S0 后 |
| confine_path 单测 | CI | CI | CI |

自动化：保留 `servers::ssh::tests::*`；S1 增加 loopback 集成测（可 `#[ignore]` 需本机）。

---

## 6. 建议实施顺序

```
S0 (host key + 文案)  →  S1 (exec)  →  S2 (多密钥)  →  S3 (SFTP 元数据)  →  S4 (运维)
                              ↑
                         用户价值最大的第二刀
```

**MVP 完成定义（可对内宣称「较完整」）**：S0 + S1 + S2 完成，三端手测 shell/sftp/exec 通过。

---

## 7. 关键文件

| 路径 | 角色 |
|------|------|
| `src-tauri/src/servers/ssh.rs` | 服务实现 |
| `src/components/servers/settings/SshSettings.tsx` | 表单 |
| `src/lib/servers.ts` / `serversStore.ts` | 配置字段 |
| `src/lib/i18n/locales/{en,zh-CN}.ts` | 文案 |
| `feature-servers-design.md` | 产品设计（需同步字段） |

---

## 8. 与 RDP 计划的边界

- SSH 服务**不负责**桌面共享；远程桌面见 `local-rdp-server-plan.md`。
- 两者共享 Local servers 窗口、配置持久化、`server://` 事件与 autostart 基建。
