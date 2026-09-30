# ED-PARITY-019 组合收口对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11，默认 keymap、Source Code Pro 16（各卡同一 profile）。
- Taomni：叠加分支 `feat/ed-parity-019-closure`（010→022 全部卡），`qa-ui-auto-platforms.yml` 三端 browser + native。
  - 组合运行 36663758184（head 1e4f7ce9）：browser Linux/Windows/macOS 各 59/59；native Linux 23/24、Windows 17/18、macOS 9/10，唯一失败为 019-01 发现的编辑器 tab 缺 `role=tab`（已修 4c5b34b1）。
  - 修复后复跑 36666050627（head 4c5b34b1）：browser 三端 59/59，native 除 019-01 外全部通过（019-01 R1/R2 已通过，R3 的 `text=` 定位器在 native 不可用）。
  - 用例修正后 native 复跑 36667919152（head 6b472647）：019-01 在 Linux、Windows、macOS 均通过。

## 1. 各卡对照汇总（A1）

| 卡 | 对照记录 | matched | different | unverified |
|---|---|---:|---:|---:|
| 010 工具窗 rail/状态栏 | ed-parity-010-idea-comparison.md | 6 | 0 | 1 |
| 011 编辑器表面 | ed-parity-011-idea-comparison.md | 5 | 2 | 1 |
| 012 查找/替换/Go to Line | ed-parity-012-idea-comparison.md | 8 | 2 | 0 |
| 013 Keymap/Find Action | ed-parity-013-idea-comparison.md | 5 | 1 | 2 |
| 014 导航弹层 | ed-parity-014-idea-comparison.md | 6 | 5 | 1 |
| 015 Java 语言服务就绪/Problems | ed-parity-015-idea-comparison.md | 7 | 3 | 0 |
| 016 Structural Search | ed-parity-016-idea-comparison.md | 5 | 3 | 0 |
| 017 行内 Rename/Extract/Preview | ed-parity-017-idea-comparison.md | 8 | 4 | 0 |
| 018 Git 工具窗 | ed-parity-018-idea-comparison.md | 5 | 3 | 0 |
| 020 代码洞察弹层 | ed-parity-020-idea-comparison.md | 6 | 1 | 1 |
| 021 上下文菜单 | ed-parity-021-idea-comparison.md | 8 | 4 | 0 |
| 022 Gutter/error stripe | ed-parity-022-idea-comparison.md | 7 | 3 | 0 |

`different` 与 `unverified` 行保留在各卡记录中，本卡不改写结论。

## 2. 三端维度（A2，TC-IDE-PARITY-019-01 + 既有用例）

| 维度 | Linux WebKitGTK | Windows WebView2 | macOS WKWebView | 证据 |
|---|---|---|---|---|
| 平台快捷键（Find Action、Alt/Cmd+1、IDEA 默认绑定） | passed | passed | passed | 019-01 R2、010-04、013-05 |
| 焦点返回（Esc、工具窗、弹层） | passed | passed | passed | 019-01 R2/R3、012-01 |
| 编辑器 200% 缩放 + 快捷键/焦点 | passed | passed | passed | 019-01 R3 |
| 主题（高对比） | passed | passed | passed | 019-01 R3 |
| role/name/state | passed | passed | passed | 019-01 R1（修复后） |
| 窗口恢复 | passed | passed | passed | 019-01 R4、IMPROVE-007 |
| IME | passed（fcitx5，IMPROVE-008） | unverified | unverified | 手工步骤见设计 §3 |
| 屏幕阅读器、系统级 200% 显示缩放 | unverified | unverified | unverified | 手工步骤见设计 §3 |

## 3. 结论（A3）

当前端（Linux）unit、typecheck、build、browser、native、provider 全部通过；Windows/macOS 的 browser 与 native 自动化同样通过。真实 IME（Windows/macOS）、屏幕阅读器与系统缩放未执行，按设计 §3 的步骤补测，不计为三端通过。
