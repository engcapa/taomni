# Code Workspace 项目树与编辑器分割线拖动失效修复设计

## 1. 设计摘要与范围

- 问题类型：功能缺陷 / 交互阻断
- 文档位置：`docs-issue/code-workspace-project-tree-editor-splitter-drag-design.md`
- 设计状态：可实施
- 来源：用户问题反馈（Code Workspace 中 Project Tree 与 Editor 之间的分割线无法拖动）
- 调研基线：Git 工作区当前提交、`package.json` 版本 `0.4.25`；2026-09-16
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码保持三端兼容；浏览器模式辅助开发测试。
- 本轮真机执行端：Windows 11 x64（当前运行环境）；保留 macOS、Linux 验证计划与接续说明。
- 推荐方案：解除拖拽过程中的 React 渲染死循环与 `react-resizable-panels` 面板注销重构，将 `projectWidthPx` 的持久化时机从每次鼠标微小移动（`onResize`）推迟到拖拽释放时（`PanelGroup` 的 `onLayoutChanged`）；固定 `Panel id="project"` 的初始 `defaultSize` 避免动态重传触发库内部 unregister；补齐 `PanelResizeHandle` 的显式 `id` 与扩展热区伪元素（6px 命中区 + active 高亮），彻底恢复顺畅拖拽与尺寸记忆。

在当前 Taomni 的 Code Workspace 中，用户尝试按住项目树与代码编辑器之间的竖直分割线左右拖动时，分割线无法移动或在位移 0~1 像素后立即冻结锁死。本次修复针对这一阻断性交互缺陷，恢复自由拖拽调整项目树与编辑器宽度的能力、拖拽释放后的持久化保存以及折叠/展开恢复逻辑；不重构其他无关面板的布局系统，不更改既有的项目树内部功能与快捷键。

## 2. 当前实现与问题依据

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/editor/CodeWorkspaceTab.tsx:11891` `handleProjectPanelResize` | 在每次 `onResize(size)` 回调（每个像素位移）中，如果 `pixels > 40` 则立即调用 `setShellChromeState(workspaceInstanceId, { projectWidthPx: pixels })` | 必须移除非折叠状态下的即时 store 写入，仅保留 `lastProjectPanelSizeRef.current` 更新与折叠状态变更判定 | 源码事实与单测已验证；每次位移写入 store 导致根组件全量重渲染 |
| `src/components/editor/CodeWorkspaceTab.tsx:19635` `<Panel id="project">` | 将 store 中的 `workspaceUi.shellChromeState?.projectWidthPx` 动态作为 `defaultSize={`${...}px`}` 传入 | 必须改为挂载初始值（例如 ref 或 memo 初始化），禁止动态响应每个像素的 defaultSize 变更 | 源码事实；`react-resizable-panels` 的 `Panel.tsx` 在 `defaultSize` 变化时触发 effect cleanup 注销面板 |
| `src/components/editor/CodeWorkspaceTab.tsx:19627` `<PanelGroup id={`code-workspace-${workspaceInstanceId}`}>` | 缺少 `onLayoutChanged` 处理函数，未在拖拽结束（pointerup）时保存最终宽度 | 必须新增 `onLayoutChanged`，在 pointer 释放时统一调用 `setShellChromeState` 持久化最终宽度 | 源码事实与官方库 API 规范；`onLayoutChanged` 专为拖拽后存储设计 |
| `src/components/editor/CodeWorkspaceTab.tsx:19693` `<PanelResizeHandle>` | 缺少显式 `id` 属性；样式仅为 `w-[3px]`，无 hover/active 命中扩展伪元素，无 `disabled={!languagePanelOpen}` | 补齐 `id="code-workspace-project-resize-handle"`、`disabled={!languagePanelOpen}` 及 `relative after:...` 6px 热区与 `active:bg` 高亮 | 源码事实与 real `react-resizable-panels` 实测证明（无 id 时 `data-testid` 被库覆盖） |
| `src/components/editor/workspace/FileTreePane.tsx:209` `<aside ...>` | 自带 `border-r border-[var(--taomni-code-border)]` | 与 3px 分割线颜色相同且紧密相邻，形成 4px 视觉厚度，点击其 1px 边框会落到 tree-pane 而非 handle | 源码事实与视觉布局分析 |
| `src/test/setup.ts:59-74` `Separator` mock | Vitest 单元测试中全局 mock 了 `react-resizable-panels` 为纯 DOM `div`，未运行真实库事件逻辑 | 导致历史 Vitest 用例无法检出真实库中的 drag destroy 缺陷；新测试需 `vi.unmock` | 测试基础设施事实 |

### 复现与根因

#### 1. 预期与实际行为
- **预期行为**：用户将鼠标移动到项目树与编辑器之间的竖直分割线时，光标显示为 `col-resize`，分割线显示 accent 悬停高亮；按住鼠标左键左右拖动，项目树宽度实时平滑改变，编辑器宽度联动反向收缩/扩张；松开鼠标后，项目树保持当前宽度，并在页面切换或应用重启后保持该尺寸。
- **实际行为**：光标移动到分割线上极难抓取（仅 3px 物理宽度，且受邻近 border 影响）；点击并按住左键拖动时，项目树完全不动或移动不足 1 像素即锁死，控制台报错或内部静默中止，无法完成任何拖动调宽。

#### 2. 确凿因果链（Causal Chain）
```text
用户鼠标按下分割线 (pointerdown)
  │
  ├─► react-resizable-panels 全局捕获监听器建立 active drag 会话
  │   在 dragState 中保存当前的 group 引用、hitRegions、panels [project, editor] 及 initialLayoutMap
  │
