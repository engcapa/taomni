# Taomni 界面重构外部调研摘要

状态：研究完成；交互原型已完成，等待确认。未形成实施设计、计划、任务或测试用例。

日期：2026-10-07

范围：Taomni `main` 当前生产界面、`feat/ui-layout-refactor` 的实现事实、ZCode 源码与当前桌面截图，以及 Claude Code、ChatGPT Desktop、Kiro Crew、JetBrains Air 的公开交互资料。

原型：[`taomni-ui-refactor-prototype.html`](./taomni-ui-refactor-prototype.html)。这是独立的静态 HTML/CSS/JS 原型，不依赖 Taomni 产品代码或 `feat/ui-layout-refactor` 的组件；直接用浏览器打开即可体验。原型确认前不进入详细设计、实施计划、任务拆分或 unit/browser/native testcase 编写。

## 1. 调研结论

Taomni 当前把连接、终端、SFTP、数据库、远程桌面、邮件、代码工作区、Git、MFA、网络工具和 AI Chat 都放在同一个多标签壳层里。能力很全，但入口分散在标题栏、左侧会话树、工具树、标签右键菜单、终端内嵌按钮、Tao 浮层和状态栏。用户需要先判断“要打开哪一种 TabKind”，再寻找该类型自己的操作入口。

外部产品共同收敛到一个更容易理解的关系：用户先选择工作区或任务，主工作面显示当前工作，执行、文件、变更和 Agent 状态围绕当前工作展开。它们把跨任务的搜索、创建、切换、通知放在稳定的全局位置，把低频设置和高级动作收进上下文菜单或命令中心。

本次原型因此采用“工作区上下文 + 主工作面 + 按需检查器”的三块结构。它保留 Taomni 的终端、远程连接、SFTP、数据库、代码、Git、邮件和 AI 能力作为可插入的工作面，不把业务能力重新拆成多条永久 Rail，也不把所有能力都放进 AI Hub。

## 2. 当前 Taomni 基线（源码事实）

### 2.1 主窗口结构

`src/layouts/MainLayout.tsx` 当前的实际顺序是：

1. `ControlBar`：应用菜单、可拖动标题区域、TabBar、更新提示、当前 Tab 操作槽、Tab 详情、Tab 更多菜单、截图、托盘和窗口控制。
2. 可选 `QuickConnect`：输入连接地址或选择会话后打开连接。
3. 可选顶部/左侧/底部/浮动 `ChatDrawer`：Tao Chat 可以停靠或浮动。
4. 主水平 `PanelGroup`：左侧 `Sidebar` 与右侧内容区，默认左侧约 22%，可在 15%～40% 之间调整并折叠。
5. `Sidebar`：自己的 Rail（Sessions / Tools / Settings）和展开面板。Sessions 面板包含新建、编辑、复制、删除、刷新、收藏、搜索及 `SessionTree`；Tools 面板包含 Servers、Tunneling、SocksCap、Git、Code Workspace、Mail、LAN Chat、MFA 和 Network Tools。
6. 中央内容区：Welcome、Terminal（含多终端 split）、SFTP、RDP、VNC、数据库、邮件、代码工作区、Git 等 Tab 按 `activeTabId` 切换，部分实例保持挂载。
7. `StatusBar`：会话数与当前会话、网络、X11、认证、ASR、LLM、Web Search、Claude Code/Codex、隐私模式、状态消息，以及代码工作区的光标、缩进、编码、换行、语言服务和 Git 状态。

### 2.2 顶部按钮与入口

`src/components/tabbar/ControlBar.tsx` 和 `TabBar.tsx` 中的可见/菜单入口包括：

