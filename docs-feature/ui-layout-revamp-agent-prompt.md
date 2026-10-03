# Taomni UI 布局完善与易用性重构 —— Agent 深度思考与一次性交付全景提示词包 (Master Prompt)

> **使用说明 / Instruction for User**:
> 本文档是为 **Agent + LLM（开启深度思考模式）** 专门构建的**一站式全景提示词包**。它包含了完成 Taomni 整体 UI 布局完善和易用性重构所需的**全部工程背景、技术栈架构、代码组件现状、CSS 主题令牌、全部 21 种会话类型、现存交互痛点、业界顶级桌面软件（VS Code / JetBrains Fleet / Arc / Warp / Safari 等）的优秀实践参考**，以及**明确的交付物契约和详细设计框架**。
> 
> 后续无需任何多次交互，亦无需让该 Agent 再调用工具翻找代码或向用户提问，直接将本文件的完整内容作为提示词输入给目标 Agent，即可让其在一次深度思考（Deep Thinking）中同时产出：
> 1. **详细设计文档**：`docs-feature/ui-layout-and-usability-revamp.md`
> 2. **独立高保真交互式 HTML 演示页面**：`docs-feature/ui-demo/layout-revamp-demo.html`

---

```markdown
# [SYSTEM ROLE & INSTRUCTION: PRINCIPAL DESKTOP UX ARCHITECT & TAOMNI LEAD DESIGNER]

你现在是 Taomni 跨平台桌面客户端的首席 UI/UX 架构师与系统设计师。
请在这一次交互中，利用大模型的**深度思考（Deep Thinking）**能力，**一次性、零返工、无交互**地完成 Taomni 客户端 UI 布局完善与易用性重构的全局设计方案。

你不需要向用户提问，也不需要再次读取代码工程（所有需要的代码架构、组件映射、CSS 变量、业界对标均已在本提示词中完整提供）。你将以专家级的水准，直接创建并交付以下两个高品质成果：
1. **架构与交互设计方案文档**（写入 `docs-feature/ui-layout-and-usability-revamp.md`）
2. **高保真单文件交互式 HTML 原型演示**（写入 `docs-feature/ui-demo/layout-revamp-demo.html`）

---

## 一、 用户核心诉求与设计目标

### 1.1 核心需求清单
1. **Taomni 整体 UI 布局重构**：
   - 深入权衡多 Tab、侧边面板（如 SFTP 侧栏）、Git 面板、Tao 系统（AI 聊天 Chat / 浮动便签 Notes / 统一告警通知 Alerts）、Code Workspace（IDE）、Email（统一邮箱）等的空间布局。
   - 解决当前各面板割裂、部分功能既是 Tab 又是侧栏、Tao 采用悬浮胶囊等不一致交互；探索是将它们归一收纳至统一的侧栏/Tao 中，还是设计为可停靠/可抽屉化/悬浮等多态交互。
   - **大预览卡片与多 Tab 快速切换（Tab Overview / Exposé）**：针对打开大量 Tab 时横向挤压滚动难以识别内容的问题，提供类似大预览卡片网格（可一眼看清当前各会话的主要实时内容、连接状态、主机名/库名），并支持键盘和鼠标极速切换。
   - 综合吸收业界顶尖桌面工具（如 VS Code, Cursor/Windsurf, JetBrains Fleet, Arc Browser, Warp Terminal, macOS Stage Manager/Safari）的优秀交互精髓。
2. **不同类型会话 Tab 的分层与切分摆放（Tab Segmentation & Hierarchy）**：
   - 当前 Taomni 拥有终端、数据库、代码工作区、SFTP、VNC/RDP、邮件等 21 种不同的会话类型，过去全部扁平混排在同一个水平 Tab 栏中，仅靠右侧 `...` 菜单简单过滤。
   - 需设计合理的会话类型分组（Workspaces / Spaces / 分类 Group / Pin 置顶 / 垂直与水平混合等），让瞬态的 Shell 与持久的工程/数据库/邮件各得其所。
3. **窗口标题栏（TitleBar / ControlBar）按钮与控件的清晰化重构**：
   - 彻底治理当前标题栏拥挤塞满 10 余个按钮（汉堡菜单、拖拽手柄、Tab 列表、Tab 详情、Tab 更多 `...`、分屏、多路广播、截图、PTT 语音、语言切换、主题切换、最小化/最大化/关闭）的视觉混乱与误触问题。
   - 划分清晰的功能分区（如导航区、全局命令搜索中心、视图/协作控制区、原生窗口控制区），建立清晰的视线层级。
4. **Welcome（欢迎页/工作台）的高效定位与导航**：
   - 解决 Welcome 页在打开多 Tab 后被挤到最左侧边缘甚至被忽略、难以重新返回或快速唤起的痛点；使其升格为始终触手可及的“全局中枢 / 罗盘中心”。
5. **核心准则**：清晰、简洁、优雅、符合现代人体工学，极致易用。
6. **约束**：无需拆分任务；不参考其它分支的半成品；由你独立全局设计；在设计方案中明确列出需要与用户决策确认的权衡讨论点（Open Questions / Trade-offs）。

---

## 二、 Taomni 现有工程全景、技术栈与代码实现画像

为了让你在设计时具有 100% 的工程可行性，以下是当前工程代码的完整技术全景与架构细节：

### 2.1 技术栈画像
- **桌面框架**：Tauri 2.11+ (基于 Rust 2024 edition 后端 + Web 现代 WebView：Windows 使用 WebView2，macOS 使用 WKWebView，Linux 使用 WebKitGTK)。
- **前端核心**：React 19.3 + TypeScript 6.0 + Vite 8。
- **样式与设计系统**：Tailwind CSS v4 + 独立 CSS 全局变量设计系统（`src/index.css`），支持 Light（亮色）与 Dark（暗色）双主题即时切换。
- **图标库**：`lucide-react` (1.45+)。
- **状态管理**：Zustand v5 (拆分为 `appStore`, `sessionStore`, `chatStore`, `notesStore`, `taoHubStore`, `taoAlertStore`, `toolWindowStripeStore`, `sftpStore`, `codeWorkspaceStore` 等)。
- **面板布局库**：`react-resizable-panels` v4.12+ (用于主侧栏、代码编辑区工具窗口的拖拽缩放与折叠)。
- **核心功能引擎**：
  - 终端：`@xterm/xterm` 6.0 + WebGL addon + Fit addon + Zmodem 文件传输。
  - 编辑器：CodeMirror 6 (带 LSP 补全、语法高亮、结构化搜索、Git Diff 视图)。
  - 远程桌面：原生集成 RFB (VNC) 与 RDP 客户端。
  - 协作白板与截图：Konva / `react-konva`。

### 2.2 核心 CSS 主题变量字典（设计与 HTML 原型必须严格继承）
Taomni 拥有一套完整的基于 CSS 变量的 Design Tokens，定义在 `src/index.css`：

| 语义 Token | Light 模式值 | Dark 模式值 | 用途说明 |
|---|---|---|---|
| `--taomni-bg` | `#f8fafc` | `#1e1f22` | 主画布/主内容区底色 |
| `--taomni-chrome-bg` | `#f1f5f9` | `#191a1c` | 标题栏、控制栏、状态栏等系统底色 |
| `--taomni-chrome-border`| `#cbd5e1` | `#303238` | 系统级外边框颜色 |
| `--taomni-sidebar-bg` | `#f8fafc` | `#1e1f22` | 左侧抽屉与侧边栏底色 |
| `--taomni-tab-active` | `#ffffff` | `#1e1f22` | 当前激活 Tab 底色 |
| `--taomni-tab-inactive`| `#e2e8f0` | `#26282e` | 非激活 Tab 底色 |
| `--taomni-tab-border` | `#cbd5e1` | `#35383f` | Tab 边框与分割线 |
| `--taomni-accent` | `#1e40af` (Royal Indigo) | `#6aa6f8` (Soft Sky Blue) | 主品牌高亮强调色 |
| `--taomni-accent-soft`| `#3b82f6` | `#8bbcff` | 次级强调色 |
| `--taomni-text` | `#0f172a` | `#e6eaf0` | 主文字颜色 |
| `--taomni-text-muted` | `#64748b` | `#9ca3ad` | 次级/注释/辅助文字色 |
| `--taomni-divider` | `#e2e8f0` | `#303238` | 模块分割线 |
| `--taomni-hover` | `#f1f5f9` | `#282a30` | 鼠标悬浮背景 |
| `--taomni-selected` | `#dbeafe` | `#293b55` | 列表/项目选中背景 |
| `--taomni-card-bg` | `#ffffff` | `#26282e` | 卡片背景色 |
| `--taomni-card-border`| `#e2e8f0` | `#35383f` | 卡片边框色 |
| `--taomni-tao-ribbon-bg`| `#dff7f3` | `#1e3835` | Tao 缎带/胶囊背景色 |
| `--taomni-tao-ribbon-text`| `#0f5f63` | `#5eead4` | Tao 缎带文本色 |
| `--taomni-tao-ribbon-border`| `#8bd8d1` | `#115e59` | Tao 缎带边框 |
| `--taomni-term-bg` | `#0f172a` | `#1e1f22` | 终端黑色背景 |
| `--taomni-term-text` | `#f8fafc` | `#e6eaf0` | 终端文字色 |
| `--taomni-ui-font-family`| `"Inter", -apple-system, sans-serif` | 全局 UI 字体 |
| `--taomni-code-font-family`| `"JetBrains Mono", Consolas, monospace` | 终端与代码字体 |