用户开始移动鼠标 (pointermove)
  │
  ├─► 库计算 delta，更新 DOM style (flexGrow)
  │
  ├─► 浏览器 ResizeObserver 监听到 Panel id="project" 元素宽度改变
  │
  ├─► Panel 触发 onResize 回调 -> 调用 handleProjectPanelResize(size)
  │
  ├─► handleProjectPanelResize 立即执行:
  │   setShellChromeState(workspaceInstanceId, { projectWidthPx: pixels })
  │
  ├─► Zustand codeWorkspaceStore 创建新的 byInstanceId[instanceId] 对象
  │
  ├─► CodeWorkspaceTab 订阅了 workspaceUi，立即触发 React 同步重新渲染
  │
  ├─► 重新渲染中，<Panel id="project"> 接收到新的 defaultSize={`${newPixels}px`}
  │
  ├─► react-resizable-panels 的 Panel 组件 useLayoutEffect 依赖项包含 defaultSize
  │   React 执行旧 effect 的 cleanup: 调用 registerPanel 返回的注销函数
  │   Group.panels 中的该 panel 被移除，Group 触发强制重新渲染
  │
  ├─► Group 的 useLayoutEffect 重新执行 mountGroup()，在全局 mountedGroups 映射中
  │   清除了旧 Group 实例并注册了新的 Group 实例
  │
用户继续移动鼠标 (pointermove)
  │
  ├─► 库的 handlePointerMove 执行:
  │   尝试通过 pointerdown 时捕获的旧 Group 引用从 mountedGroups 获取 groupData
  │
  ├─► 因为旧 Group 实例已被卸载替换，mountedGroups.get(oldGroup) 返回 undefined!
  │
  └─► 库内部命中 if (!initialLayout || !groupData) return;
      后续所有鼠标移动事件被彻底静默丢弃！若重算 pivotIndices 则抛出 index -1 异常！
      结果：分割线瞬间冻结锁死，无法拖动！