- 应用主菜单：新建本地终端、远程会话、SFTP；关闭当前 Tab；Sessions 的显示、新建、刷新、导入/导出；View 的命令面板、沉浸模式、Tab 总览、快速切换、最近面板、重置布局、侧栏、Quick Connect、终端 split、Multi Exec；Tools 的 Servers、Tunneling、SocksCap、Git、Code Workspace、Mail、LAN Chat、MFA、Network Tools；X Server、Settings、Help、Exit。
- Tab 区：水平滚动、按类型/分组/搜索筛选、快速打开本地终端、展开新建菜单、单击激活、拖拽排序、双击改名、关闭、右键关闭其它/全部、复制、移动到首尾、复制连接信息、重复 Tab、脱离窗口。
- 当前 Tab 操作槽：不同业务 Tab 通过 portal 注入自己的按钮，例如终端的 split / Multi Exec / Chat / SFTP / Git，SFTP 的传输与脱离，数据库的事务或刷新，代码工作区的上下文动作。
- 侧栏会话工具栏：New、Edit、Duplicate、Delete、Refresh、Favorite、Search。Tools 列表每一行直接打开一个工具 Tab。
- Welcome：本地终端、管理员终端、Home 文件夹、WSL、远程会话、SFTP/文件、LAN Chat、邮件，以及最近工作区/最近会话的过滤、排序、批量选择、批量打开、编辑、定位、复制路径、移除和恢复上次工作集。
- 状态栏：多项状态是可点击的配置入口，部分状态支持右键复制完整值。

### 2.3 当前基线的可用性问题

- 同一个意图有多个入口：例如打开连接可以走 Welcome、Sessions 树、顶部 Tab 新建菜单、主菜单或 Quick Connect。
- 按业务类型组织让用户先理解实现模型；“我要处理某个工作”无法在一个地方看到会话、终端、文件、Git 和 AI 上下文。
- 标题栏同时承担窗口拖拽、Tab 导航、Tab 操作、截图、更新、系统按钮，宽度不足时大量按钮退入更多菜单。
- 状态栏信息密度高且跨越连接、AI、编辑器三种语义，适合诊断但不适合承担主要导航。
- Tao Chat 可以停靠多处，终端、侧栏、Tao 和状态栏存在重复的 AI 入口；关闭/恢复和当前 owner 的关系不容易被首次使用者理解。

## 3. `feat/ui-layout-refactor` 实现事实（只作为现状审阅）

该分支引入了 `src/components/shell/WorkspaceShell.tsx`、`GlobalRail.tsx`、`ShellNavigator.tsx`、`SurfaceSlot.tsx`、`ContextPanelHost.tsx`、`TabNavigator.tsx` 和 `shell.css`，并增加 Shell layout store、layout bridge、panel registry、close coordinator、窗口生命周期和 native immersive 路径。它把原来的业务 Tab 壳层改成 Rail / Navigator / 主工作面 / Context Host / Tao 的统一壳层，并尝试保留隐藏视图、传输、连接和编辑状态。

分支设计文档还规定了 Home / Connect / Build / Communicate / Utility 的 lane、右侧或底部 Host、Tao Hub、Overview、Quick Switcher、最近面板、跨窗口恢复和统一关闭事务。它的目标是完整解决壳层状态和生命周期，但实现面较大，按钮和状态数量继续增加；阶段性用例中也大量围绕布局恢复、隐藏视图、面板 owner 和窗口事务做适配。这说明它解决的是壳层一致性和恢复能力，不能直接证明首屏入口、信息层级和主要操作已经清晰。

本次新原型不复用该分支的 lane、Rail、Host、Overview 或尺寸方案。分支只提供两类输入：Taomni 已有能力的保护清单，以及“隐藏视图不能丢失连接/草稿/任务”的工程约束。

## 4. 外部参考证据

### 4.1 ZCode：源码为主，截图为辅

源码：`zai-org/ZCode`，commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`。

关键文件：

- `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`：Workspace Shell 把 Sidebar、会话/任务工作面、右侧 side pane、可选 Browser 和底部 Terminal 放在一个可调整布局中；侧栏默认约 264px，宽度持久化，过窄时自动收起部分面板。
- `packages/ui/src/WorkspaceSidebar.tsx`：左侧以任务和工作区为主，支持搜索、分组、时间线、归档、置顶、文件树和 New Task；它把“最近在做什么”作为主要导航，而不是把每一种工具都做成入口。
- `packages/ui/src/WorkspaceHeader.tsx` 与 `WorkspaceHeaderSections/`：顶部聚合工作区标题、项目路径、任务前后导航、刷新/设置/打开文件等上下文动作。
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`：右侧按当前任务承载 Git、Browser、Terminal、代码预览、Agent/Workflow/Artifact 等 tab；tab 可排序、关闭、重开，隐藏时保留实例。

本机桌面截图补充观察：深色窗口顶部保留极少量全局入口，左侧是稳定的上下文/项目列表，中央是长文本执行流，底部是连续输入框，工作状态和终端数量在最底部。它把复杂动作留给当前任务的上下文菜单，避免在全局标题栏常驻几十个图标。