### 2.3 完整的 21 种会话类型（TabKind）与功能矩阵
在 `src/types/index.ts` 中定义的 `TabKind` 包括：
1. **运维与远程连接类**：
   - `"terminal"`：SSH 远端终端、本地 Shell（PowerShell/CMD/Bash）、WSL 子系统终端、一次性命令终端。具有当前工作目录（cwd）实时探测、多分屏、广播输入等能力。
   - `"sftp"`：独立全功能 SFTP 远程文件管理器（双栏、拖拽上传、传输队列）。
   - `"rdp"`：Windows 远程桌面会话，具备剪贴板同步、分辨率自适应。
   - `"vnc"`：跨平台 VNC 图形桌面会话，具备鼠标指针锁定与按键映射。
   - `"file-browser"`：本地文件浏览器（类似 Finder / Explorer 的内嵌视图）。
2. **数据资产与数据库类**：
   - `"database"`：多引擎通用 SQL 查询与对象管理器（支持 MySQL, PostgreSQL, Oracle, SQL Server, StarRocks, ClickHouse, Presto 等），含查询 Tab、结果集表格、DDL 生成。
   - `"redis"`：Redis 键值数据库视图（键浏览、数据类型编辑器、命令行 CLI）。
   - `"hbase-shell"`：大数据 HBase Shell 交互会话。
   - `"object-storage"`：云原生对象存储浏览器（AWS S3, Azure Blob 存储桶与对象管理）。
