# Sockscap Windows + WinDivert 实施状态

日期：2026-07-20  
分支：`feat/sockscap-windows-windivert`（从 `main` 切出）

## 目标（本轮已确认）

- **平台优先**：Windows
- **App/PID 捕获**：使用 **WinDivert**（官方 2.2.2 redistributable，动态 `LoadLibrary`）
- **主进程非 admin**：UAC 仅提升 `sockscap-helper.exe`
- **不 merge** 旧 feature 分支整树；从 design 分支**挑选**已验证的 Windows 捕获与策略核心接入 main

## 已完成

| 区域 | 内容 |
|---|---|
| 捕获 | `windows_capture` + `windivert` NETWORK NAT + PID/exe filter；helper 命名管道协议 v2 |
| 资源 | `src-tauri/resources/windivert/*`（DLL/SYS/LICENSE）+ `tauri.windows.conf.json` externalBin |
| 策略 | AutoProxy/GFWList、matcher、PolicyEngine、app/PID 选择器（含 basename 匹配） |
| 出站 | Direct / SOCKS5 / HTTP CONNECT / SSH Jump（host-key hook） |
| 本地面 | Local SOCKS + transparent accept 与 helper conntrack 联动 |
| UI | 独立 Sockscap 窗口（Dashboard/Profiles/Rules）、Tools 菜单、托盘 |
| 持久化 | `sockscap.db`（user_version、无密钥） |
| 测试 | Rust `sockscap` **114 passed**；前端 sockscap **11 passed** |

## 本机使用

```powershell
# 1) 构建并 stage helper（externalBin 需要）
powershell -ExecutionPolicy Bypass -File scripts/stage-sockscap-helper.ps1

# 2) 可选：把 WinDivert 装到 System32（Start 时 helper 也会装）
powershell -ExecutionPolicy Bypass -File scripts/install-windivert-windows.ps1

# 3) 开发运行
pnpm tauri dev
```

应用内：**Tools → Sockscap** → 配置 Application/PID profile → Start（会 UAC 拉 helper）。

## 架构（Windows）

```text
Taomni (non-admin)
  ├─ Local accept 127.0.0.1:1080 + SOCKS5
  ├─ PolicyEngine / FlowEngine / Egress
  └─ named pipe ──► sockscap-helper (elevated)
                      └─ WinDivert NETWORK NAT
                           filter: global | executables | pids
                           rewrite dst → 127.0.0.1:1080
                           conntrack(sport → original dst, pid, exe)
```

## 仍待（本轮未做完）

- 真机 UAC/helper 端到端手工验证（需管理员）
- WinDivert 驱动签名 `/kp` 与发布 Authenticode
- GFWList 在线刷新与 live mirror
- 托盘退出与 Active 时主窗口关闭三选一 UX 打磨
- Linux/macOS 透明捕获（本分支保留代码但非优先）

## 关键命令

- `sockscap_start` / `stop` / `recover`
- `sockscap_list_processes`（PID 选择）
- `sockscap_upsert_profile`（scope: applications | runtime_processes | global）
- `sockscap_capabilities`（Windows 上 app/pid 报 Supported，依赖 helper+WinDivert 就绪）
