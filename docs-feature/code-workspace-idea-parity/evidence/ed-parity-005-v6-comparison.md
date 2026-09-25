# ED-PARITY-005 V6 — IDEA 双侧比较记录

Reference ID：`REF-PARITY-005-WIN-20260925`；目标版本 **Ultimate 2026.2.3 / IU-262.10968.63**（用户已定）。
本文件是 V6 的**比较记录**，不是双侧通过声明。**结论：unverified / incomparable，不签 matched。**

## 1. 身份与可得性

| 项 | 值 |
|---|---|
| Taomni 侧 | 本机 Linux/WebKitGTK，分支 `fix/code-workspace-parity005-basic-completion`，HEAD 见提交 |
| Taomni 运行 | QA native `com.taomni.app.qa`（debug），隔离 data/config/cache，fixture 工程副本 |
| IDEA 侧 | **不在本机**。`qa-ui-auto-report/idea-reference/ed-parity-005/` 不存在于本 checkout |
| IDEA 原件 | 按设计仅存于采集机：`run-20260925-024645/`、`run-20260925-031701/`（manifest/原图/文本） |
| 采集环境 | Islands Dark、Source Code Pro 16/1.2、UI Zoom 100%/DPI96、1366×768；普通窗 1346×680、窄窗 950×390 |

**缺侧结论**：比较所需的 IDEA 原图与文本原件不在本机，跨机器必须取得原包，不能用摘要或本文件充当截图。
因此除下文逐项标注为“可比较（依据 P1 已落盘合同）”的行以外，视觉与交互的像素级对齐一律保持未验证。

## 2. 逐状态结论（功能 / 视觉 / 交互）

状态定义沿用设计 `#capture-gaps` 的 R0–R6。Taomni 侧证据为 V5 native 运行
（`TC-IDE-PARITY-005-05-java-completion-native`，48 steps，真实 JDT LS + 真实磁盘）。

| 状态 | 功能 | 视觉 | 交互 |
|---|---|---|---|
| R0 ready | **可比对**：真实 JDK/JDT LS 会话，`data-semantic-ready=true` 后才允许补全；loading 不冒充 ready | 未验证（无 IDEA 原图） | 未验证 |
| R1 list | **可比对**：显式 Basic Completion 得到含 `StringUtils` 的候选列表 | 未验证 | 未验证 |
| R2 selected/doc | 未验证（本轮未采 idæ docs 布局） | 未验证 | 未验证 |
| R3 accepted | **可比对**：Enter→`StringUtilsSuffix;`+单一 lang3 import；Tab→`StringUtils;`+单一 import；落盘字节一致 | 未验证 | 未验证 |
| R4 undo | **可比对**：一次 Undo 回 `StringUtiSuffix;`，再次保存后磁盘同步回退 | 未验证 | 未验证 |
| R5 cancel | **可比对**（Taomni 合同侧）：等待中 Esc 零提交、gate 不复活 | 未验证 | 未验证 |
| R6 edge | 未验证（本机未采窄窗/屏幕边缘） | 未验证 | 未验证 |

“可比对”指：该项的用户结果可由本卡证据独立确认，且 IDEA 侧期望已由 P1 实采落盘
（`references/ed-parity-005-reference.md#observed`/`#followup-observed`）；它**不是**像素或交互节奏的匹配结论。

## 3. 已接受差异（用户已定 / 本卡保留）

| 差异 | 状态 | 依据 |
|---|---|---|
| provider snippet 原始默认值（JDT LS 保留 `append(String str)` 展开），对比 IDEA `append()` | **用户已接受** | DEC-08 |
| 词中 Enter/鼠标保留后缀、Tab 消耗整个 identifier | 与 IDEA 实采一致 | 第二时段 17–21、25–27 |
| IDEA live template 结束时的自动格式化（产生额外 Undo） | **不引入**，Taomni 保留一次原子接受、纯导航不加 history | DEC-08 |
| 候选接受后的鼠标手势：Taomni 单击即接受；IDEA 首击选中、双击接受 | 记录为差异，本卡不对齐点击次数（对齐的是接受**范围**） | V2 说明 |
| IDEA 弹层可越出主窗；Taomni 限于 WebView viewport | 宿主适配 | 设计第 4 节 |
| IDEA `fori` 导航形态 | 仅作参照，不要求 Taomni 新增该模板 | L0/L1 |

## 4. 未验证与阻塞

- IDEA 原图/文本原件不在本机 → 视觉与交互层不可比较。
- 窄窗/屏幕边缘（R6）、候选 docs 布局（R2）本轮未采 Taomni 侧。
- Windows/WebView2、macOS/WKWebView 未运行。

**本卡不声明 IDEA 对齐已完成**；V6 的结论是“Taomni 侧功能合同已由本卡证据确证，双侧视觉/交互比较待原件到位后补采”。