3. **软件工程与代码类**：
   - `"code-workspace"`：完整的轻量 IDE 工作区（CodeMirror 6 + LSP 语言服务 + 文件树 + 符号导航 + 结构化搜索 + 底部工具窗口）。
   - `"git"`：独立 Git 仓库管理界面 / 工作区多仓库管理器（Log 树、Diff 比较、分支切换、Commit 提交）。
4. **协同通信与办公类**：
   - `"mail"`：单个邮箱账户客户端。
   - `"mail-unified"`：多账户聚合统一邮箱（收件箱、发信箱、多身份切换）。
   - `"lan-chat"`：局域网免服务器 P2P 协作通信（mDNS 设备发现、文字聊天、音视频通话 CallOverlay、交互式协作白板 WhiteboardOverlay）。
5. **网络与安全工具类**：
   - `"nettools"`：网络工具集（SSH 隧道管理器 TunnelManager、端口转发）。
   - `"sockscap"`：流量代理与 Socks5 规则管理器。
   - `"mfa"`：TOTP/HOTP 动态双因素认证口令管理（支持二维码扫描导入、倒计时刷新）。
   - `"proxy-test"`：代理节点延迟与连通性测试。
6. **系统与基础视图**：
   - `"welcome"`：工作台首页（快速启动本地 Shell/WSL、新建会话、最近访问历史、上次会话一键恢复 Restore）。
   - `"settings"`：应用全局设置（外观、终端配置、快捷键、网络、AI 模型等）。
   - `"placeholder"`：会话加载占位态。

