# Workspace 预览查找与文件／目录搜索修复

## 范围与复现

基线：`abf342f6`（分支 `docs/workspace-platform-redesign`）。先保留错误截图，再修改生产代码。

| 用户操作 | 复现与原因 | 修复结果 |
| --- | --- | --- |
| Markdown 切换 Preview，点击预览后 Ctrl+F | 纯预览卸载 CodeMirror，其 Find Action 随之消失 | 预览拥有渲染文本查找，可高亮、计数、前后切换和 Escape 关闭；Split 按焦点分别查找源码／预览 |
| 空编辑器工作区 Ctrl+Shift+N | shell 同时打开 New Session；HOME 的 2000 文件 DFS 索引先被早期隐藏目录填满，根目录 `.bashrc` 缺失 | 工作区独占文件导航快捷键；输入查询后补查截断索引之外的文件，包含普通文档和配置文件 |
| 工作区目录树搜索 Documents | 筛选渲染器只接受文件，目录自身缺失；同样受共享索引上限影响 | 返回文件、目录、空目录；Packages／Flat 中搜索也包含普通文件；激活目录结果会清空筛选并展开实际祖先层级 |
| 寻找 View／Flatten 入口 | 实际 Workspace 侧栏已挂载该工具栏，基线 TC-WS-041 通过 | 入口为顶部 `Project ▾`，以及 `⋮ → Appearance → Flatten packages`，本次保留菜单行为 |

本次修复不依赖 Java 文件扩展名，适用于各语言和普通工作区。

### 修改前证据

- Markdown browser：`/tmp/taomni-markdown-find-before/run-20261031-160131-378808810/TC-MARKDOWN-FIND-PROBE/markdown-preview-after-ctrl-f.png`，没有查找栏。
- HOME native：`/tmp/taomni-home-search-before2/run-20261031-160351-063898865/TC-HOME-SEARCH-PROBE/home-search-conflicting-session.png` 与 `home-search-truncated.png`。真实根目录 `.bashrc` 没有返回，只出现备份目录中的同名文件。仅读取路径元数据，没有打开、编辑或保存个人文件。
- 目录 browser：`/tmp/taomni-tree-search-before/run-20261031-160858-751550935/TC-TREE-SEARCH-PROBE/workspace-tree-folder-search-before.png`。只有 Documents 下的两个文件，没有 Documents 目录。
- Workspace 工具栏：`/tmp/taomni-tree-view-before/run-20261031-160350-877741640/TC-TREE-VIEW-PROBE/` 中的 View／Appearance／Java Flatten 截图；TC-WS-041 基线通过。

## 性能与异步所有权

保留普通目录展开的懒加载，以及 Flat／Packages／Go to File 的 2000 文件、25 层共享索引上限。

- 空查询不启动新补查；文件导航只有已截断的根目录才启动补查。目录筛选在有查询时查找目录元数据，以发现未展开目录和空目录，不额外启动一个全量文件索引。
- 补查只读目录元数据，不读文件正文。输入防抖 120ms，单个搜索 owner 最多两个未完成 IPC；旧查询尚未完成的读取仍占用并发预算。
- 查询改变、关闭、根目录变化或卸载后停止后续调度，丢弃迟到结果。已发出的单次 listDir 没有取消协议，允许其完成，不再启动其子目录读取。
- 每处理 256 个条目及每批目录后让出主线程；结果最多每 80ms 发布一次，完成／错误状态最终发布。无新增结果时不重复发布列表。
- 每次补查最多 200 个匹配、10000 个目录、25 层，达到范围上限明确显示 partial results 并提示缩小查询。`.git`、`node_modules`、`target`、`.cache` 等目录仍不递归；目录本身可被目录筛选找到。
- 查询结果与展开缓存、共享索引分开，清空查询立即恢复正常树，不将 HOME 全量载入 React 状态。普通目录树仍使用现有虚拟行渲染。

这提供了明确的工作量和响应保护；没有承诺任意规模 HOME 一次返回所有匹配。

## 回归契约与用例

| 验收 | 自动化覆盖 |
| --- | --- |
| 预览 Ctrl+F、大小写、无结果、前后匹配、关闭／重开、Split 焦点 | TC-WS-081，`previewSearch.cases.tsx`；保留已有 Mermaid SVG／PNG 与源码不写盘断言 |
| 超过 2000 个文件仍找到普通文档、空目录；无 New Session 冲突；恢复层级；Packages 搜索文档 | TC-WS-082，浏览器 VFS 和 native 实际磁盘，独立 `workspace_search_large` fixture |
| 空查询不建递归索引；一次文件导航索引之后目录筛选不再额外建索引；打开结果的内容／帧预算 | TC-WS-082 forwarding-only IPC 观测、`measure_workspace_file_open` |
| 两个并发、快速输入防抖、关闭停止调度、旧响应隔离、错误与可读结果并存、结果上限 | `useWorkspaceFileSearch.test.tsx` |
| 缓存复用、刷新、隐藏分支不遍历、外部更改、虚拟行与键盘 | `useWorkspaceTreeData*.test.tsx`、`ProjectTree.virtualization.test.tsx` |
| 原有目录复制／粘贴／编辑／保存、View／Flatten | TC-WS-036／037、041 |
| 隐藏编辑器、空工作区、混合布局、dirty 内容、真实 PTY 和磁盘副作用 | 完整 `crash-regression` browser／native 集合 |

