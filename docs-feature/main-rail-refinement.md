# 主窗口左侧工具栏与全高拖拽带

开发分支：`feat/main-rail-full-height`。常驻 Sessions/Tools 与当前标签的工具窗口统一为图标按钮，名称可切换并持久化；最左侧拖拽示意贯穿标题栏、内容区和状态栏。

实现与保留行为：

- 主窗口预留 18px：边缘 6px 用于缩放，其右侧 12px 为全高拖拽带。保留标题栏空白处拖拽和双击最大化，拖拽事件共用一个处理函数。
- Sessions/Tools 复用 `ToolWindowRailButton`，统一圆角、选中态、悬停态、键盘焦点和本地化名称。使用真实 button，支持 Enter/Space；两入口始终常驻。
- 常驻菜单和工作区菜单共享名称偏好。名称模式默认栏宽 59px，纯图标模式 40px；嵌入栏填满宿主宽度，用 inset 边界避免额外消耗宽度。
- 图标明确为 16px，包裹区 20px，点击高度至少 32px，名称行高 12px。根字体为 12px 时不再因 rem 而缩小。工具组不压缩，内容过密时滚动；WebKit 滚动条不占用工具栏宽度。
- 展开侧栏的分栏框和内容框使用 `overflow: clip`，由会话树负责滚动，避免滚动到选中会话时横移并裁切常驻栏。主窗口也限制水平溢出。双击处理第二次 click，避免侧栏换挂载后重新展开。
- 保留标签分组的侧栏状态记忆、Project 展开/隐藏、工具窗口菜单、SSH 附加 SFTP 开关以及 Settings/Git 入口。

最终执行：[QA UI Auto Platforms 37100596853](https://github.com/engcapa/taomni/actions/runs/37100596853)，测试提交 `fccd3c1ee5611f8438d4d9cb2359c7bd06c25e65`。通过 `gh` 和代理 `http://192.168.0.110:31028` 推送与触发。后续验收文档提交不修改产品、runner 或用例输入。

| 平台 | browser 通过/选择 | native 通过/选择 | 失败 | 跳过 |
|---|---:|---:|---:|---:|
| Linux / Ubuntu 24.04 x64 | 6/6 | 5/5 | 0 | 0 |
| macOS 15 ARM64 | 5/5 | 4/4 | 0 | 0 |
| Windows 2025 x64 | 6/6 | 4/4 | 0 | 0 |

合计 30/30。用例范围为新增 `TC-MAIN-RAIL-01`（常驻按钮、名称双向切换、持久化、Enter/Space、标签/面板切换、逐按钮尺寸），`TC-MAIN-RAIL-02`（browser 中文、明暗主题、800px 窄窗口、Problems 操作），`TC-MAIN-RAIL-03`（Linux native 真实三点拖拽），以及保留回归 `TC-IDE-PARITY-027-01`、`TC-IDE-PARITY-027-02`、`TC-IDE-PARITY-027-03-merged-rail-workspace-native`、`TC-100`、`TC-011`。用例相互独立；仅声明适用的平台/模式执行，不将其他组合计为通过。

Linux、macOS、Windows 的原生几何记录逐个检查全部 16 个常驻/工作区按钮：名称模式均为 `53×39.5px`，纯图标模式均为 `34×32px`，SVG 均为 `16×16px`。尺寸记录在 `element-geometries.jsonl`；直接覆盖用户指出的 Linux 标签工具按钮缩小问题。

Linux/X11 的上、中、下拖拽点分别为高度的 15%、50%、85%。三个手势均独立观测到窗口从 `(120,120)` 移到 `(144,138)`，大小保持 `1000×680`；拖拽带实际矩形为 `x=6, y=0, width=12, height=680`。记录在 `native-window-drags.jsonl`，由真实 xdotool 输入和独立 OS 窗口几何读数证明，移动后 Sessions/Tools 仍可操作。

已人工复核最终 Linux/macOS 的 browser 明暗/中文/窄窗口截图、两平台 native 的名称/纯图标及 SFTP 截图，以及 Windows native 的名称和 SFTP 截图。图标尺寸、对齐、选中态、全高示意正常；密集名称通过滚动容纳。新增 SFTP 边界断言分别要求 Sessions、Tools 完整位于拖拽带右侧与侧栏右边界之间。

`TC-011` 保留保存、认证、双栏、传输队列和精确目标路径验收。旧标签文字操作改为已有用户名复选框，使三个 native 组合真正执行；路径编辑使用明确的 Edit 按钮并等待输入框。此前 Windows 中点击路径栏中央会命中面包屑导航按钮；Linux/macOS 的功能步骤曾通过，但截图发现常驻栏被祖先滚动容器裁切，已修复并加入上述边界回归。

原生可见性断言现在检查实际布局和 CSS 可见状态，允许 Project 隐藏后继续挂在 DOM 中，且复用 native 选择器转换以兼容 scoped text/role/XPath。macOS QA 键盘桥为构造事件补充 HTML 按钮默认 Enter/Space 激活，遵守取消事件、禁用、焦点和修饰键。

本地仅运行单元测试，没有启动 browser/native 应用或构建。最新相关 Sidebar/MainLayout 批次 53 项通过；相关 QA 工具批次 47 项及用例选择/行为契约批次 16 项通过（批次存在重叠，不相加为总覆盖）。此前工具按钮、拖拽处理、控制栏、偏好持久化和 macOS 键盘桥单元测试亦通过。使用 Node 22、pnpm 10；主要命令：

```text
pnpm test src/components/sidebar/Sidebar.test.tsx src/layouts/MainLayout.test.tsx
python -m unittest test_native_assertions test_window_drag test_element_geometry test_behavior_contract test_mouse_steps
python -m unittest test_ci_selection test_behavior_contract
```

原始报告、截图、回执、构建身份和选择清单位于对应 workflow artifacts，本地保留于 `qa-ui-auto-report/main-rail/run-37100596853/`。已核对汇总、选择清单、全部报告与回执、关键截图/几何记录的哈希及三平台原生构建身份，均匹配。匹配的生产源码指纹为 `5e95cfc7338a84c95d1f9ccfa8e9b3358719c1b99c6612497a50ccc6abb5f547`，runner 指纹为 `ce5cf2c2b68b82f52fec8c837e5083bbf94649b8d8f45409fc15827eef2da2c7`。原生应用身份为 `com.taomni.app.qa`，以独立配置和数据运行 debug QA 构建。

测试边界：browser 为各宿主上的 Chromium；native 分别为 WebKitGTK、WKWebView、WebView2。macOS 交互通过原生 QA 应用的 WKWebView 桥执行，不能证明物理键盘或 OS 窗口拖拽；实际 OS 拖拽自动化证据仅覆盖 Linux/X11。明暗主题和 800px 窄窗口的组合来自 browser 用例，不能外推为原生组合验收。