```

#### 3. 根因状态
**已在真实依赖环境中 100% 验证证明**。通过 unmock `react-resizable-panels` 并在测试中模拟 pointerdown 后的连续两次 pointermove，精确定位到第一次 move 触发 store 更新并改变 `defaultSize` 后，第二次 move 的 Group 状态立即丢失，计算 layout 锁死停滞（见验证设计及基线日志）。

#### 4. 回归要求
- 改前：在真实 `react-resizable-panels` 容器下，用户发起 pointerdown 并连续两次 dispatch pointermove（例如 x 从 452 -> 480 -> 520），第二次 move 无法生效（layout 冻结在 480，后续不再响应）。
- 改后：用户发起 pointerdown 并连续多次 dispatch pointermove，panel 尺寸实时连续跟随，无任何异常；只有在 pointerup 触发后才写入一次 store 进行持久化。

## 3. 修复验收与保持的行为

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | Code Workspace 打开项目树与编辑器 | 鼠标悬停在两者之间的分割线上 | 鼠标指针显示为 `col-resize`，分割线显式高亮 `var(--taomni-accent)`；有效悬停命中宽度达到 6px 以上，边缘无闪烁 | Windows、macOS、Linux |
| AC-02 | Code Workspace 打开项目树与编辑器 | 鼠标按住分割线向右连续平滑拖动 100px | 项目树宽度平滑扩大约 100px，编辑器宽度对应收缩，无任何卡顿、中断、冻结或控制台错误 | Windows、macOS、Linux |
| AC-03 | Code Workspace 打开项目树与编辑器 | 鼠标按住分割线向左连续平滑拖动至 100px 以下 | 项目树宽度随光标平滑缩小，支持收缩至紧凑尺寸；继续拖向极小时平滑折叠至折叠栏 | Windows、macOS、Linux |
| AC-04 | 拖动项目树分割线调整至新尺寸（如 360px） | 释放鼠标左键（pointerup） | 最终尺寸（360px）通过 `onLayoutChanged` 成功持久化到 `codeWorkspaceStore` 的 `shellChromeState.projectWidthPx` 中；拖拽过程中无多余的持久化写盘与全量组件重渲染 | Windows、macOS、Linux |
| AC-05 | 已经拖动调整过项目树宽度 | 切换到其他 Tab 再切回，或重启应用加载工作区 | 项目树保持用户上次拖拽释放时的 `projectWidthPx` 宽度，不跳回 452px 默认值 | Windows、macOS、Linux |
| AC-06 | 项目树处于打开状态 | 点击折叠栏按钮、工具栏隐藏按钮或按下 `Alt+1` 折叠项目树 | 项目树正确折叠，分割线设置为 `disabled` 并隐藏；再次按下 `Alt+1` 展开时，项目树恢复至折叠前的最新宽度 | Windows、macOS、Linux |
| AC-07 | 保持既有行为契约 | 拖动项目树分割线期间及完成后 | 编辑器中的光标位置、已打开 Tab、代码修改未保存状态（dirty flag）、底部 dock 状态及右侧文档栏状态均完好无损，不发生意外刷新或重置 | Windows、macOS、Linux |

## 4. 修复方案与关键决策

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 分割线拖拽状态解耦与持久化时机 | 选项 1 (推荐)：在拖拽过程（`onResize`）中仅更新组件本地 `lastProjectPanelSizeRef.current`，固定 `Panel id="project"` 的初始 `defaultSize` 不动态变更；在 `PanelGroup.onLayoutChanged` 释放时才触发 `setShellChromeState` 写入持久化 store。<br>选项 2：放弃 `react-resizable-panels`，改用纯手写 `PointerEvent` 监听器（类似 `BottomDock`）。代价较大且破坏已有 PanelGroup 嵌套生态。<br>选项 3：使用 debounce 防抖延迟写入 store。在防抖时间内仍会打断连续长距离拖拽，无法根治。 | 采纳选项 1。严格遵循 `react-resizable-panels` 官方架构规范：`defaultSize` 仅作初始挂载依据，`onLayoutChanged` 专用于拖拽释放后的持久化写入，彻底消除拖拽过程中的重渲染死循环与状态注销。 | agent 自决 (契约与标准库规范确定) | 官方 API 契约与实测验证 | AC-02, AC-04, TASK-01, V-01 |
| DEC-02 分割线命中热区与交互视觉增强 | 选项 1 (推荐)：为 `PanelResizeHandle` 补齐显式 `id`；保留紧凑的 3px 物理视觉宽度，添加 `after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:z-20` 扩展命中热区至 6px；添加 `active:bg-[var(--taomni-accent)]`。<br>选项 2：直接将实体宽度改为 6px。会使界面分隔线过粗，与 IntelliJ IDEA 的紧凑精致设计风格不符。<br>选项 3：维持 3px 纯线，不做伪元素扩展。鼠标必须精确停在 3 个物理像素内，在高清屏幕上极易滑脱。 | 采纳选项 1。兼顾 IntelliJ IDEA 视觉对齐的精致 3px 外观与 6px+ 容易抓取的操作手感，同时解决由于缺失 `id` 导致 `data-testid` 被库覆盖的问题。 | agent 自决 (UI 一致性与可用性权衡) | IDEA 对齐标准与现有 `DebugVariablesPane` 成功经验 | AC-01, TASK-02, V-02 |
| DEC-03 折叠状态下的 Separator 表现 | 选项 1 (推荐)：在 `languagePanelOpen` 为 false 时，为 `PanelResizeHandle` 设置 `disabled={!languagePanelOpen}`，并保留 `className={languagePanelOpen ? "..." : "hidden"}`。<br>选项 2：条件渲染 `{languagePanelOpen && <PanelResizeHandle />}`。在库内会导致分隔符动态增删，可能影响面板索引。<br>选项 3：仅用 CSS `hidden`。在库内残留未 disabled 的 0 宽 separator，导致排序计算边缘隐患。 | 采纳选项 1。显式 `disabled` 告知库在 hit testing 中安全跳过该分隔线，且 Panel 保持挂载利于 `panel.collapse()` / `panel.resize()` 顺畅恢复。 | agent 自决 | `react-resizable-panels` Separator 规范 | AC-06, TASK-02, V-02 |

### 用户流程与交互

```text
[用户鼠标移向项目树右边缘]
       │
       ▼