## 当前验证记录

- `pnpm build`：通过（包含 `pnpm check:refactor`）。
- 搜索、导航、shell 快捷键、树缓存／外部刷新／虚拟行：6 个文件，50 项通过。
- CodeWorkspaceTab 完整集首轮 260 项通过，新增预览焦点断言需等待下一帧；修正测试等待后新增 2 项通过。首轮暴露的查询测试 teardown 返回 mock、旧树搜索索引假设均已修正，并由上述 50 项验证通过。
- 首个完整候选（`a1cc9c9f`）本地最终 browser：`/tmp/taomni-search-browser-stable/run-20261031-164422-807763953`，11/11，通过完整 8 项 crash 回归与 TC-WS-036／041／081；独立 TC-WS-082 `/tmp/taomni-search-browser-final-isolated/run-20261031-165227-989101415`，1/1，通过性能／IPC 断言，内容可用 200.8ms，最大帧 85.3ms。两批 identity_stable 均为 true。
- 输入响应基线：`/tmp/taomni-search-performance-before.json`，相同 2100 文件 fixture、5 轮、20ms 字符间隔，所有字符与连续帧保留。45 次按键最大 keydown→frame 97.4ms，最大帧间隔 100ms；5 轮均未找到索引之外的目标文件。该记录只用于输入与帧响应比较，不将自动化总耗时当作产品延迟。
- 独立输入响应复测（原生编译／其他自动化停止后）：`/tmp/taomni-search-performance-before-isolated.json` 与 `after-isolated.json`。前后各 5 轮共 45 个字符；keydown→frame p50 为 18.8／15.9ms，p95 为 37.2／42.0ms，最大 42.7／47.9ms；连续帧 p95 均为 16.8ms、最大均为 33.4ms。空查询递归索引调用均为 0，目标文档从 0/5 变为 5/5。没有观察到明显响应退化，保留全部样本，不将该小样本结论外推到任意目录规模。
- 初轮并行编译／回归期间，候选输入最大 118ms、结果打开出现 170ms 帧，超过既有 165ms 上限。失败原件保留在 `/tmp/taomni-search-performance-after.json`、`/tmp/taomni-search-final-browser/`；编译结束单独复测 TC-WS-082 通过，报告 `/tmp/taomni-search-final-browser2/`，阈值未改。
- Shell／SearchEverywhere 最终回归：2 个文件，29 项通过（包含 partial results 新文案断言）。
- `audit --gate`：通过，`/tmp/taomni-search-audit2.log`。新增用例、policy、依赖与控件目录已同步。
- 首轮完整 crash browser 8 项均通过，但期间修改了 QA fixture，导致 runner 身份稳定检查失败；不作为验收。上述最终稳定 browser 批次已重跑覆盖。
- 最终审查将 shell 修复收敛为：检测活动工作区注册后让出 Ctrl+Shift+N，由工作区 keymap 自行执行，保留自定义键位和弹层焦点保护。此前直接 executeAction 的实现不作为最终版本。
- 首个完整候选本地 native QA release：`/tmp/taomni-search-native-final/run-20261031-165320-318196940`，12/12，包括完整 9 项 native crash 回归和 TC-WS-037／081／082；identity_stable=true，内容可用 229ms、最大帧 115ms。
- 真实 HOME native：`/tmp/taomni-search-home-final/run-20261031-165259-387615279`，1/1、identity_stable=true。Ctrl+Shift+N 找到根目录 `.bashrc`，目录筛选找到 `.bashrc` 与 `.config`，没有 New Session 弹窗；只读取元数据，不打开或修改个人文件。

### GitHub 首轮暴露的异步回归

[首轮三平台 run 41185946040](https://github.com/engcapa/taomni/actions/runs/41185946040) 使用 `a1cc9c9f`，三平台 browser 各 12/12、零失败／跳过，原始报告与源码指纹一致。原始 native 报告暴露以下问题，因此该轮不能算三平台验收通过：

1. Linux TC-WS-081：纯 Preview 查找通过，Split 步骤 36 失败。焦点记录证明按键来自预览，截图却显示源码 Find。CodeMirror 异步挂载可能晚于预览聚焦，后注册的同 owner Find 覆盖预览动作。补充稳定失败的 hook 回归；Action 层增加默认 0 的注册优先级，聚焦预览使用 1，失焦／卸载移除后恢复源码动作。既有同优先级的后注册覆盖、owner 隔离与自定义快捷键保持原契约。
2. macOS TC-WS-037：拷贝成功后双击目标却打开 README。新增搜索状态行放在结果之前，文件 watcher 刷新结束移除提示，恰好在指针定位后把目标上移一行。原始 screenshot／focus events 保留在 `/tmp/taomni-search-hosted-native-before/`。加载／错误／截断提示移到已发布结果末尾，避免异步状态变化移动点击目标。补充先失败的结果顺序与 DOM 身份／打开行为回归，保留 TC-WS-037 的真实磁盘复制和保存断言。

跟进快速回归：8 个测试文件、77 项通过；`pnpm check:refactor` 与 `audit --gate` 通过。TC-WS-081 增加 Split 的实际高亮截图，断言未放宽。使用最终源码重建 QA release，并重跑本地 HOME、完整 crash／目标用例与三平台验证；最终结果待补充。