### 2.4 当前 UI 组件架构与各部件代码现状（`src/layouts/MainLayout.tsx` 等）
1. **标题栏 / 控制栏 (`src/components/tabbar/ControlBar.tsx`)**：
   - 现处于窗口最顶部（32px 高度），Windows/Linux 下集成了汉堡菜单（`BarButton`）和窗口拖拽区域。
   - 中间放置 `TabBar`（水平滚动条，内部有本地终端快捷加号 `+`，下拉菜单，搜索过滤 Chip）。
   - 紧随其后是 `tabActionSlot`（不同活跃 Tab 动态插入的动作，例如 SSH 终端会在此插入“打开附加 SFTP 侧栏”按钮和“Chat”按钮）。
   - 接着是 Tab 详情信息按钮（`PanelsTopLeft + Info`，快捷键 Ctrl+Shift+H）、Tab 溢出菜单（`TabMore` `...` 弹出 `OpenTabsMenu`）。
   - 分割线后是屏幕截图按钮（`ScreenshotMenuButton`）。
   - 托盘控制组（`TitleBarTrayControls.tsx`）：分屏切换开关、多端输入广播开关（MultiExec）、PTT 语音按键、多语言切换器、明暗主题循环切换。
   - 最右侧是标准窗口按键（`WindowControls.tsx`）：最小化、最大化、关闭（Mac 下左侧预留 76px 给原生红黄绿交通灯）。
2. **左侧侧边栏与工具条 (`src/components/sidebar/Sidebar.tsx` & `ToolWindowRail.tsx`)**：
   - 基于 `react-resizable-panels` 的可折叠侧栏。
   - 最左侧为纯图标窄条（Rail），常驻两项：“Sessions”（树形会话列表）与“Tools”（集成 Servers, Tunneling, SocksCap, Git, Code Workspace, Mail, LanChat, MFA, Network Tools 的图标列表）。
   - 底部常驻 Settings 按钮。
   - 展开状态为会话树（带搜索框、新建、编辑、复制、删除、收藏等按钮）。
   - 当激活 Code Workspace 时，侧栏 Rail 会与 IDEA 风格的 ToolWindowRail 融合。
3. **主工作画布区域 (`MainLayout.tsx`)**：
   - 支持多终端分屏网格（Horizontal, Vertical, Grid 布局，支持独立拖拽调整行宽列宽及输入锁定）。
   - 支持 MultiExec 广播通知条（`MultiExecBar`）。
   - 拥有多会话保持挂载（Keep-Alive）机制：后台 Tab（如 SFTP 传输中、数据库长查询执行中、VNC/RDP 画面、代码未保存等）在 DOM 中以 `display: none` 维持生命周期，切换激活 Tab 时瞬间响应。
   - SSH 终端具有内嵌式的附着 SFTP 侧栏（`SftpSidebar`，右侧滑出，带与终端同目录联动能力）。
4. **Tao 系统架构 (`src/components/chat/ChatDrawer.tsx` & `src/components/tao/TaoRibbon.tsx`)**：
   - **Tao Ribbon**：当前为一个吸附在窗口 4 条边之一（支持按比例拖动边缘停靠）的悬浮药丸/胶囊组件，带动态未读红点（整合了 AI 对话完成、Notes 便签待办/到期提醒、Mail 新邮件等告警通知）。
   - **ChatDrawer**：点击 Ribbon 或终端侧 Chat 按钮后滑出的抽屉，内部集成了 TaoHub（AI Chat 对话、Tao Notes 便签笔记、Alerts 告警中心）。
   - **FloatingNotesPanel**：独立的浮动小黄条便签，用户可以从 Tao 中脱离便签浮在屏幕上。
5. **Welcome 面板 (`src/components/WelcomePanel.tsx`)**：
   - 顶部标语与版本号。
   - 快捷启动卡片网格：本地终端（带 Shell 下拉切换及管理员权限选项）、WSL 卡片、新建会话卡片、LAN Chat 卡片、邮件快捷卡片。
   - 上次会话一键恢复行（RestoreLastSessionRow）。
   - 历史记录选项卡面板：最近本地目录（Directories）、最近代码工作区（Workspaces）、最近连接会话（Sessions，支持多选、排序、筛选、批量打开）。

---

## 三、 现存核心痛点与深层架构矛盾剖析

在设计新方案前，必须深刻理解现有界面的五大设计硬伤：

