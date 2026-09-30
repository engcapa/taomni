# ED-PARITY-010 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11，窗口 1400×1000（[控件级复核 §1](../references/idea-control-audit-20260929.md#shell)，`idea-01-shell`、`idea-33-commit`、`idea-34-git`、`idea-35-after-hide`）。
- Taomni：分支 `feat/ed-parity-010-shell`，browser 1400 宽 Chromium；native 由 CI 三端运行 `TC-IDE-PARITY-010-04`。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 左 rail | Project、Commit、Structure…；下部 Terminal、Problems、Git 等，选中蓝底 | 左 rail：Project、Commit（→Git 管理器）；下部为全部底部工具窗 + More tool windows（TC-010-01） | 结构 matched；Commit/Git 为管理器标签（018），different-accepted |
| 右 rail | Notifications、AI Chat、DB… | Structure、Docs | 结构 matched；内容集合 different（本批次边界外） |
| 侧窗 + 底窗同时打开 | 可以，各自保留尺寸 | 可以（TC-010-01 R2、TC-010-03） | matched |
| 工具窗切换键 | Alt+1/4/6/7/9/F12 切换，再按隐藏；Shift+Esc；Ctrl+Shift+F12 | 同（013 绑定 + TC-010-01/02、013-02） | matched；Alt+0（Commit）按 DEC-013-07 待 018 |
| 工具窗头部 | 标题 + 子标签 + ⋮ + — | 标题 + 工具自身内容 + ⋮（Hide / Restore Default Layout）+ —（TC-010-01） | matched |
| 空编辑器 | 快捷提示列表（Search Everywhere、Go to File、Recent Files、Navigation Bar、Drop files） | 同，键帽来自当前 keymap（TC-010-02 R3） | matched |
| 主工具栏 | 项目、VCS、运行配置 + Run/Debug、搜索、设置、⋮ | 项目、Git、运行配置 + Build/Run/Debug、搜索、设置、⋮（其余编辑控件在 ⋮，TC-010-02 R1） | matched（Build 按钮额外保留，IDEA 亦有 Build 图标） |
| 状态栏 | 左导航栏；右 `行:列 (N chars)`、换行符、编码、缩进、锁 | 左导航栏；右 `行:列 (N chars)`、EOL、编码、`N spaces`、锁、LSP、Git、字号；应用级段隐藏（TC-010-02 R2、StatusBar 单测） | matched；导航栏交互在 011 接入 |
| 视觉像素/字体 | Source Code Pro 16、UI 16px | 未统一 profile | unverified（019） |