[光标变为 col-resize，分割线变亮为 Accent 强调色 (AC-01)]
       │
       ▼
[按下鼠标左键并左右拖曳]
       │
       ├─► 实时平滑移动项目树右边界与编辑器左边界 (AC-02, AC-03)
       ├─► 分割线保持 Active 强调色
       ├─► 本地 lastProjectPanelSizeRef 实时记录当前像素值
       │
       ▼
[松开鼠标左键]
       │
       ├─► PanelGroup.onLayoutChanged 触发 (AC-04)
       ├─► 调用 setShellChromeState 保存最新 projectWidthPx
       └─► 分割线恢复默认边框色，编辑器与项目树稳定在新宽度
```

### 数据流、状态与生命周期

1. **初始挂载与加载**：
   - 从 `workspaceUi.shellChromeState?.projectWidthPx ?? 452` 获取初始尺寸。
   - `CodeWorkspaceTab` 内部使用初始值（例如通过 `useRef` 或固定 memo `initialProjectWidthRef`）提供给 `<Panel id="project" defaultSize={`${initialProjectWidth}px`}>`。
   - 在组件挂载期间，`defaultSize` 属性保持静态稳定，不随拖拽过程变化。
2. **拖拽进行时**：
   - 鼠标在 `PanelResizeHandle` 上发生 `pointerdown`，库进入 `active` 状态。
   - 鼠标移动触发 `handleProjectPanelResize`：
     - 更新 `lastProjectPanelSizeRef.current = pixels`；
     - 仅当跨越折叠阈值时才调用 `setLanguagePanelOpen`（通过 `open === next ? open : next` 避免多余更新）；
     - **绝对不调用** `setShellChromeState`，不引发 React 重新渲染，不打断拖拽手势。
3. **拖拽结束（释放）**：
   - 鼠标松开触发 `pointerup`，库内部完成最终布局分配并调用 `PanelGroup` 的 `onLayoutChanged`。
   - `onLayoutChanged` 读取 `lastProjectPanelSizeRef.current`，如果有效（`> 40`）则调用 `setShellChromeState(workspaceInstanceId, { projectWidthPx: lastProjectPanelSizeRef.current })`。
   - 状态写入 Zustand store，完成持久化并供后续刷新复用。
4. **快捷键与折叠恢复**：
   - 用户按 `Alt+1` 展开时，原有的 `panel.resize(`${lastProjectPanelSizeRef.current}px`)` 命令继续生效，恢复至拖拽设置的宽度。
   - 用户执行 `workspace.restoreToolWindowLayout`（Shift+F12）时，imperative `panel.resize("452px")` 依然正常工作。

### 接口与共享契约

| 类型 / 名称 | 调用方 → 实现方 | 输入及参数 | 输出 / 状态变更 | 兼容规则 |
|---|---|---|---|---|
| `setShellChromeState` | `CodeWorkspaceTab.onLayoutChanged` → `codeWorkspaceStore` | `(workspaceInstanceId, { projectWidthPx: number })` | 更新对应工作区实例的 chrome 配置，触发持久化 | 保持既有 store 签名完全不变 |
| `PanelResizeHandle` | `CodeWorkspaceTab` JSX | `id="code-workspace-project-resize-handle"`、`disabled={!languagePanelOpen}` | 渲染包含热区伪元素的 separator | 属性完全向前兼容 |
| `FileTreePane` 右边框 | `FileTreePane.tsx` → DOM | 样式调整 | 移除外层 `border-r`，避免与 `PanelResizeHandle` 物理重叠 | 纯样式调整，不改动任何外部 props |

### 三端兼容与异常边界

- **三端原生 WebView**：
  - Windows（WebView2 / Chromium）、macOS（WKWebView）、Linux（WebKitGTK）均完整支持 CSS `after` 伪元素事件命中及 W3C Pointer Events。
  - `touchAction: "none"` 及 `relative after:...` 属于标准现代前端属性，无任何平台特异性代码或条件编译（`cfg`）。
- **极端小宽度保护**：
  - 当拖动导致项目树像素 `<= 40` 时，继续保留既有的自动折叠逻辑，防止出现负宽度或损坏布局。
- **Browser Preview Stub**：
  - 浏览器预览模式（`pnpm dev`）与真实桌面端（`pnpm tauri dev`）在布局上行为完全一致。

## 5. 改动清单

| 路径 / 模块 | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/components/editor/CodeWorkspaceTab.tsx` | 1. 在 `handleProjectPanelResize` 中移除即时调用 `setShellChromeState`，仅在 ref 中记录像素值；<br>2. 将 `<Panel id="project">` 的 `defaultSize` 固定为挂载时的初始宽度（如 `initialProjectWidthRef.current`），防止拖拽期间动态改变；<br>3. 在外层 `<PanelGroup>` 上增加 `onLayoutChanged` 回调，在释放时将最新像素持久化至 `setShellChromeState`；<br>4. 为 `<PanelResizeHandle>` 增加显式 `id="code-workspace-project-resize-handle"`、`disabled={!languagePanelOpen}` 及热区扩展类；<br>5. 保持快捷键与折叠恢复逻辑不变。 | AC-01, AC-02, AC-03, AC-04, AC-05, AC-06, AC-07 | TASK-01, TASK-02 |
| `src/components/editor/workspace/FileTreePane.tsx` | 移除 `FileTreePane` 最外层 `aside` 上的 `border-r border-[var(--taomni-code-border)]`，由紧邻的 `PanelResizeHandle` 充当视觉分界线，消除双重边框与 1px 误触区。 | AC-01 | TASK-03 |
| `src/components/editor/CodeWorkspaceTab.test.tsx` | 增补对 `code-workspace-project-resize-handle` 属性（`id`、`aria-disabled` 等）的断言，并在现有测试中覆盖拖拽释放与折叠保持。 | AC-01, AC-04, AC-06 | TASK-04 |
| `src/components/editor/workspace/CodeWorkspaceSplitter.integration.test.tsx` (拟新增) | 新增集成测试（使用 unmock 的真实 `react-resizable-panels`），验证连续 pointermove 下项目树分割线不冻结、无报错、且释放后正确调用 `setShellChromeState`。 | AC-02, AC-04 | TASK-04 |