### 痛点 1：标题栏“超载与臃肿”（TitleBar Overcrowding）
- 在仅仅 32px 高度的顶栏上，挤压了 **12 个以上的独立功能按钮**和一整条水平 Tab 栏！
- 标题栏既要充当“原生窗口拖拽手柄”，又要承载“多 Tab 滚动切换”，还要充当“快捷工具栏”和“托盘指示器”。当用户打开 8 个以上 Tab 时，Tab 栏被严重压缩，两端频繁出现左右滚动箭头，标题栏拖拽区域几乎消失，极易误触。

### 痛点 2：会话类型“扁平混排与认知超载”（Tab Flattening & Cognitive Friction）
- 21 种性质截然不同的任务全部挤在一个 Tab 容器中：
  - 一个只需要临时执行 10 秒 `ping` 命令的临时本地终端；
  - 一个运行着重要核心生产集群、不能随意关闭的生产 SSH 终端；
  - 一个加载着大型工程、包含数百个文件树的代码工作区（Code Workspace）；
  - 一个长驻的统一邮件客户端（Mail Unified）；
  - 一个图形化的 RDP 远程 Windows 服务器。
- 它们在当前 Tab 栏上具有一模一样的外观卡片与权重。当 Tab 数量达到 10~20 个时，用户很难一眼分辨出哪个是工作区、哪个是后台服务、哪个是临时终端，寻找目标 Tab 极度费时。

### 痛点 3：边栏、面板与抽屉的“割裂与多头管理”（Spatial Fragmentation）
- **SFTP**：既可以作为附着在 SSH 终端右侧的滑动侧栏（`SftpSidebar`），又可以作为独立的完整 Tab（`FileBrowser`），两者的关系没有在导航中理顺。
- **Tools 菜单与 Sidebar**：左侧侧栏里有一个 Tools 面板，顶部汉堡菜单里又有一个 Tools 菜单，底部快捷键里又有工具映射，入口重叠。
- **Tao 的漂浮形态困境**：TaoRibbon 作为一个悬浮在窗口边缘的可拖拽胶囊，常常遮挡终端最右侧的滚动条或分屏分割线；其弹出方式（Drawer / Floating / Inline）在狭小屏幕下会挤占主工作区空间。
- **Notes 便签**：既嵌入在 Tao Hub 中，又支持独立 Floating，与主界面的关联性割裂。

### 痛点 4：缺乏高效的大视觉概览（Lack of Visual Bird's-Eye Overview）
- 当前定位某个 Tab 只能通过：1) 点击左右箭头水平滚动；2) 点开 `...` 菜单查看纯文本下拉列表（带搜索框）；3) 按快捷键 Ctrl+Shift+H 打开悬浮详情条。
- 用户无法像在 Safari、macOS Exposé 或 Windows 虚拟桌面那样，获得**一个全屏/模态的大卡片视觉概览（Tab Overview Grid）**：直观看到“终端输出了什么”、“数据库执行到了第几条”、“代码开在哪个文件”，无法实现有视觉记忆的秒速切换。

### 痛点 5：Welcome 首页的“迷失”（Welcome Loss）
- Welcome 页面目前被实现为 index 0 的普通 Tab。当打开若干个会话后，Welcome Tab 被挤到看不见的左侧边缘。当用户想快速找一个近期项目或快速打开一个新连接时，不得不关闭或者一路左滑去找 Welcome，导致这个高频中枢的价值大打折扣。

---

## 四、 业界顶级桌面应用的优秀模式借鉴与对标

请在你的设计中深度吸收并融合以下业界顶级产品的精髓：

1. **VS Code / Cursor / Windsurf 架构**：
   - **Command Center（中央命令胶囊）**：将传统软件死板的标题栏正中央，改造为类似 `Ctrl+K` / `Ctrl+P` 的全局快速跳转与命令胶囊，既是面包屑展示，也是全局搜索入口，大幅释放两翼空间。
   - **Activity Bar（主活动栏）+ Secondary Side Bar（副活动栏）**：左侧放置核心业务树（会话树、工作区、环境）；右侧放置 Copilot / AI Chat / 检查器。左右分工明确，主次分明。