可借鉴：任务优先、工作区绑定、长任务持续可见、右侧上下文面板按需出现、单一搜索/命令中心、保留会话实例。

不直接照搬：ZCode 的 Agent/Browser/Workflow 面板类型很多，Taomni 的连接与数据库场景还需要更直接的“连接 / 文件 / 查询”入口。

参考：<https://github.com/zai-org/ZCode>。

### 4.2 Claude Code Desktop / Claude Code

官方页面明确把 Projects 描述为“把相关 coding sessions 分组，并同时运行和监督多个 Claude agents”；同时强调 terminal、IDE、web、Slack 等多种入口，以及 Artifacts 的实时交互预览。它的交互核心是“一个项目里的多个会话/Agent”，而不是一套固定工具栏。

可借鉴：项目是会话容器；并行 Agent 需要统一的状态列表；危险命令/权限是当前动作的反馈；生成结果应有可预览、可继续编辑的产物面。

参考：<https://www.anthropic.com/claude-code>、<https://claude.com/download>。

### 4.3 ChatGPT Desktop

公开桌面产品的稳定交互模式是全局快捷键唤起一个聚焦的 companion/chat surface，输入框同时承载附件、截图、语音和工具选择；完整窗口再承载历史、项目和结果。这个模式适合 Taomni 的“一次性询问/快速修复”，但不能替代连接、终端或数据库工作面。

可借鉴：快速唤起、明确的 Composer、附件/上下文 chip、流式状态、把 AI 作为当前工作面的协作者而非永久遮挡层。

### 4.4 Kiro Crew

源码 README 和 `src/kiro_crew/agent_panel_templates/` 表明它把 Gateway、Desktop、Web dashboard、CLI 和消息通道视为同一运行时的不同 surface，并将 Sessions、Schedule、Artifacts、Apps、Agent Capabilities、Settings 作为稳定导航。截图中的 Crew board 使用单一左侧导航、顶部全局搜索/通知、中心工作项状态板；Session 菜单包含 Rename、Unread、Pin、Crew board、Pop out、Export 等上下文动作。

可借鉴：长任务和计划有明确状态；工作项、事件、产物和 Agent 能力属于同一个任务上下文；低频操作放上下文菜单；窄屏只保留品牌、搜索、状态和通知。

参考：<https://github.com/kirodotdev/KiroCrew>。

### 4.5 JetBrains Air / IDEA 体验

JetBrains Air 官方页强调“Track parallel work”“Review every change in context”“Flexible AI access”。官方预览图展示了一个紧凑顶部栏、左侧 New Task / Search tasks / filter / task list、中央任务详情和变更统计；任务列表按状态与最近时间组织，变更数量直接显示在任务行。

可借鉴：工作项是主导航单位；搜索、过滤、状态和变更统计放在列表附近；主工作面同时呈现 Agent 输出与代码变更；顶部只保留工作区/分支/状态和少量动作。

参考：<https://www.jetbrains.com/air/>。

## 5. 独立原型方向

原型使用三块语义区域：

1. 工作区上下文：左侧可折叠面板只显示当前模式所需的列表。Home 显示最近工作，Workspaces 显示项目，Sessions 显示连接，Tasks 显示 Agent/工作项；同一位置的搜索和 New 入口不会随业务 Tab 改变。
2. 主工作面：顶部是当前工作项和少量上下文动作，下面是 Terminal / Editor / Query / Mail 等工作面 Tab；AI Composer 固定在主工作面底部，携带当前工作区、文件、会话和权限 chip。
3. 检查器：右侧默认关闭，按需显示 Activity、Files、Changes、Agents；它只服务于当前工作区/任务，关闭后保留状态，不覆盖主工作面。

首屏只保证六类高频操作可见：切换工作区、搜索/命令、New Task/连接、打开当前工作面、查看变更/活动、发起 AI 操作。其它动作通过当前对象的 `…` 菜单和 Command Palette 到达。

原型需要可实际操作以下流程：切换工作区/任务、创建任务、打开连接、在主工作面切换 Terminal/Editor/Query、打开和切换检查器 tab、查看文件/变更、打开命令中心、发送 AI 请求并生成执行记录、切换紧凑密度和主题、在窄屏折叠上下文区。
