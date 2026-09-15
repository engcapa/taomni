# REF-TREE-OPEN-FOCUS-LINUX-20260914

2026-09-14，REQ-02 / CW-PROJ-002；CW-PROJ-003 仅菜单打开/取消。此包是 IDEA 实测输入，不是 Taomni 对齐报告。关联 [设计](../../../docs-issue/code-workspace-tree-open-focus-design.md)、[规划身份与工件清单](../evidence/tree-open-focus-plan-20260914.json)。

## 1. 身份与适用配置

本机 Ubuntu 24.04 x86_64、Cinnamon/X11，实际运行 **IntelliJ IDEA Ultimate 2026.2.2，IU-262.10315.125**。升级后安装目录仍叫 `/data-raw-hdd/dev/idea-IU-253.30387.90/`，不得从目录名推断版本。依据为安装 product-info、15:01:06 的当前启动日志及 `r2-08-about.png/json`。PID 1983553、X window 119537740，input child 119537746；这是采集身份，后续不可硬编码复用。Runtime 25.0.4+1-b508.27 amd64；JCEF 144.0.15-262-b37。

| 项目 | 核实值 / 依据 |
|---|---|
| 屏幕、客户区 | 1920×1080；原图 1920×1044，客户区屏幕坐标 (0,36)，Xlib geometry；wmctrl 的 y=72 不作裁剪依据 |
| OS DPI/scale | xrdb Xft.dpi=96；Cinnamon scaling-factor=0（自动），text-scaling-factor=1.0；不把自动值解释成强制 100% |
| IDEA 外观 | Islands Dark；UI zoom 110%；自定义 UI 字体 Dialog 16；`16-settings-ready` |
| editor | Classic Light scheme；Source Code Pro 16、line height 1.2、ligatures off；scheme font override unchecked；`22-editor-font`、`23-scheme-font` |
| keymap / 语言 | XWin，`18-keymap-ready`；GUI 英文；输入为 ASCII 的 XTEST OS 事件，不是物理键盘/IME 实测 |
| Project Behavior | Enable Preview Tab、Open Files with Single Click、Open Directories with Single Click、Always Select Opened File 均关闭；`36-tree-behavior`，preview 同见 `31-tabs-preview` |
| fixture / 插件 | 下述 F0 纯文本，不依赖 Java SDK/语义 provider；README 显式切 source view；不宣称插件生态一致 |

设置仅查看、Cancel 退出；没有修改用户全局 preview 默认值。历史 [Windows 参照](project-tree-navigation-2026.2.2.md) 的导航/Enter 结论继续按原日期使用；历史字体/单击设置不足以验收本轮像素。历史 IDEA 原件 `qa-ui-auto-report/project-tree-e2e/idea/` 与 Taomni P0 原件 `qa-ui-auto-report/overall-audit-20260913/` 在本机缺失，不伪称重跑 P0 B03–B05。

## 2. 工件、隔离与重建

原始包：[20260914-linux](../../../qa-ui-auto-report/idea-reference/tree-open-focus/20260914-linux/)。PNG 为原始客户区截图；同名 JSON 为 action/time/before/after PID、窗口与 geometry。`capture.py` 是本地一次性 Xlib/XTEST 采样脚本，不是 qa runner 或产品测试实现。`review-contact-sheet.png`、`r2-review.png` 是缩略审阅图，不替代原图。About 原图有无关许可信息，不转载许可区域。

原件在本机被忽略目录，未入库；交接本机可直接读取。跨机器需取得该目录中下表引用的 PNG/JSON、fixture-manifest、restored-hashes 与捕获脚本，按 [清单](../evidence/tree-open-focus-artifacts-20260914.json) SHA256 校验。拿不到时按步骤重采所缺状态，不能用摘要签发像素 matched。

隔离目录 `qa-ui-auto-report/idea-reference/tree-open-focus/20260914-linux/f0-tree-open-focus/`。字节来自 [.agents fixture SEED_FILES](../../../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py) 和 [F0 catalog](fixture-catalog.md)，UTF-8、LF、无 BOM。IDEA 的 `.idea/` 元数据不计入种子文件。

| 相对文件 | 初始及最终 SHA256 |
|---|---|
| README.md（157 bytes） | `129d0894d94b5ee43912087eea91c53d6e1ef86ff3d1fc12e6d4aaa612252c6f` |
| src/main/example.txt（71 bytes） | `bbbab91a4e4ea594b1e2207721999dc375ac98c30c5960cfbbf1329a441aa01a` |
| docs/notes.txt | `32b23e9c2f782364b0b923f37ffbfe08b43574ef978fa758626065ebd4f9e3cd` |
| tests/sample.txt | `6076b94485933c3a8d3d9aad9468cac29ba559c68734a95b263b6bf9b3a6cb0f` |

example 初始正文：

```text
Project tree example
The editor buffer should survive tree navigation.
```

两轮独占桌面均经用户授权，约 15:04–15:18、15:30–15:39（Asia/Shanghai），结束已归还。每次输入前检查目标 PID、active window、未锁屏；输入后再查 PID。X input child 不是 Swing 焦点组件证据，必须结合 caret、树颜色角色及真实字符落点。最终两份 `restored-hashes.json` / `r2-restored-hashes.json` 的四个种子文件全部恢复；后者时间 15:39:43。

## 3. 连续实测步骤