2. **Arc Browser & SigmaOS 创新交互**：
   - **Spaces & Workspaces（空间隔离）**：支持将繁杂的 Tab 划分为不同空间（例如：“生产运维集群”、“电商项目研发”、“数据库维护”、“日常办公与邮件”），瞬间将 20 个 Tab 降维到每个空间 4~5 个。
   - **Pinned vs. Today Tabs（置顶常驻与临时会话分离）**：重要持久的会话（邮件、代码库、跳板机）以精简图标/胶囊常驻在顶部；临时执行命令的 Shell 作为普通条目。
   - **Visual Tab Switcher**：类似 `Ctrl+Tab` 的卡片式快速切换器。
3. **JetBrains Fleet & New UI 现代美学**：
   - **极简顶栏**：标题栏极其干净，左侧项目与分支，中间运行/搜索，右侧仅保留布局控制与窗口控件。
   - **Tool Window Stripes（智能工具栏停靠）**：周边工具栏（Database, Git, Terminal, Problems）统一停靠在侧栏条上，点击原地平滑展开抽屉，不干扰主内容区。
4. **Warp Terminal 终端现代化设计**：
   - 将 AI 深度嵌入终端上下文，但通过快捷键随叫随到，不采用破坏主界面平衡的随意漂浮小气泡。
5. **Safari Tab Overview / macOS Mission Control 视觉网格**：
   - 双指捏合或按快捷键唤出鸟瞰网格（Overview Grid），所有 Tab 缩放为缩略卡片，卡片头部带有类型 Icon 与徽标，支持实时模糊搜索过滤，点击秒切。

---

## 五、 重点重构方案建议方向与设计任务分解

请在你的设计文档与 HTML 演示中，重点实现并深化以下五大创新方案：

### 5.1 整体空间布局重构：“人体工学三栏 + 统一命令顶栏”
- **顶部顶栏（Modern TitleBar / ControlBar）升级**：
  - **Zone 1（左侧·品牌与工作区罗盘）**：App Logo / 全局菜单 + 当前工作区/环境选择器（Workspace Breadcrumb，支持切换不同业务场景）。
  - **Zone 2（中央·Command Center 全局中枢）**：集成全局搜索、会话快速连接（QuickConnect）与 Tab 切换的胶囊输入框（支持点击或 `Ctrl+K` 弹出），彻底取代原本散落在各处的独立搜索栏。
  - **Zone 3（右侧·全局视图与协作控制）**：精简为最关键的 3~4 个功能组：
    1. **Tab Overview 大预览网格入口**（图标形如 4 个小方块卡片 `Grid2x2` 或画廊视图，快捷键 `Ctrl+Shift+A`）；
    2. **分屏与广播组合按钮**（带下拉菜单，可选横向、纵向、网格、多路广播）；
    3. **Tao Hub 呼出按钮**（带未读通知聚合气泡）；
    4. **系统外观/更多设置**。
  - **Zone 4（最右·原生控制）**：纯净的窗口最小化、最大化、关闭（macOS 下保留左侧 76px 交通灯留白）。
- **左侧主导航栏（Primary Activity Rail）**：
  - 整合现有的 Sessions 树与 Tools。提供简洁的图标条：
    - `Home`（一键随时直达 Welcome 罗盘中心）；
    - `Sessions`（连接会话树与资产目录）；
    - `Workspaces`（代码工程与 Git 仓库）；
    - `Tools`（网络隧道、SocksCap、MFA 认证器、系统监控）；
    - 底部 `Settings`。
  - 点击图标展开二级面板（支持固定 Pin 或自动收起）。
- **右侧停靠面板（Tao Hub Integrated Dock）**：
  - **取消四处漂浮遮挡内容的 TaoRibbon 胶囊！**
  - 将 Tao（AI 智能体 / 便签 Notes / 告警 Alerts）重构为**优雅的右侧停靠抽屉（Secondary Side Bar）**。平时以 0 宽度折叠，点击顶栏 Tao 图标或按快捷键 `Ctrl+J` / `Cmd+J` 平滑滑出（360px 宽度）；在需要深度对话时支持一键浮动（Pop-out）或扩展全高。
  - 侧栏边缘提供极细的未读状态指示呼吸光效或小微徽标，既不遮挡主屏终端，又能及时感知 AI 回复完成或待办事项到期。
- **附着 SFTP 与主编辑器的协作**：
  - 终端下的 SFTP 既可以在主 Tab 中全屏独立打开，也可以作为当前终端标签内的“内嵌上下文抽屉”一键展开，形成“左终端 + 右远程目录”的经典生产力同屏，不再产生认知分裂。

