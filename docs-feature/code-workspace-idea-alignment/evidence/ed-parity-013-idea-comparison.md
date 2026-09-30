# ED-PARITY-013 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11，`Default for XWin` keymap（父 `$default`）。绑定来源：安装包 `lib/intellij.platform.ide.impl.jar!/keymaps/{$default,Default for XWin}.xml`，由脚本抽取成 `src/components/editor/workspace/__fixtures__/ideaXWinKeymap.ts`（104 个可映射动作）。交互/UI 来源：[控件级复核 §4/§7](../references/idea-control-audit-20260929.md#keymap)（`idea-24/40..45`，同一隔离 fixture）。
- Taomni：分支 `feat/ed-parity-013-keymap`（`db9021b4` → `461bf536` → `bc47a84c`），browser 1400 宽 Chromium；native 由 CI 三端运行。

| 维度 | IDEA 观察 | Taomni 现状 | 结论 |
|---|---|---|---|
| §7 `Ctrl+Shift+A` | Find Action（Actions 分类，含 Assign Shortcut） | Find Action 打开 Search Everywhere Actions，`Alt+Enter` = Assign Shortcut（TC-013-01） | 功能 matched；弹层外观 different（014 负责） |
| §7 `F12` | Jump to Last Tool Window | 同（TC-013-02）；旧行为在 Taomni Classic 方案（TC-013-04） | matched |
| §7 `Alt+2/7/9` | Bookmarks/Structure/Git 工具窗 | TODO&Bookmarks / Outline / Git 管理器 | 功能 matched；Git 为独立标签（018） |
| §7 `Shift+Esc`、`Ctrl+Shift+F12` | 隐藏当前/全部工具窗 | 同（TC-013-02） | matched |
| §7 `Ctrl+Alt+S` | Settings | 打开应用 Settings 标签 | 功能 matched；Settings 为标签页而非对话框（different, accepted） |
| §7 `Alt+0` / `Alt+4` | Commit / Run 工具窗 | Alt+0 未绑定（018）；Alt+4 = Run Tasks | Alt+0 unverified→018；Alt+4 matched-with-note |
| 全映射 XWin 绑定 | 104 个动作 | 除 `ideaKeymapAcceptedDifferences.ts` 的 6 条（附 DEC）外全部一致；门为 `CodeWorkspaceTab.test.tsx` “A4.2 … match IDEA XWin” | matched（Linux）；Windows `$default`、macOS keymap 未逐项对照 |
| 快捷键显示 | 键帽拆分、方向键本地化、当前平台修饰键 | 统一格式化、键帽、zh-CN 方向键、Win/Linux 无 Meta（TC-013-02、单测） | 交互 matched；mac 字形（⇧⌘）different → 019 |
| Keymap 组织 | 分组树、Find by Shortcut（Second stroke）、行右键 Add Keyboard/Mouse/Remove、默认方案可直接改（派生 copy） | 同类控件（TC-013-03、对话框单测） | 交互 matched；分组依据为 Taomni 分类而非 IDEA 菜单树（different, accepted） |
| 录制对话框 | Keyboard Shortcut 对话框，First/Second stroke，冲突 “Already assigned to” | 子对话框同结构；Enter/Esc/Backspace 为录制控制键（IDEA 可录 Enter） | different（Enter 不可绑定，ED-PARITY-004 延续） |
| Add 语义 | Add 追加到已有绑定 | 追加（DEC-013-12） | matched |
| Keymap 关闭焦点 | 回到编辑器 | 回到打开前元素或活动编辑器（TC-013-01 R4） | matched |

未测：Windows/macOS 上 IDEA 的实机 keymap 截图；IME/AltGr 在 IDEA 侧的对照；这些维度保持 unverified。