下表工件 stem 均指原始包内同名 `.png` 和 `.json`。主链采用重新采集的 r2；设置/鼠标/分屏用第一轮焦点有效区段。初始只开 README source tab、无 dirty、光标 1:1；折叠 docs/src，README 正文可见。树文件显示 size/time 是该 profile 的附加显示，不纳入首包。

| 状态 / 原件 stem | 实际动作与结果 |
|---|---|
| r2-02-close-example、r2-09-close-about | 关闭 split leaf、example tab 后只余 README；About 关闭回 IDEA |
| r2-10-docs-label | 单击 docs 标签：只选中，不展开；README 正文不变 |
| r2-11-docs-expand、r2-12-docs-collapse | Right 展开 docs，Left 收起；树焦点、正文不变 |
| r2-13-src 至 r2-17-example | Down 到 src；Left 折叠；Right 展开，Right 选 main，Down 到 example；README 仍唯一 tab。单子目录可自动展开，不能据此要求每次 Right 只展开一层 |
| r2-18-enter | Enter 正式打开 example，README 保留；caret 1:1，树选择由蓝变灰 |
| r2-19-input、r2-20-undo | **没有点击 editor**，直接 x 得到 xProject、caret 1:2；Ctrl+Z 恢复正文与 1:1 |
| r2-21-return-tree | 单击 example 行，树重获蓝色选择，正文不变 |
| r2-22-menu、r2-23-escape | 右击 example 打开行菜单；Esc 取消，树蓝色选择恢复，正文/两 tab 不变 |
| r2-24-reopen 至 r2-27-save | 已打开的 example 再 Enter；直接 y 进入同一 editor；Ctrl+Z、Ctrl+S 后字节恢复，无重复 tab |
| 38-docs-label、39-docs-arrow、40-docs-left | 单击目录标签仅选；箭头展开；Left 收起；不改 README |
| 56-file-single、57-file-double | example 已开时单击 README 只改树选择；双击 README 才激活其 tab，树失焦 |
| 58-docs-double、59-docs-enter | 双击 docs 展开；Enter 折叠；正文保持 README |
| 60-example-double、61-tab-context、62-split-right | 双击 example 打开；tab 菜单 Split Right 建右侧 view |
| 63-split-input、64-split-undo | 右侧直接输入 z，共享正文同时变化；Ctrl+Z 恢复 |
| 65-split-return-tree 至 69-save-restored | Alt+1 回树；Enter 重开 example，仍进此前 active 的右 leaf；q 的 caret 在右侧，共享文本双侧更新；undo/save 恢复 |
| 50-return-tree、51-example-context、52-context-escape | 第一轮 Alt+1 回树/右键/Esc，与 r2 单击回树路径互补 |

必要配置与行为目标已实测。IDEA 菜单有 Open In Right Split（显示 Shift+Enter），首包**不据此替换 Taomni 已授权保留的 Ctrl/Cmd+Enter**；分屏只复用 active leaf 结果，不宣称快捷键逐项相等。菜单全部事务内容也不纳入本包。

## 4. 视觉角色与测量边界

r2-17 / r2-18 / r2-23 同一客户区的 x=640、y=259..288 是 example 行背景连续 30 原始像素：树获焦选中 RGB(42,67,113) `#2a4371`；editor 获焦时选择仍在、失焦 RGB(51,53,59) `#33353b`；树底色 RGB(25,26,28) `#191a1c`。该测量可由 Pillow 逐像素复核，不是主题全局 token 的推断。

目标角色：选择与焦点分开；失焦不清空选中，重新回树恢复焦点样式；正文 caret 与 tab 激活指向同一 leaf；右键菜单锚定该行/指针、覆盖于正文之上，不移动布局。这里菜单未在屏幕边缘重采；边缘约束、错误/disabled 样式属于 Taomni 可达性适配，不伪装 IDEA 实测。仅在上述主题/字体/客户区/DPI/UI zoom 匹配时以 30px 行高作局部几何目标，建议实现/测量容差 ±1 原始像素（项目验收选择，不是 IDEA 宣称）。不同字体/scale 时先匹配环境，不拿 30px 硬套 CSS。

本轮不运行 Taomni，所以没有双侧新截图、像素差或 native 通过；不做整体 Islands 主题改版。设计图为状态示意，不是实拍。

## 5. 无效记录、缺口与最小补采条件

- 升级前 00–02、黑图 01、序列 10 的 metadata 序列化失败，以及中间未稳定的设置过渡图：准备/诊断，不作目标依据。
- 第一轮尾部拟执行 70–72：Ctrl+Shift+A 触发 Feishu 全局快捷键，guard 检测 PID 漂移立即停止，没有向其他 app 输入查询。整个受干扰尾段作废；不能把它当 IDEA Action Search。r2 改走可见菜单取得 About 并完整重复主链，全部 PID 检查通过。
- preview **开启**时鼠标行为、真实物理键盘/IME、其他 OS keymap、菜单屏幕边缘、根节点特例/所有 compact 层级、慢加载/失败/切 workspace，不在 IDEA 本次实测覆盖中。首包选定 preview-off profile；这些未观测项不挡已确定目标，Taomni 相关保留/迟到保护由设计 AC 验证，不能宣称这些 IDEA 状态已对齐。
- 若后续 build/profile 改变或本机原件丢失：先约独占桌面约 8–10 分钟，核对 PID/锁屏与设置，按 r2-02、10–27 加 36/56–69 所缺状态最小重采；输入交错片段作废。不要全量重做 P0，不自动解锁，不自动使用用户桌面。
