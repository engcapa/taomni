# macOS Home 与窗口布局修复

## 问题与边界

0.5.4 macOS 主窗口截图中的四处异常属于两个布局边界：原生 overlay 窗口按钮与整个 workbench 的空间分配，以及 WKWebView 中 Home grid 卡片的百分比高度。

原来的 `ControlBar` 在主画布内部预留 76px，但原生按钮的位置属于窗口，位于左侧 rail 上方。该预留既不能保护 rail，又会随 navigator 展开而向右移动，产生工具栏开头的空白。

Home 的 LocalTerminal/WSL/Mail 卡片使用 `h-full`，同时作为不定高 flex 内容中的 grid item。WebKit 的百分比高度解析会使卡片超出 grid 行；卡片底部动作随之落到历史列表下方，造成第一张卡片的巨大空面板，以及看似新增的一排动作面板。历史列表后应只有 Tips 与 Welcome/版本页脚。

## 实现

- 仅真实 macOS native-menu 主窗口在 workbench 外预留 28px 原生标题区域，rail、navigator 和 canvas 一起避让窗口按钮；该区域继续支持拖动。
- 移除 ControlBar 内 76px 的独立占位。展开与收起侧栏时，工具栏入口始终紧邻画布左边。
- Home 启动 grid 不参与 flex 压缩，卡片使用内容/行高拉伸，不使用 `height: 100%`。
- 保留启动终端、新会话、导入、工作区、Git、LAN/Mail、Tools/MFA、历史和页脚入口。侧栏快捷键、工具栏、窗口拖动与其它系统布局沿用既有行为。

## 验证范围

基线提交：`4f7a4f13`。工作分支：`fix/macos-home-shell-layout`。

新增 `TC-WS-083`（browser/native）：检查卡片及动作不超出 grid，grid 位于历史上方，历史之后仅 Tips 和 Welcome/版本；检查 macOS 原生标题区与 Home 按钮不重叠；展开/收起侧栏时无 76px 工具栏空白；点击新会话、取消并回到 Home。

相关既有用例：`TC-WS-001`（共享工具栏与侧栏）、`TC-WS-016`（Home 全部入口和窄屏）、`TC-WS-049`（共享拖动区域与控制命中）。另外运行完整 `crash-regression` browser/native 集合，native 使用匹配本次产品源码的隔离 QA release。

仅改变样式与窗口组合，复用现有 Home/ControlBar/Sidebar/MainLayout 单元回归；布局错误由真实浏览器及 WKWebView 几何断言保护，不用 jsdom 模拟布局尺寸。

执行证据保存在 `qa-ui-auto-report/macos-home/`。运行结果与 GitHub 链接在验证完成后补充。

### 本地已执行结果

- Node 22.23.4 / pnpm 10.34.9 下全量 Vitest：658 个文件，6160 passed / 5 failed / 1 skipped。`unit.log` 保留原始失败。
- 独立改前 checkout `/tmp/taomni-home-layout-baseline` 重跑上述四个文件：相同五条失败（`unit-baseline.log`），涉及 SSH cwd 初始化两条、VNC Linux 剪贴板一条、legacy workspace loose-file 恢复一条、Project Tree 分隔器宽度一条。本次相关 Home、ControlBar、Sidebar、MainLayout 单测在全量运行中通过。
- `pnpm build --mode qa` 通过：TypeScript、refactor contracts/boundaries/source size 和 Vite。隔离 QA release 原生构建通过。
- browser 相关用例 `TC-WS-001/016/049/083` 4/4 通过；随后完整 browser crash-regression 加最终版 TC-WS-083 共 9/9 通过，无跳过。
- macOS native `TC-WS-001/083` 2/2 通过，无跳过；已检查真实 WKWebView 截图，卡片动作均留在第一排，Tips 与 Welcome/版本正常位于历史面板之后。
- `qa_ui_auto.audit --gate` 通过。完整 native crash-regression：8/9 通过，TC-WS-054 在冷重启的原生关窗步骤失败。独立只读探针访问 System Events 同样超时，而 AppKit 进程查询正常，定位为本机 System Events 自动化边界阻塞；失败原件保留，不能记为通过。GitHub 执行结果待补充。
