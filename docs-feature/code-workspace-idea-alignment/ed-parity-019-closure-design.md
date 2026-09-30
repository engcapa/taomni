# ED-PARITY-019 三端可访问性、主题与最终 IDEA 对比收口（P1 设计）

- 卡片：[backlog ED-PARITY-019](backlog.md)；依赖 010–018、020–022 全部交付。
- 参照：各卡 `evidence/ed-parity-0xx-idea-comparison.md`、[验证范围](references/idea-live-audit-20260928.md#verification-boundary)。
- 保留：每张卡自身的用例与结论；本卡不改功能，只做组合验证与记录，`different`/`unverified` 原样保留。

<a id="decisions"></a>
## 1. 设计决定

| DEC | 决定 |
|---|---|
| DEC-019-01 | 组合验证在最上层叠加分支（含全部卡）一次运行 `qa-ui-auto-platforms.yml`：全部卡用例 + 被改动的保留用例，三端 browser + native。 |
| DEC-019-02 | 新增 `TC-IDE-PARITY-019-01`（native，Linux WebKitGTK / Windows WebView2 / macOS WKWebView）覆盖 A2 维度：role/name/state、平台 Find Action 快捷键与 Esc 焦点返回、编辑器 200% 缩放 + 高对比主题下快捷键仍可用、重载后外观与活动 tab 恢复。 |
| DEC-019-03 | IME：Linux 由 `TC-IDE-IMPROVE-008`（fcitx5）证明；Windows/macOS 真实输入法在 CI 无法驱动，记 unverified 并给出人工步骤（§3）。屏幕阅读器同样记 unverified。 |
| DEC-019-04 | A1 追溯：每卡的 IDEA comparison 记录都基于 IDEA 2026.2.2 / IU-262.10315.125 Linux X11 默认 keymap、Source Code Pro 16 profile（[采样设置](references/idea-control-audit-20260929.md)），Taomni 侧统一为叠加分支的同一 fixture（parity007/008 受控 provider、maven-single + JDT LS、workspace_root）。 |

<a id="traceability"></a>
## 2. 追溯矩阵（A1）

| 卡 | 用例（平台） |
|---|---|
| ED-PARITY-010 | TC-IDE-PARITY-010-01（browser ×3）；TC-IDE-PARITY-010-02（browser ×3）；TC-IDE-PARITY-010-03（browser ×3）；TC-IDE-PARITY-010-04-tool-windows-native（native Lin/mac/Win） |
| ED-PARITY-011 | TC-IDE-PARITY-011-01（browser ×3）；TC-IDE-PARITY-011-02（browser ×3）；TC-IDE-PARITY-011-03（browser ×3） |
| ED-PARITY-012 | TC-IDE-PARITY-012-01（browser ×3）；TC-IDE-PARITY-012-02（browser ×3）；TC-IDE-PARITY-012-03（browser ×3） |
| ED-PARITY-013 | TC-IDE-PARITY-013-01（browser ×3）；TC-IDE-PARITY-013-02（browser ×3）；TC-IDE-PARITY-013-03（browser ×3）；TC-IDE-PARITY-013-04（browser ×3）；TC-IDE-PARITY-013-05-find-action-platform-native（native Lin/mac/Win） |
| ED-PARITY-014 | TC-IDE-PARITY-014-01（browser ×3） |
| ED-PARITY-015 | TC-IDE-PARITY-015-01（browser ×3）；TC-IDE-PARITY-015-02（native Lin/mac/Win） |
| ED-PARITY-016 | TC-IDE-PARITY-016-01（browser ×3） |
| ED-PARITY-017 | TC-IDE-PARITY-017-01（browser ×3）；TC-IDE-PARITY-017-02（browser ×3）；TC-IDE-PARITY-017-03（native Lin/mac/Win） |
| ED-PARITY-018 | TC-IDE-PARITY-018-01（browser ×3）；TC-IDE-PARITY-018-02（native Win/Lin） |
| ED-PARITY-019 | TC-IDE-PARITY-019-01（native Lin/mac/Win） |
| ED-PARITY-020 | TC-IDE-PARITY-020-01（browser ×3） |
| ED-PARITY-021 | TC-IDE-PARITY-021-01（browser ×3） |
| ED-PARITY-022 | TC-IDE-PARITY-022-01（browser ×3）；TC-IDE-PARITY-022-02（native Lin/mac/Win） |

各卡 IDEA 对照：`evidence/ed-parity-010…022-idea-comparison.md`（019 汇总见 `evidence/ed-parity-019-idea-comparison.md`）。

<a id="manual"></a>
## 3. 未自动化项与后续步骤（A3）

- Windows 微软拼音 / macOS 拼音输入法：在对应真机打开 workspace，输入 `nihao` 选词、Esc 取消，确认一次 Ctrl/Cmd+Z 撤回整段、取消不留历史（同 IMPROVE-008 步骤）。
- 屏幕阅读器（NVDA / VoiceOver / Orca）：Find Action、Problems、行内 Rename、VCS 弹层的 role/name 朗读。
- 系统级 200% 显示缩放（非编辑器字号）：三端各启动一次，检查 rail、状态栏、弹层不截断。

<a id="cases"></a>
## 4. 用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| TC-IDE-PARITY-019-01 | native ×3 | R1 role/name/state；R2 快捷键与焦点返回；R3 200% 缩放 + 高对比；R4 重载恢复。 |