## 6. 实现任务与交接

### TASK-01 解耦项目树拖拽过程与持久化更新
- **职责与文件范围**：`src/components/editor/CodeWorkspaceTab.tsx`
- **输入与必读**：本文档第 2 节根因分析、第 4 节 DEC-01
- **实施内容**：
  1. 使用 `useRef` 记录组件初次挂载时的初始宽度：`const initialProjectWidth = useRef(`${workspaceUi.shellChromeState?.projectWidthPx ?? 452}px`).current;`。
  2. 修改 `<Panel id="project">` 的 `defaultSize={initialProjectWidth}`，确保挂载后该 prop 不随每次 drag 发生变化。
  3. 修改 `handleProjectPanelResize`：仅保留 `lastProjectPanelSizeRef.current = pixels` 与 `setLanguagePanelOpen` 折叠阈值判定，删除其内部的 `setShellChromeState(...)` 调用。
  4. 在外层 `<PanelGroup id={`code-workspace-${workspaceInstanceId}`}>` 上添加 `onLayoutChanged` 回调：
     ```tsx
     onLayoutChanged={(layout) => {
       if (lastProjectPanelSizeRef.current > 40) {
         setShellChromeState(workspaceInstanceId, {
           projectWidthPx: lastProjectPanelSizeRef.current,
         });
       }
     }}
     ```
- **对应验收**：AC-02, AC-03, AC-04, AC-05
- **验证与完成条件**：V-01 通过，拖动过程中无任何由于 Group 重新挂载引发的死锁。

### TASK-02 优化分割线组件属性与命中热区
- **职责与文件范围**：`src/components/editor/CodeWorkspaceTab.tsx`
- **实施内容**：
  1. 修改 `<PanelResizeHandle>`，显式传入 `id="code-workspace-project-resize-handle"`，确保 `data-testid` 属性在真实 DOM 中不被随机生成的 `useId` 覆盖。
  2. 传入 `disabled={!languagePanelOpen}`。
  3. 优化 `className`：
     ```tsx
     className={languagePanelOpen
       ? "w-[3px] bg-[var(--taomni-code-border)] hover:bg-[var(--taomni-accent)] active:bg-[var(--taomni-accent)] transition-colors cursor-col-resize shrink-0 relative after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:z-20"
       : "hidden"}
     ```
