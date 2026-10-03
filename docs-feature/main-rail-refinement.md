# 主窗口左侧工具栏与全高拖拽带

分支：`feat/main-rail-full-height`。目标是让常驻 Sessions/Tools 与当前标签的工具窗口使用相同图标按钮、名称显示设置和选中样式，并将窗口拖拽示意移到最左侧全高位置。

验收：拖拽带贯穿标题栏到状态栏，与原生边缘缩放区域分别可操作；Sessions/Tools 支持鼠标和 Enter/Space，名称可从右键菜单切换并持久化，两个入口在标签切换和侧栏折叠后始终可达。中文名称正向横排，明暗主题和窄窗口正常。

重点风险来自用户指出的 Linux 旧版本问题：标签所属工具按钮比 Sessions/Tools 缩小。主栏与嵌入栏使用明确的共享宽度，工具分组不压缩，WebKitGTK/WKWebView 显式隐藏滚动条以避免占用部分工具栏的宽度。应用的根字体为 12px，共享按钮与 More 图标改为明确的 16px 图标、至少 32px 点击区域，避免 rem 缩小。验收逐个检查常驻和工作区按钮的实际宽高与图标尺寸，记录 `element-geometries.jsonl`，并操作 Project 和底部 Problems；最终检查截图。

保留行为：每类标签的侧栏状态记忆、Code Workspace 工具窗口展开/隐藏和右键菜单、SSH 附加 SFTP 开关、标题栏空白处拖拽与双击最大化、Settings/Git 入口继续有效。

验证：本地仅运行相关 Vitest 与 QA 工具的 Python 单元测试；browser/native 在 `qa-ui-auto-platforms.yml` 执行。新增 `TC-MAIN-RAIL-01`（三个平台 browser/native 的图标、名称、键盘、持久化、工作区切换），`TC-MAIN-RAIL-02`（browser 中文/主题/窄窗口），`TC-MAIN-RAIL-03`（Linux native 全高拖拽上中下三点真实 OS 位移）。保留回归选择 `TC-IDE-PARITY-027-01`、`TC-IDE-PARITY-027-02`、`TC-IDE-PARITY-027-03-merged-rail-workspace-native` 和 `TC-100`。所有用例独立，不需要顺序依赖。

首轮有效执行为 [37091557195](https://github.com/engcapa/taomni/actions/runs/37091557195)。Linux/macOS browser/native 的原有工作区与 SFTP 用例通过；新增名称用例因错误使用 JSON 存储夹具写入原始语言字符串而中止，现改为使用真实语言菜单和主题按钮。Linux native 的上、中、下三点拖拽均观测到 `(24,18)` 的 OS 窗口位移，窗口大小维持 `1000×680`。修正后会重新执行；暂不声明整体验收通过。

macOS QA 键盘桥接补充构造事件的 HTML 按钮默认 Enter/Space 激活，遵守取消事件、禁用、焦点和修饰键。这属于 WKWebView 内的自动化交互，不能证明 macOS 物理键盘输入。macOS OS 窗口拖拽仍属于独立验证边界；本次实际 OS 拖拽自动化只支持 Linux/X11。

第二轮 [37093099316](https://github.com/engcapa/taomni/actions/runs/37093099316) 的 browser 几何记录确认全部 16 个按钮均为 16px 图标，名称模式同宽 53px，纯图标模式同宽 34px、至少 32px 高。流程发现双击会在侧栏切换挂载后重新展开，现明确处理第二下点击，并补充跨挂载的单元回归。名称行高也改为 12px，避免根字体导致 10px 名称行仅为 9px。native 因新增单元测试的 Node 类型导入编译失败，现改用 Vite raw 源码导入。窄窗口断言保留严格无溢出条件，增加尺寸诊断与有界布局等待，继续验证。
