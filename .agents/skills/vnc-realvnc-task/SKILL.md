---
name: vnc-realvnc-task
description: Taomni VNC 客户端向 RealVNC Viewer 对齐（功能、交互、鼠标键盘、性能）的任务板与单卡交付入口：P0 实测产卡、P1 细化、P2 领取并交付一张 VNC-* 卡、P3 验收；含 RealVNC 参照采集与同方法性能测量工具。只处理 docs-feature/vnc-realvnc-alignment 批次。
---

# VNC RealVNC 对齐任务

任务板固定为 `docs-feature/vnc-realvnc-alignment/backlog.md`（用户另给路径时以用户为准），每条命令显式带 `--doc`。卡片元数据只能由 `scripts/task_board.py` 写入（`<!-- vnc-task {...} -->`），不手工编辑 owner/claim 字段。

```bash
tb="python .agents/skills/vnc-realvnc-task/scripts/task_board.py --doc docs-feature/vnc-realvnc-alignment/backlog.md"
$tb validate
$tb list --claimable
$tb show VNC-PERF-001
$tb claim VNC-PERF-003 --owner <agent>-<UTC>-<短HEAD>
$tb update VNC-PERF-003 --owner <owner> --status in_progress
$tb update VNC-PERF-003 --owner <owner> --status done --evidence-file <evidence.json>
```

脚本强制：ID 形如 `VNC-<域>-NNN`；spec 锚点为小写 ID 且 AC 出现在该锚点小节内；一个 owner 只能有一张活动卡；依赖未 done 不可领取；`done` 需要结构化证据覆盖全部 AC 且每个 required kind 最后一次为 passed。证据种类在 IDEA 板基础上增加 `live-vnc`（真实服务器）与 `realvnc-comparison`。校验通过只说明元数据合法。

## 阶段

| 阶段 | 做什么 | 必读 |
|---|---|---|
| P0 实测产卡 | 同服务器对比 RealVNC 与 Taomni，更新参照与矩阵，新增卡 | `docs-feature/vnc-realvnc-alignment/references/` |
| P1 细化 | 一张 deferred 卡补 DEC/AC/V/测试合同，转 ready | `handoff-p1.md` |
| P2 交付 | claim → 实现 → 验证 → update 到真实终态 | 本文件 “交付一张卡” |
| P3 验收 | 另一会话逐 AC 复核 | `alignment-design.md` 对应小节 |

## 交付一张卡

1. 读 `AGENTS.md`、backlog 第 1–3 节、本卡与依赖卡、`alignment-design.md` 对应小节与 P1 设计、参照中本卡引用的段落。
2. 记录 HEAD 与 `git status --short`，claim 后 `update --status in_progress`。
3. 沿生产链核对：画布/工具栏/菜单入口 → `VncPanel.tsx` / `src/lib/vnc.ts` → WS relay（`ws.rs`）→ `RfbConnection`（`rfb.rs`、`encodings.rs`、`framebuffer.rs`）→ 服务器；覆盖断线、DesktopSize、隐藏标签页、view-only、剪贴板方向。
4. 实现本卡最小完整结果；UI 可以重构，会话数据、vault 引用、代理/SSH 跳板、detach claim 契约必须保留。
5. 验证：定向 `pnpm test src/lib/vnc.test.ts src/components/vnc`、`cargo test --lib vnc::`；稳定后一次 `pnpm exec tsc -b`；性能卡跑回放与实测；需要 native 时用 release 构建（`pnpm tauri build --no-bundle`）连回环代理测量。
6. 写证据 JSON（`verified_at`、`head`、`checks[]`、`unrun[]`、`notes[]`），`update` 到真实终态，`validate`，`git diff --check`。

## 实测与参照工具

- 凭据只经环境变量：`TAOMNI_VNC_LIVE_HOST`、`TAOMNI_VNC_LIVE_PORT`、`TAOMNI_VNC_LIVE_PASSWORD`。地址、口令、桌面名、屏幕像素不进证据、文档或提交；原始产物放 `qa-ui-auto-report/`（已忽略）。
- 解码回放与实测：`src-tauri/src/vnc/live_bench.rs` 文件头有完整命令。实测把首个全屏更新录到 `TAOMNI_VNC_CAPTURE_DIR`，回放用同一批文件做 release 前后对比；机器上有其他编译任务时数字不可比，需空闲时重测。
- 线上字节与节奏：`scripts/vnc_burst_proxy.py --target HOST:PORT --listen 5977 --out bursts.jsonl --up-log up.log`，客户端连 `127.0.0.1:5977`（RealVNC 写作 `127.0.0.1::5977`）。
- 指针延迟：客户端窗口前台且指针在远端画面内时运行 `scripts/vnc_pointer_latency.py --up-log up.log --x <x> --y <y>`（只移动指针，不点击、不按键）。
- RealVNC Viewer：`C:\software\realvnc-viewer\VNC-Viewer-7.15.1-Windows-64bit.exe`（先核对 Authenticode 与 SHA-256）。命令行 `-PasswordFile=<混淆口令文件> -WarnUnencrypted=0 <host>::<port>` 可免交互连接；口令文件放 `qa-ui-auto-report/` 并在采集后删除。RealVNC 会话在独立子进程中，桌面驱动需按进程/窗口标题定位；图像无法直接查看时依赖 OCR 与像素差分。F8 菜单是第三方服务器下最可靠的功能清单来源；全屏工具栏只在全屏模式出现。
- 服务器对正确的 VNCAuth 约 25 s 才返回结果，每次实测连接都要预留该时间，尽量合并批次。
- 系统级输入（`vnc_native.py` / `vnc_realvnc_probe.py` 的 OS 场景）只在借用的交互式 Windows 桌面上跑：扫描码 `SendInput` 带前台守卫，输入只落到被测窗口；测前备份剪贴板与 RealVNC 设置、测后恢复，临时键盘布局测后卸载。
- 三端托管 CI：用例声明 `vnc_required` 即获得同一个 fixture（qa-ui-auto `vnc` 能力，见 qa-ui-auto SKILL “Local VNC fixture”）；TC-151 在 browser 与 native 两种模式覆盖连接、输入到达与 DesktopSize。

## 边界

- 一个 agent 一张卡；发现的新差距写入报告交 P0。
- browser 模式经 dev server VNC bridge（`vite-plugins/vncProxy.ts`：None/VNCAuth、Raw、DesktopSize、剪贴板）连真实 RFB 服务器，只证明面板工作流，不证明原生 relay、编码、系统级输入与系统剪贴板；后者用 jsdom 单测 + native。
- 不把 RealVNC Server 专属能力算入对齐分母（DEC-VNC-05）。
- 仅在用户要求时提交：只 stage 本卡文件，提交信息含卡 ID，如 `perf(vnc): VNC-PERF-003 ...`。

## 汇报

卡 ID、基线与最终 HEAD/工作区、改动文件、生产效果链、命令与结果（含失败后重跑）、与 RealVNC 的数字对照、未运行层及原因、终态与能力上限（平台/服务器/参照版本）。