- **对应验收**：AC-01, AC-06
- **验证与完成条件**：V-02 通过，分割线拥有 6px 热区，hover/active 样式正常。

### TASK-03 优化 FileTreePane 边框避免重复与误击
- **职责与文件范围**：`src/components/editor/workspace/FileTreePane.tsx`
- **实施内容**：
  检查外层 `aside` 的 `className`，将 `border-r border-[var(--taomni-code-border)]` 移除或按需处理，确保项目树右边缘与分割线合一，不产生重合边框。
- **对应验收**：AC-01
- **验证与完成条件**：审查 DOM 布局，无相邻双重 1px 线。

### TASK-04 自动化单元与集成测试落地
- **职责与文件范围**：`src/components/editor/CodeWorkspaceTab.test.tsx` 及拟新增 `src/components/editor/workspace/CodeWorkspaceSplitter.integration.test.tsx`
- **实施内容**：
  1. 在 `CodeWorkspaceTab.test.tsx` 中验证已有的 `code-workspace-project-resize-handle` 测试继续全绿。
  2. 编写真实 `react-resizable-panels` 环境下的拖拽集成测试，模拟 pointerdown、连续多次 pointermove 及 pointerup，断言 layout 正常发生位移且 store 成功记录。
  3. 运行 `pnpm test` 及 `pnpm build`。
- **对应验收**：AC-01~AC-07
- **验证与完成条件**：V-01, V-02, V-03, V-04 全部通过。

### TASK-05 当前运行端（Windows）真机验证与交付
- **职责与文件范围**：真机验证与交付验收
- **实施内容**：
  在 Windows 11 下执行实际桌面应用操作，验证鼠标抓取、连续左右拖曳平滑度、松开保存与折叠恢复。
- **对应验收**：AC-01~AC-07
- **验证与完成条件**：V-05 成功通过并记录实测证据。

## 7. 自动化测试计划

| V ID | AC / 用途 | 层级与文件 | 前置数据与操作 | 核心断言 | 命令与工作目录 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-02, AC-04 / 验证连续拖拽不冻结且释放后持久化 | Vitest 集成测试<br>`src/components/editor/workspace/CodeWorkspaceSplitter.integration.test.tsx` (已新增) | 使用真实 `react-resizable-panels`（`vi.unmock`）；挂载 `CodeWorkspaceTab`，初始宽度 452px；派发 pointerdown，随后派发两次 pointermove (480px, 520px) 并最终 pointerup | 第二次 pointermove 后 layout 成功继续扩大至相应比例；无 `Panel constraints not found for index -1` 错误；pointerup 后 `projectWidthPx` 被更新为最终值 | `pnpm test src/components/editor/workspace/CodeWorkspaceSplitter.integration.test.tsx`<br>目录：根目录 | 改前：改前代码（stash 修复）复跑实测第一次 move 后 flexGrow 由 37.761 回退到 34.492（拖拽冻结/面板重注册），用例失败；<br>改后：2 个用例全绿（连续响应并在释放后写入 519px） |
| V-02 | AC-01, AC-06 / 验证 handle 属性与 disabled/折叠联动 | Vitest 单元测试<br>`src/components/editor/CodeWorkspaceTab.test.tsx` | 渲染标准 Code Workspace；检查 handle 的 `id`、`role="separator"`、展开与折叠状态下的 class 与 disabled 属性 | `getByTestId("code-workspace-project-resize-handle")` 存在且包含预期扩展热区 class；折叠后处于 disabled/hidden 状态 | `pnpm test src/components/editor/CodeWorkspaceTab.test.tsx`<br>目录：根目录 | 已通过：新增 3 个用例（持久化宽度挂载、defaultSize 静态化、handle 属性与折叠禁用），`-t "ED-SHELLLAYOUT"` 9 passed |
| V-03 | AC-06, AC-07 / 既有项目树折叠及相邻功能回归 | Vitest 单元测试<br>`src/components/editor/CodeWorkspaceTab.test.tsx` | 运行既有项目树折叠、打开文件、Tab 切换等测试 | 现有用例全部通过，未破坏任何既有编辑或项目树行为 | `pnpm test src/components/editor/CodeWorkspaceTab.test.tsx`<br>目录：根目录 | 已通过：196 passed（含既有用例） |
| V-04 | 生产构建与类型检查 | TypeScript + Vite 检查 | 运行前端整体构建与类型检查 | `tsc -b && vite build` 退出码 0，无任何类型报错或编译错误 | `pnpm build`<br>目录：根目录 | 已通过：退出码 0（仅既有 chunk 体积提示）；全量 `pnpm test` 425 files / 4271 tests 全绿 |

