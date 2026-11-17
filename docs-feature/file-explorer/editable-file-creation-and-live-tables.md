# File Explorer 新建可编辑文件与 Live 表格修复（2026-11-17）

File Explorer 保留新建文件夹和原文本文件入口，工具栏“新建 → 其他文件类型…”与目录空白处右键“新建其他文件…”共用类型选择对话框。类型来自 `classifyFile` 的可编辑扩展名与约定文件名清单，涵盖 Markdown/HTML/SVG、文本与配置、源代码、Dockerfile/Makefile 等，不提供只能预览的 PDF/位图或未知二进制格式。可以选择类型并更改当前目录下的文件名；普通扩展名自动建议未占用的编号，成功后按后端实际路径选中并进入原重命名流程。特殊约定文件名冲突要求另选名称；输入重复名、路径或不支持的扩展名时保留对话框，不覆盖既有文件。IPC 失败可更正重试。新建 `.env` 等隐藏配置后自动显示隐藏项，以便选中并重命名。创建为空文件，双击使用已有编辑器；HTML/SVG 可进入源码编辑，代码沿用 Code Workspace 路由。

Live 表格此前直接使用 `textContent` 展示单元格，导致 `**` 等源码显示而未渲染。现由独立 TableCell owner 管理单元格渲染、源码编辑、IME、粘贴与图片异步生命周期：只读及未激活单元格调用共享 Markdown inline parser/sanitizer、KaTeX 和受控图片加载；激活可编辑单元格显示原源码，离开后恢复渲染。保留 Tab/Enter、行列/对齐、历史和标准 GFM 保存。渲染和焦点切换不写文档，非目标更新不覆盖正在组合的中文输入，同一单元格并发变更拒绝迟到的 IME 提交；编辑/销毁使旧图片结果失效。

验收分工：

| 证据 | 断言 |
|---|---|
| `ExplorerShell.newFile.test.tsx` 与原 Explorer 单元 | 完整类型清单、两入口、取消、选择/重命名/打开、扩展名编号、输入校验、冲突和失败重试；浏览器 DOM/mock，不代表 native 文件效果 |
| `TableWidget.test.ts`、原 markdownWidgets/MarkdownEditor 等单元 | 改前四项失败已复现；格式/安全/公式、焦点不写源码、单元格编辑与历史、IME/并发和迟到图片清理 |
| `TC-EXPLORER-006` browser/native | 两入口、类型菜单、取消/错误/冲突/重试、代表类型空文件（含隐藏配置）、重复 Markdown 命名、独立 VFS/host 字节 |
| `TC-EXPLORER-007` browser/native | 新建 Markdown/HTML/SVG/JSON/TS 的实际路由、编辑、保存、关闭重开/代码恢复，独立完整字节；包含 crash-regression |
| `TC-FILE-OPEN-023` browser/native | Live/Split 格式一致、HTML 清理/本地图片/公式、只读、编辑/Tab/Undo/Redo、未改单元格与完整 GFM 保存重开；包含 crash-regression |
| 保留用例 | Explorer001–005；FILE-OPEN001/003/004/007/013，覆盖旧文本/文件夹/操作、SVG与Markdown原合同和 native 导出；workflow 合并完整 crash-regression |

真实 UI 和 native 磁盘/进程验证全部在 GitHub `qa-ui-auto-platforms` 执行，三端 browser/native、匹配 release QA binary，完成一个 shard 即下载检查。当前新增用例执行结果未出前不得记为通过。WebView 按键与 composition 单元不等于物理 IME、AppKit 菜单或 OS 快捷键证据；未改这些绑定。截图仅是保留证据，需要另外查看画面。

首次 [#44053218016](https://github.com/engcapa/taomni/actions/runs/44053218016) 在规划阶段的 `test_crash_regressions` 失败：新增两项 crash-regression 未同步固定 EXPECTED 清单和 smoke 注册，没有执行应用用例。补齐两项注册与专项说明，保留全部原集合和断言，修订后重新执行三端 browser/native。
