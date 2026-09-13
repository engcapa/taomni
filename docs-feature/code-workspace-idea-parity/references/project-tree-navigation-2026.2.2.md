# IDEA Project tree 导航参照 REF-TREE-2026-09-13

基线：Windows，IntelliJ IDEA Ultimate 2026.2.2，build `IU-262.10315.125`。实际操作独立 `fixture` 窗口（1400×992，OS 报告 DPI 96），采样时间 2026-09-13 08:31–08:36（Asia/Shanghai）。深色 New UI，英文标签；UI 字体/缩放和完整 keymap 设置未重新核实，因此不能按截图像素直接要求 Taomni 使用相同字号/尺寸。未采集源码依据。

原始包在采样机器工程下 `qa-ui-auto-report/project-tree-e2e/idea/`，每张原图对应同名 JSON（时间、窗口 PID/HWND/边界、按键/点击、前台标题）。原图未入库；其他机器须取得该目录中的下述有效工件，或按步骤补采。不能仅凭本摘要签发产品匹配。

Fixture 可从 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py` 的 `SEED_FILES` 重建。四个文件均 UTF-8/LF；与 IDEA 初始文件逐字节相同，已校验 SHA-256：

| 文件 | SHA-256 |
|---|---|
| README.md | 129d0894d94b5ee43912087eea91c53d6e1ef86ff3d1fc12e6d4aaa612252c6f |
| src/main/example.txt | bbbab91a4e4ea594b1e2207721999dc375ac98c30c5960cfbbf1329a441aa01a |
| docs/notes.txt | 32b23e9c2f782364b0b923f37ffbfe08b43574ef978fa758626065ebd4f9e3cd |
| tests/sample.txt | 6076b94485933c3a8d3d9aad9468cac29ba559c68734a95b263b6bf9b3a6cb0f |

初始打开 README.md 预览，root 展开、docs 折叠。IDEA 自建 `.idea/`、External Libraries 等项目之外的节点未作为跨产品 fixture 内容。动作使用鼠标和 Win32 keybd_event，方向键带 extended flag；这是共享桌面操作，需沿用用户确认的空闲时段。此轮 fixture 窗口已关闭，用户的 drawing 窗口保留。

| 实际动作/前置 | 实测结果 | 原图名（同目录 PNG/JSON） |
|---|---|---|
| 单击 docs 标签 | 仅选中 docs（蓝色），仍折叠；README 不变 | 08-src-click（命名失误，实际是 docs） |
| docs 选中，Right | docs 展开，仍选中 docs | 09-right-expand |
| docs 已展开，Right | 选中 notes.txt，README 仍是唯一 tab | 10-right-child |
| notes.txt 选中，Left | 选中 docs，子文件仍可见 | 11-left-parent |
| docs 选中且展开，Left | docs 折叠，选择不变 | 12-left-collapse |
| docs 选中，Down | 选中 src，src 仍折叠，README 不变 | 13-down-select-src |
| src 展开且 main 折叠，选择 main | main 选中且仍折叠 | 29-up-main |
| main 选中，Right | main 展开，仍选中 main | 30-right-expand-main |
| main 选中且展开，Down | 选中 example.txt，不打开；README 不变 | 31-down-example |
| example.txt 选中，Enter | 打开第二个 tab，编辑器出现正文/光标；树选择变灰 | 32-enter-example |
| 右键 example.txt，随后 Escape | 菜单覆盖编辑区；取消后选择/正文保留 | 33-context-example、34-context-dismiss |

视觉事实：选中行有小圆角，树有焦点时蓝色、编辑器有焦点时灰色。菜单可覆盖编辑器，不局限于树区域。树行视觉高度约 36 原始像素；因 UI scale 未核实，此值只作当前环境观察。文件名溢出时 IDEA 会显示扩展标签浮层，部分图中选择背景跨过树边缘，不能误读为树行宽度。

无效/诊断采样：03 出现输入法/搜索字符，04–06 是恢复焦点，不能作为方向键事实。14 自动显示 src/main 的已展开子项，16 实际选择了子文件，17 因而选到 tests；18–28 的若干文件名与实际目标不符，只保留为操作诊断，不按文件名推断行为。35 是关闭 fixture 后的共享桌面，不作为参照、不要打包分享。有效事实以以上人工检查过的状态表为准。

本轮只复用普通单选、方向键、Enter、选中/失焦视觉角色和菜单取消。Home/End、批量选择、拖放、重命名、删除、隐藏规则、工具栏布局及三端差异未采样。Taomni 的单击文件永久打开、目录点击切换、Ctrl+Enter 分屏继续作为其已有契约；它们不等于本次已对齐 IDEA 的鼠标行为。