## 8. 真机验证手册

### 环境与准备

- **当前运行端**：Windows 11 x64，Node.js v22.18.0，Tauri 2 桌面环境。
- **其他平台**：macOS（WKWebView）、Linux（WebKitGTK），本轮保留验证计划。
- **前置准备**：
  在工程根目录执行 `pnpm build` 确认构建通过。启动开发环境：
  ```pwsh
  pnpm dev          # 浏览器预览辅助检查
  pnpm tauri dev    # Windows 真实桌面原生应用检查
  ```

### V-05 真实桌面端分割线拖拽验证

- **对应验收**：AC-01, AC-02, AC-03, AC-04, AC-05, AC-06, AC-07
- **执行前状态**：打开任意本地仓库（如当前 taomni 仓库），左侧显示项目文件树，右侧打开任意代码文件。
- **操作与逐步预期**：
  1. **悬停检查**：缓慢将鼠标悬停在项目树与代码编辑器之间的分割线上。
     - *预期*：鼠标指针平滑变为左右双向箭头（`col-resize`），分割线亮起明显的 Accent 主题色；在距离分割线左右约 3px 的范围内均能稳定保持该状态，无闪烁。
  2. **向右扩大拖动**：在分割线上按下鼠标左键，向右连续拖动约 150px。
     - *预期*：项目树宽度随着鼠标移动平滑实时扩大，代码编辑器宽度平滑缩小；拖动全程无卡顿、无停滞锁死，分割线保持高亮。
  3. **向左收缩拖动**：按住鼠标左键不放，反向向左平滑拖动至约 200px 紧凑宽度后松开左键。
     - *预期*：项目树宽度实时跟随收缩；松开左键时光标恢复默认指针，项目树稳定保持在约 200px 宽度。
  4. **持久化与复原检查**：切换到终端标签页或其他标签页，再切回 Code Workspace；或者重新打开工作区。
     - *预期*：项目树宽度依然保持在约 200px，未重置为默认的 452px。
  5. **折叠与恢复检查**：按下快捷键 `Alt+1`（或点击项目树顶部的折叠图标）。
     - *预期*：项目树折叠至左侧极窄 Explorer 栏；再次按下 `Alt+1` 展开，项目树平滑恢复至上次调整的 200px 宽度。
- **证据记录**：记录实测截图（悬停态与拖动后布局），记录 Chrome/Tauri 开发者工具控制台无任何 Uncaught Error。
- **状态**：Windows 原生真机步骤待执行（需人工鼠标操作）；本轮已完成浏览器预览实测（Chromium 内核，与 WebView2 同引擎），证据如下：
  - 会话：`playwright-cli -s=taomni-splitter`（已关闭），`pnpm dev`（http://localhost:5000，已停止）。
  - AC-01：`code-workspace-project-resize-handle` 悬停显示横向缩放光标；`elementFromPoint` 在距中线 ±4px（实体线 3px 之外）仍命中 handle，扩展热区生效；从该偏移起按下并拖拽正常。
  - AC-02：按住分割线向右连续拖动，项目树宽度实测 452 → 462 → 472 → … → 572（每步 10px 平滑跟随），无冻结、无中断。
  - AC-03：向左连续拖动实测 432 → 412 → … → 152 → 132（每步 20px 平滑跟随）。
  - AC-04：释放后 `localStorage` 快照 `shellChromeState.projectWidthPx` 分别为 572（右拖）与 132（左拖），拖拽过程中 store 未写入。
  - AC-06：点击折叠按钮后面板宽度 0 且出现 `code-workspace-project-collapsed-rail`；点击展开按钮恢复至折叠前宽度。
  - 全程控制台 0 errors（9 warnings 与本改动无关）。
  - 截图：`qa-ui-auto-report/_local/splitter-hover.png`、`splitter-after-drag.png`、`splitter-left-drag.png`、`splitter-hover-hit-area.png`。
  - 说明：浏览器预览每次刷新会新建 workspace 实例（实例 ID 随机），无法复现“重启恢复同一实例宽度”；该路径由 V-02 单元测试（挂载读取持久化快照）覆盖，原生端待人工确认。

