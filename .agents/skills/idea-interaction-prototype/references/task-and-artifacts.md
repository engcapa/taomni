# 任务卡与产物合同

## 原型字段

只在独立原型 backlog 中维护以下字段，不回写来源开发任务板。默认原型 backlog 为 `claudedocs/code-workspace-idea-prototype-backlog-2026-09.md`。

在 `<!-- ide-task {...} -->` 的 JSON 对象内增设 `prototype`，保留其余字段。其他格式的任务卡使用语义相同的显式字段，不盲目套用正则。所有存储路径以仓库根为基准，使用 `/`，现有指定路径优先。

```json
{
  "prototype": {
    "status": "pending",
    "path": "claudedocs/idea-prototypes/ED-AUDIT-007/prototype.html"
  }
}
```

| 字段 | 约定 |
|---|---|
| `status` | `pending`、`in_progress`、`blocked`、`done`；缺失视为 pending |
| `path` | 最终单 HTML 路径，领取前必须明确；完成前可尚不存在 |
| `owner`, `started_at` | 领取者唯一会话标识与 ISO 8601 时间 |
| `reason` | blocked 的具体原因；恢复执行后清除过期原因 |
| `idea_version`, `idea_build`, `platform`, `java_sdk` | 真实采样环境，不能以期望值填充 |
| `evidence_path` | 当前 run 原始证据目录 |
| `verified_at`, `html_sha256` | 当前最终 HTML 的真实验证时间与 SHA-256 |
| `previous` | 强制重生成前的旧 path、状态、hash、证据位置及验证时间快照 |

默认输出 `claudedocs/idea-prototypes/<task-id>/prototype.html`。用户或任务卡指定其他位置时沿用；强制重生成默认生成 `<task-id>/<run-id>/prototype.html`，通过后将卡片 `path` 指向该新 HTML。每次写入必须保留卡片不属于本次修改的键；先重读并检测 owner/状态变动，避免覆盖同时发生的开发任务更新。

状态转换：`pending → in_progress → done`；缺必要条件为 `in_progress → blocked`，条件解除且没有活动 owner 冲突时可重新领取。`done` 默认直接返回路径；只有用户明确 force 才重新进入 `in_progress`，先保存 previous。失败写 blocked，保留旧 path 和 previous，不删除旧产物。force 不是抢占授权。

如果声明 done 的版本或文件与现状不符，报告问题，等待明确的重生成请求；不要把 done 偷改为 pending 以绕过筛选。不能只因为有 HTML 文件就自动写 done。

## 取证目录

原始截图、日志与本地记录默认保存在已忽略的 `qa-ui-auto-report/idea-prototypes/<task-id>/<run-id>/`。最终 HTML 内嵌完成交接所需的脱敏截图和说明；不要提交原始日志、机器凭据、临时工程或整个 IDEA 配置。

每个 run 至少保留：

- `environment.json`：目标/实际版本、build、edition、OS、SDK、keymap、设置、插件、窗口/缩放、采样工具、时间及未验证平台。
- `fixture/`：可重建的初始源码与必要配置，附文件 hash、编码/EOL、初始化和重置步骤。
- `steps.json`：场景/验收 ID、步骤 ID、动作、前置状态、输入、实测结果、截图相对路径与 hash；未观测字段和原因明确填写。
- `screenshots/`：按场景与步骤命名的原始 IDEA 图片，例如 `completion-03-accepted.png`。About 与 SDK 配置也保存证据。
- `verification.md`：HTML 实际打开方式、浏览器版本、覆盖场景、结果、HTML 截图位置、视觉/交互差异与限制。

这些是本技能的原型取证材料，不是 Taomni QA runner receipt，也不是已通过的 IDEA/Taomni comparison。若另行交付仓库对比记录，须遵循卡片链接的 comparison 合同；只有 IDEA 一端采样时不得写 `matched`。

## 完成自检

1. 原型路径唯一指向本次验证的单 HTML；离线打开不依赖证据目录。
2. 每条要求的可见交互路径均有 IDEA 观测、截图、HTML 状态/动作和浏览器验证；未覆盖的核心交互阻止 done。
3. 任务包含后台或性能验收时，单独写明原型不能证明的部分，不凭模拟时序宣称达到性能指标。
4. 回填仅影响本卡 prototype；开发 status/owner/acceptance/evidence 不变。
5. 检查 JSON 仍可解析；默认任务板可额外运行现有 `task_board.py --doc <任务板> validate` 验证兼容性。该脚本不负责本技能的原型领取或 done 判定。