### 5.2 多 Tab 大预览卡片网格系统（Tab Overview & Grid Preview）
- **触发机制**：点击顶栏 Overview 按钮，或按下全局快捷键（如 `Ctrl+Shift+A`、`Ctrl+Tab` 长按、或触控板缩放手势）。
- **界面与交互**：
  - 全屏弹出带有毛玻璃背景的卡片画廊 / 仪表板视图（Overview Dashboard）。
  - **顶部**：极速模糊搜索框，即输即过滤（支持按名称、IP、端口、标签、类型过滤）。
  - **分类过滤 Tabs**：全部（All）、终端（Terminal）、数据库（Database）、代码（Code）、通信与工具（Comms & Tools）。
  - **卡片网格（Preview Cards）**：
    - 采用自适应网格，每张卡片代表一个正在运行的 Tab。
    - **卡片 Header**：会话类型彩色徽标（SSH 为绿、Local 为蓝、MySQL 为湖蓝、Redis 为红等）、会话名称、服务器 IP / 本地路径、关闭按钮 `×`。
    - **卡片 Body（真实内容缩略）**：
      - *终端卡片*：展示最新的 5-8 行终端输出快照，右下角带有实时在线绿色脉冲点或空闲时长。
      - *数据库卡片*：展示当前正在打开的数据表名、活跃 SQL 查询片段以及行数状态。
      - *代码工作区卡片*：展示活跃代码文件名称、语言标签、代码行数预览。
      - *邮件/聊天卡片*：展示最新未读消息发件人与摘要。
    - **卡片 Footer**：快捷操作（一键分屏、在侧边打开 SFTP、独立窗口 Detach 弹出）。
  - 支持键盘上下左右箭头巡检高亮，回车直接瞬移切换至该会话；按 `Esc` 退出网格。

### 5.3 会话 Tab 的科学分层与多形态组织（Tab Organization & Workspaces）
- **Tab 分组（Spaces / Workspaces）机制**：
  - 允许用户为 Tab 创建逻辑分组（例如：`Prod-Cluster-A`，`Local-Dev`，`Data-Analytics`）。
  - 在横向 Tab 栏中提供折叠式 Group 标签头，或在左侧导航栏以垂直树状组织。
- **Pinned Tabs（置顶小徽标）**：
  - 支持将长期不关的基础设施 Tab（如常驻跳板机、统一邮箱、主项目 IDE）右键选择“Pin to Strip”。
  - 置顶后的 Tab 缩小为只有带状态亮点的图标方形，排在最左侧，绝不随其它临时 Tab 滚动被挤出视野。
- **色彩编码与类型视觉区分**：
  - 统一并增强 Tab 的视觉指示系统（终端绿色、数据库湖蓝色、代码 IDE 紫色、通信橙色），使用户凭借边缘色条或前缀图标一目了然。

### 5.4 Welcome 工作台的全新定位（Mission Control Dashboard）
- **常驻入口**：左侧 Activity Rail 最顶部设立永久性的 `Home` 房型图标（高亮显示，快捷键 `Ctrl+1` 或 `Cmd+1`），不论打开了多少个 Tab，随时一键回到工作台。
- **现代化中枢布局**：
  - **Hero 快捷连接栏**：提供类似 Spotlight / Raycast 的极简命令行输入：“输入 `user@host:port` 或直接选择本地 Shell”，回车立即开跑。
  - **工作区与集群看板（Environments / Clusters）**：以卡片形式展示保存的会话组和代码仓库。
  - **上次状态一键恢复（Session Resume）**：清晰显示“上次退出了 4 个终端与 1 个代码工作区”，提供大按钮“一键完全恢复所有会话”。
  - **Recent 时间轴**：按时间先后聚合展示最近打开的本地目录、数据库连接、远程服务器，支持单选与批量启动。

---

## 六、 交付物产出规格与要求（严格执行）

请在你的深度思考中，一次性生成并写入以下两个完整文件：