### macOS / Linux 接续验证计划

- **macOS**：在 Safari / WebKit 内核下，验证 Pointer Events 在带有 sub-pixel 缩放的 Retina 屏幕下的抓取体验，验证 Command+1 / 快捷键切换与拖拽无冲突。
- **Linux**：在 WebKitGTK 环境下，验证鼠标左键拖拽及光标样式变换，验证 Wayland / X11 环境下的窗口与分栏缩放。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4 交互与 DEC-02 | TASK-02, TASK-03 | V-02, V-05 (Windows) | DOM 属性与 CSS 检查；Windows 真实悬停截图 | 已实现并自动化验证；浏览器实测悬停光标与 ±4px 热区命中；Windows 原生悬停截图待人工补录 |
| AC-02 | §4 数据流与 DEC-01 | TASK-01 | V-01, V-05 (Windows) | 自动化连续拖拽通过日志；Windows 真实向右拖拽记录 | V-01 集成测试通过（改前复现冻结失败）；浏览器实测 452→572 平滑跟随；原生待人工确认 |
| AC-03 | §4 数据流与 DEC-01 | TASK-01 | V-01, V-05 (Windows) | 自动化连续拖拽通过日志；Windows 真实向左收缩记录 | V-01 通过；浏览器实测 432→132 平滑收缩；原生待人工确认 |
| AC-04 | §4 数据流与 DEC-01 | TASK-01 | V-01, V-05 (Windows) | `setShellChromeState` 触发次数断言；store 持久化数据 | V-01 断言拖拽中 store 保持 452、释放后写入 519；浏览器实测释放后快照 572/132 |
| AC-05 | §4 数据流与 DEC-01 | TASK-01 | V-05 (Windows) | 切标签页与重开状态比对证据 | 单元测试覆盖快照挂载宽度（318px 用例）；浏览器预览不支持标签恢复，原生待人工确认 |
| AC-06 | §4 DEC-03 | TASK-01, TASK-02 | V-02, V-05 (Windows) | `Alt+1` 折叠展开前后面板宽度断言与实测记录 | V-01 集成测试覆盖折叠/展开恢复；浏览器实测折叠 0 + 展开恢复；Alt+1 原生待人工确认 |
| AC-07 | §4 修复方案 | TASK-01, TASK-04 | V-03, V-04 (All) | 既有用例全绿日志；`pnpm build` 退出码 0 | 已通过：CodeWorkspaceTab 196 passed、全量 4271 passed、`pnpm build` 退出码 0 |

交付完成条件：
1. 三端代码兼容性检查通过，无平台特化构建缺陷。
2. V-01 ~ V-04 自动化测试及静态构建全部通过。
3. 当前运行端（Windows 11）完成 V-05 真机实测，拖拽顺畅可用。
4. macOS 与 Linux 记录未实测范围与后续步骤，不阻塞当前交付。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| 初始挂载宽度与 store 存储差异 | 若工作区在恢复布局前短暂使用 452px 默认值渲染，可能产生 1 帧布局跳动 | 在 `CodeWorkspaceTab` 初次读取时优先使用 `workspaceUi.shellChromeState?.projectWidthPx ?? 452` 作为 `initialProjectWidthRef.current`，保证首帧与 store 一致 | 不阻塞 | 实现时按推荐方案落地 |
| 拖拽至过小时的自动折叠触发 | 拖动至 `<= 40px` 时触发 `setLanguagePanelOpen(false)` 会折叠面板 | 保留既有行为保护；当用户明确收缩到极限时自动折叠属于预期体验，不造成负宽度破坏 | 不阻塞 | V-01 / V-05 校验临界边界 |

- **代码与数据回退边界**：
  本次修复不更改 `codeWorkspaceStore` 的数据结构，不更改持久化存储 key（保持 `shellChromeState.projectWidthPx`），无需任何数据库或持久化迁移。若发生非预期回退，仅需回滚 `CodeWorkspaceTab.tsx` 与 `FileTreePane.tsx` 对应渲染与回调代码即可，不会导致用户历史工作区配置损坏。
- **当前可开始任务**：TASK-01、TASK-02、TASK-03、TASK-04、TASK-05 均无未决阻塞项，设计已收敛至可实施状态，下游可直接按任务分工推进开发与验证。
