# ED-PARITY-005 V6 双侧比较记录（自检）

- 任务板：`docs-feature/code-workspace-idea-parity/backlog.md` / `ED-PARITY-005`
- 参照：`REF-PARITY-005-WIN-20260925`（`references/ed-parity-005-reference.md`），目标 IDEA Ultimate 2026.2.3 / IU-262.10968.63。
- Taomni 侧：browser `TC-IDE-PARITY-005-02`（live 模板路径）+ native `TC-IDE-PARITY-005-05`（真实 JDT LS）。
- **IDEA 原件不在本机**（`qa-ui-auto-report/idea-reference/ed-parity-005/` 缺失，P1 采样宿主不同）。IDEA 侧结论依据参考包文字记录，不做像素级 matched 宣称。
- 凡参与实现的结论均为自检，非独立验收。

## 逐状态对照

| 状态 | IDEA（参考包记录） | Taomni（本轮运行） | 功能 | 视觉 | 交互 |
|---|---|---|---|---|---|
| R0-ready | zulu-22/language21，module 可用（04-open/33-sdk） | native 05：lsp-status-pill 显示 Java，completionTargets 可见，popup 出现 | 一致（语言服务就绪才给候选） | 自检一致（状态 pill 可辨；主题不同） | 一致 |
| R1-list | `StringUti` Basic 后 3 项全为 lang3（07-basic） | native 05：同前缀下 provider 首项为 JDK 内 `com.sun` 双胞胎，lang3 第二；browser 01：live 模板 4 项 | 部分一致：Taomni 如实呈现 provider 排序，不伪造 lang3 第一（已在 05 case 中显式下选 lang3 行断言） | 自检一致（列表/选中行/文档可辨） | 一致 |
| R2-selected-doc | Ctrl+Q 详情在列表左侧（08-selected-doc） | browser：detail 行内显示；docs 弹层位置由 CM positionInfo 决定 | 一致（详情可读） | 位置策略不同（CM 侧弹层 vs IDEA 左侧），可用性等价，接受差异 | 一致 |
| R3-accepted（类型） | Enter→`StringUtils`+单一 lang3 import，caret 在 identifier 后（09-accept） | native 05 R1 全绿：单一 lang3 import（Ln6）+identifier（Ln32）一次 dispatch，存盘字节一致，一次 Undo+存盘恢复前缀 | 一致（导入位置/数量一致） | 自检一致（caret 在 identifier 后；主题/字体不同） | 一致 |
| R3-accepted（词中） | Enter→保留 Suffix，Tab→替换 Suffix（17–21） | 单测精确覆盖（insert/replace intent + 双 range + 一次 Undo）；native 05 R2 全绿：Enter→StringUtilsSuffix，Tab→StringUtils，各一次 Undo 回 Tmid | 一致 | — | 一致 |
| R3-accepted（方法） | 接受得 `append()`，caret 在括号内（26） | DEC-08 用户决定：保留 provider 原始 snippet，不清空参数；native 05 R3 按原始报文断言 | 接受差异（已裁决） | — | 接受差异（已裁决） |
| R4-undo | 类型/方法各一次 Undo 恢复前缀（含 import） | 单测（一次 dispatch/一次 Undo）+ browser 02（live 路径三次入口各一次 Undo）全绿；native 05 待确认 | 一致 | — | 一致 |
| R5-cancel | 重开 Esc 保留 prefix（14-cancel） | browser 03：Esc 零提交、焦点回编辑器；单测：pending 接受 Esc 中止、迟到不复活 | 一致 | — | 一致 |
| R6-edge | 窄窗 950×390 列表靠 caret，docs 左侧，可越主窗留屏内（44/47） | Taomni DOM 限于 viewport，保证控件可达（设计已定，不要求越窗） | 一致（可达性） | 宿主适配差异（已接受） | 一致 |
| live template | fori 导航+结尾格式化产生额外 Undo（35–41，不引入） | 保留纯导航无 edit、一次原子接受；browser 02 全绿 | 接受差异（已裁决） | — | 接受差异（已裁决） |
| resolve 失败 | IDEA 无 gate 概念（不可比较） | Taomni gate：Retry/primary-only/Dismiss（单测 20 项 + Rust 分类器 + native 05  honesty 断言） | Taomni 特有合同（fail-closed），记不可比较 | — | Taomni 特有 |

## 已接受差异汇总（不阻塞）

1. DEC-08：provider snippet 默认值/占位符保留，IDEA `append()` 清空差异接受。
2. live template 结尾格式化及额外 Undo 不引入。
3. IDEA native 弹层可越主窗；Taomni 限 viewport，保证可达。
4. provider 排序如实呈现（com.sun 双胞胎第一），不伪造 lang3 首选。
5. resolve gate 为 Taomni 故障适配，IDEA 侧不可比较。

## 未验证 / 缺口

- native 05 R1/R2/R3：本轮 05c 在 Linux/WebKitGTK 全绿（run-20260925-184614）；Windows/WebView2、macOS/WKWebView 保留未验证。
- 受控 fault-injected null/error resolve 的 native 协议证据：本轮无隔离 fault 设施，保持单测覆盖，记未验证。
- IDEA 原件像素对照：原件不在本机，不签 matched。