### 交付物 1：详细设计方案文档
- **路径**：`docs-feature/ui-layout-and-usability-revamp.md`
- **语言**：中文（技术术语保留中英对照）
- **必须包含的核心章节**：
  1. **方案概述与设计哲学**（架构目标、设计原则、对标对比分析）。
  2. **信息架构与空间布局模型**（给出整体布局图示，包含 ASCII 架构图与 Mermaid 流程图；详述顶栏、左侧 Activity Rail、中心工作区、右侧 Tao Hub Dock 的几何尺寸与响应式断点）。
  3. **标题栏（ControlBar）深度重构规范**：Zone 1~4 的按键布局、语义划分、macOS 原生交通灯兼容、拖拽安全区设计。
  4. **大预览卡片网格系统（Tab Overview Grid）详细设计**：触发交互、网格排布、卡片预览渲染机制（Terminal/DB/IDE/Mail 缩略图生成方案）、键盘无障碍控制流。
  5. **多类型会话分层与工作区（Tab Segmentation & Spaces）机制**：分组逻辑、Pin 置顶模式、色彩标识规范、21 种 TabKind 的分类收敛规则。
  6. **Tao 系统停靠整合规范**：从 Floating Ribbon 向 Secondary Sidebar 的过渡、Notes 便签与 Alerts 告警的收纳策略、呼吸微指示设计。
  7. **Welcome 全局罗盘设计**：空间定位方式、快捷启动流、上次会话恢复流。
  8. **代码迁移与工程重构建议**：针对当前 `MainLayout.tsx`、`ControlBar.tsx`、`TabBar.tsx`、`Sidebar.tsx`、`ChatDrawer.tsx` 的组件拆分与状态重组方案（保持与当前 Zustand store 的无缝对接）。
  9. **待与用户探讨的决策权衡点（Trade-offs & Open Questions）**：提炼 3~5 个关键产品设计取舍（例如：横向 Tab 栏与垂直 Tab 树的偏好模式、Tao Hub 默认收起还是常驻、Tab Overview 的后台渲染性能平衡等）。

### 交付物 2：高保真交互式单文件 HTML 演示页面
- **路径**：`docs-feature/ui-demo/layout-revamp-demo.html`
- **技术规范**：
  - 单文件、零外部重度 npm 依赖（可引入 CDN 字体如 Inter、JetBrains Mono，或纯 CSS 图标/内嵌 SVG）。
  - 内置完整的 CSS 样式表，严格使用 Taomni 的色彩规范（支持右上角一键切换 Light / Dark 主题）。
  - 纯原生现代 JavaScript（ES6+），包含真实、流畅的界面交互体验。
- **演示原型必须可交互展示的核心功能**：
  1. **重构后的四分区标题栏（TitleBar）**：包含左侧工作区下拉菜单、中央 Command Center 胶囊输入框、右侧 Tab Overview 按钮、分屏切换、Tao Hub 按钮、明暗主题切换。
  2. **左侧 Activity Rail 导航条**：点击可展开/收起 Sessions 树、Tools 工具面板，并展示永久常驻的 Home 图标。
  3. **主工作区多 Tab 切换**：展示多个不同类型的 Tab（带有颜色前缀和图标：SSH 终端、Local PowerShell、MySQL 数据库、Code Workspace、Mail 邮箱），支持点击切换激活状态、支持关闭 Tab、支持点击 `+` 新建。
  4. **【核心亮点】Tab Overview 大预览卡片网格交互**：
     - 点击顶栏上的画廊图标或按快捷键唤出 Overview 模态层。
     - 模态层展示美观的卡片网格：每张卡片具有逼真的终端黑屏输出片段、数据库表格片段、代码编辑器高亮片段等。
     - 支持在 Overview 顶部的搜索框中实时打字过滤卡片。
     - 点击任意卡片，平滑关闭 Overview 并直接激活选中的 Tab。
  5. **右侧一体化 Tao Hub 抽屉**：
     - 点击顶栏 Tao 按钮，右侧顺滑滑出 360px 宽度的 Tao Hub 抽屉面板。
     - 抽屉内部包含选项卡：AI Chat（聊天对话卡片）、Tao Notes（便签列表与富文本条目）、Alerts（未读通知列表）。
     - 支持关闭或收起抽屉。
  6. **现代化 Welcome 页面展示**：
     - 当激活 Home Tab 时，主区域呈现重新设计的 Mission Control 工作台：快捷连接栏、环境集群卡片、历史恢复条、最近访问时间轴。

---

现在，请开始你的深度思考，并在思考后立即一次性创建并写入上述两份完整、详尽、高质量的文件！
```
