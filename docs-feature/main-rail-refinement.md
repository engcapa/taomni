# 主窗口左侧工具栏与全高拖拽带

分支：`feat/main-rail-full-height`。目标是让常驻 Sessions/Tools 与当前标签的工具窗口使用相同图标按钮、名称显示设置和选中样式，并将窗口拖拽示意移到最左侧全高位置。

验收：拖拽带贯穿标题栏到状态栏，与原生边缘缩放区域分别可操作；Sessions/Tools 支持鼠标和 Enter/Space，名称可从右键菜单切换并持久化，两个入口在标签切换和侧栏折叠后始终可达。中文名称正向横排，明暗主题和窄窗口正常。

重点风险来自用户指出的 Linux 旧版本问题：标签所属工具按钮比 Sessions/Tools 缩小。主栏与嵌入栏使用明确的共享宽度，工具分组不压缩，WebKitGTK/WKWebView 显式隐藏滚动条以避免占用部分工具栏的宽度。验收同时比较实际按钮宽度、最低 32px 点击区域，并操作 Project 和底部 Problems；最终检查截图。

保留行为：每类标签的侧栏状态记忆、Code Workspace 工具窗口展开/隐藏和右键菜单、SSH 附加 SFTP 开关、标题栏空白处拖拽与双击最大化、Settings/Git 入口继续有效。

验证：本地仅运行相关 Vitest 与 QA 工具的 Python 单元测试；browser/native 在 `qa-ui-auto-platforms.yml` 执行。新增 `TC-MAIN-RAIL-01`（三个平台 browser/native 的图标、名称、键盘、持久化、工作区切换），`TC-MAIN-RAIL-02`（browser 中文/主题/窄窗口），`TC-MAIN-RAIL-03`（Linux native 全高拖拽上中下三点真实 OS 位移）。保留回归选择 `TC-IDE-PARITY-027-01`、`TC-IDE-PARITY-027-02`、`TC-IDE-PARITY-027-03-merged-rail-workspace-native` 和 `TC-100`。所有用例独立，不需要顺序依赖。

CI 结果及视觉评审在执行后补充；目前不声明未执行的平台通过。
