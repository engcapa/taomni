# P0→P5 大文件拆分汇总与 Top 30

统计日期：2026-10-22。

- 重构前：`f3e375ebdeb63e8dad0af807dddf8c475142edf8`。
- 重构后：`9d23fcc332d4e4b78e39cc4e49d2a2ee51bde9cc`（P0→P5 最终验收文档提交）。
- 本报告及配套两份 TSV 是随后新增的统计文档，不计入本报告的新增文件数。

## 统计口径

行数直接读取两端 Git blob，以换行分隔的物理行为准，包含注释和空行，文件末尾换行不额外增加一行。旧基线清单用另一种算法把末尾换行多计了一行，因此这里拆分前的数字通常比旧文档少 1；例如 CodeWorkspaceTab 是 **23,913 → 152**，旧清单写作 23,914。5 个保留的声明/生成文件前后 blob 完全相同。

产品统计范围为 `src/`、`src-tauri/src/`、`src-tauri/tests/`、`scripts/`、`vite-plugins/`、`src-tauri/proto/`、`src-tauri/thrift/` 与 `src-tauri/build.rs`；统计扩展名 `.ts/.tsx/.rs/.js/.mjs/.cjs/.py/.css/.c/.proto/.thrift`。这补齐了早期清单遗漏的 11 个 Python 脚本及 10 个 Vite 插件；这些补齐项没有改变旧的大文件集合。资源、依赖目录、vendor、编译产物和 QA 运行工件不计入。

“关联新增”按基线不存在、验收提交仍存在的路径统计，包含实现、类型、拆出的测试与夹具。Git 可以准确核实路径是否新增；一拆多的对应关系则按迁移目录和职责归属整理，不声称是 Git 自动记录的逐行搬移谱系。每个新增路径只归属一个原入口，父领域已扣除独立子域；共享辅助文件按其归属计一次。对应目录中基线已经存在的文件不计为新增。

完整机器可读对照：[195 个原大文件](./refactor-p0-p5-file-splits-20261022.tsv)；[2,023 个新增路径及逐项归属](./refactor-p0-p5-added-files-20261022.tsv)。

## 总量

| 指标 | 重构前 | 重构后/新增 |
| --- | ---: | ---: |
| 同口径产品源码/测试/构建/schema 文件数 | 1,882 | 3,893 |
| 同口径总物理行数 | 748,084 | 796,378 |
| 原超过 800 行的文件 | 195 | 190 个已拆分；5 个声明/生成文件保留 |
| 190 个原入口自身的合计行数 | 367,525 | 28,787 |
| 190 个大文件关联新增的文件 | — | 2,006 |
| AppState 领域状态模块（原文件 321 行） | — | 1 |
| 公共检查脚本与独立集成测试 | — | 4 |
| 产品范围新增源码/测试/构建文件合计 | — | 2,011 |
| QA 工具新增 Python 源码 | — | 6 |
| 新增文档/契约数据及清单 | — | 5 |
| 新增 YAML testcase | — | 1 |
| 全仓新增 Git 文件合计 | — | 2,023 |

**2,011 = 2,006 + 1 + 4；2,023 = 2,011 + 6 + 5 + 1。** 没有删除旧源码路径，原入口保留为 façade、视图编排或测试注册入口。入口行数下降不等于代码总量下降：拆出的代码、显式接口、导入、测试 harness 和原有格式整理都计入总行数。

新增产品源码按目录分布：`src/` 1,087 个、`src-tauri/src/` 920 个、`src-tauri/tests/` 1 个、`scripts/` 3 个。

## 已拆分的全部 190 个大文件

按拆分前行数降序。前后行数针对同一个原入口；“新模块最大行数”针对其关联新增路径。目标目录按所属领域展示，精确的逐文件归属见新增路径 TSV。

| 原文件 | 拆分前 | 原入口现行数 | 关联新增 | 新模块最大行数 | 新模块主要位置 |
| --- | ---: | ---: | ---: | ---: | --- |
| [src/components/editor/CodeWorkspaceTab.tsx](../src/components/editor/CodeWorkspaceTab.tsx) | 23,913 | 152 | 140 | 775 | `workspace/controller/`（32）、`workspace/hooks/`（92）、`workspace/views/`（16） |
| [src/components/editor/CodeWorkspaceTab.test.tsx](../src/components/editor/CodeWorkspaceTab.test.tsx) | 15,209 | 9 | 49 | 767 | `workspace/tests/`（46）与 `editor/tests/codeWorkspaceTab/`（3） |
| [src-tauri/src/lsp.rs](../src-tauri/src/lsp.rs) | 15,199 | 252 | 72 | 625 | `src-tauri/src/lsp/` |
| [src-tauri/src/mail/mod.rs](../src-tauri/src/mail/mod.rs) | 8,264 | 250 | 40 | 593 | `src-tauri/src/mail/` |
| [src/components/mail/MailClientTab.tsx](../src/components/mail/MailClientTab.tsx) | 6,945 | 799 | 58 | 614 | `src/components/mail/client/` |
| [src-tauri/src/workspace.rs](../src-tauri/src/workspace.rs) | 5,596 | 484 | 19 | 644 | `src-tauri/src/workspace/` |
| [src/stubs/tauri-core.ts](../src/stubs/tauri-core.ts) | 5,457 | 134 | 27 | 703 | `src/stubs/commands/`、`src/stubs/tauri-core.test.ts` |
| [src/components/session/SessionEditor.tsx](../src/components/session/SessionEditor.tsx) | 5,295 | 51 | 24 | 769 | `src/components/session/editor/` |
| [src/layouts/MainLayout.tsx](../src/layouts/MainLayout.tsx) | 5,204 | 64 | 37 | 570 | `src/layouts/main/` |
| [src/components/terminal/TerminalPanel.tsx](../src/components/terminal/TerminalPanel.tsx) | 5,149 | 150 | 30 | 518 | `src/components/terminal/panel/` |
| [src/components/editor/workspace/CodeMirrorHost.tsx](../src/components/editor/workspace/CodeMirrorHost.tsx) | 4,718 | 586 | 21 | 749 | `src/components/editor/workspace/host/` |
| [src-tauri/src/workspace_execution.rs](../src-tauri/src/workspace_execution.rs) | 4,694 | 438 | 15 | 776 | `src-tauri/src/workspace_execution/` |
| [src/components/sockscap/SocksCapPanel.tsx](../src/components/sockscap/SocksCapPanel.tsx) | 4,284 | 574 | 24 | 706 | `src/components/sockscap/panel/` |
| [src/lib/sessionImportExport.ts](../src/lib/sessionImportExport.ts) | 3,867 | 22 | 11 | 783 | `src/lib/sessionImportExport/` |
| [src/components/database/DbClientTab.tsx](../src/components/database/DbClientTab.tsx) | 3,765 | 628 | 26 | 580 | `src/components/database/client/` |
| [src-tauri/src/screenshot/qa.rs](../src-tauri/src/screenshot/qa.rs) | 3,758 | 161 | 8 | 774 | `src-tauri/src/screenshot/qa/` |
| [src-tauri/src/rdp/session.rs](../src-tauri/src/rdp/session.rs) | 3,726 | 256 | 20 | 471 | `src-tauri/src/rdp/session/` |
| [src-tauri/src/sockscap/mod.rs](../src-tauri/src/sockscap/mod.rs) | 3,691 | 279 | 16 | 534 | `src-tauri/src/sockscap/` |
| [src-tauri/src/chat/mod.rs](../src-tauri/src/chat/mod.rs) | 3,556 | 468 | 14 | 737 | `src-tauri/src/chat/` |
| [src/components/database/QueryResultGrid.tsx](../src/components/database/QueryResultGrid.tsx) | 3,515 | 417 | 15 | 743 | `src/components/database/grid/` |
| [src/components/editor/workspace/useCodeDebugSession.ts](../src/components/editor/workspace/useCodeDebugSession.ts) | 3,312 | 697 | 13 | 636 | `src/components/editor/workspace/debug/` |
| [src/components/terminal/TerminalPanel.test.tsx](../src/components/terminal/TerminalPanel.test.tsx) | 3,199 | 69 | 9 | 481 | `src/components/terminal/tests/terminalPanel/` |
| [src-tauri/src/git.rs](../src-tauri/src/git.rs) | 2,878 | 255 | 12 | 583 | `src-tauri/src/git/` |
| [src-tauri/src/vnc/rfb.rs](../src-tauri/src/vnc/rfb.rs) | 2,694 | 75 | 13 | 659 | `src-tauri/src/vnc/rfb/` |
| [src-tauri/src/database/sql.rs](../src-tauri/src/database/sql.rs) | 2,643 | 61 | 9 | 537 | `src-tauri/src/database/sql/` |
| [src-tauri/src/vnc/ws.rs](../src-tauri/src/vnc/ws.rs) | 2,594 | 357 | 8 | 738 | `src-tauri/src/vnc/ws/` |
| [src-tauri/src/hbase/mod.rs](../src-tauri/src/hbase/mod.rs) | 2,537 | 308 | 13 | 390 | `src-tauri/src/hbase/` |
| [src/components/git/WorkspaceGitManager.tsx](../src/components/git/WorkspaceGitManager.tsx) | 2,499 | 416 | 13 | 347 | `src/components/git/workspace/` |
| [src/components/editor/workspace/CodeMirrorHost.test.tsx](../src/components/editor/workspace/CodeMirrorHost.test.tsx) | 2,452 | 29 | 9 | 461 | `src/components/editor/workspace/tests/codeMirrorHost/` |
| [src/components/editor/workspace/lspCompletion.ts](../src/components/editor/workspace/lspCompletion.ts) | 2,428 | 112 | 12 | 498 | `src/components/editor/workspace/completion/` |
| [src-tauri/src/rdp/gateway/mod.rs](../src-tauri/src/rdp/gateway/mod.rs) | 2,222 | 72 | 10 | 650 | `src-tauri/src/rdp/gateway/` |
| [src/components/editor/workspace/useCodeDebugSession.test.tsx](../src/components/editor/workspace/useCodeDebugSession.test.tsx) | 2,215 | 28 | 6 | 486 | `src/components/editor/workspace/tests/useCodeDebugSession/` |
| [src-tauri/src/bin/sockscap-helper/capture.rs](../src-tauri/src/bin/sockscap-helper/capture.rs) | 2,177 | 28 | 13 | 397 | `src-tauri/src/bin/sockscap-helper/capture/` |
| [src-tauri/src/agent/cc_bridge/mcp_http.rs](../src-tauri/src/agent/cc_bridge/mcp_http.rs) | 2,131 | 64 | 9 | 541 | `src-tauri/src/agent/cc_bridge/mcp_http/` |
| [src/lib/ipc.ts](../src/lib/ipc.ts) | 2,113 | 297 | 20 | 426 | `src/lib/ipc/` |
| [src/components/WelcomePanel.tsx](../src/components/WelcomePanel.tsx) | 2,075 | 321 | 11 | 368 | `src/components/welcome/` |
| [src/components/git/GitPanel.tsx](../src/components/git/GitPanel.tsx) | 2,075 | 573 | 10 | 629 | `src/components/git/panel/` |
| [src/layouts/MainLayout.test.tsx](../src/layouts/MainLayout.test.tsx) | 2,073 | 93 | 5 | 523 | `src/layouts/tests/mainLayout/` |
| [src/components/editor/workspace/lspCompletion.test.ts](../src/components/editor/workspace/lspCompletion.test.ts) | 2,068 | 25 | 8 | 464 | `src/components/editor/workspace/tests/lspCompletion/` |
| [src/components/vnc/VncPanel.tsx](../src/components/vnc/VncPanel.tsx) | 2,068 | 791 | 12 | 546 | `src/components/vnc/panel/` |
| [src-tauri/src/screenshot/mod.rs](../src-tauri/src/screenshot/mod.rs) | 2,024 | 277 | 17 | 377 | `src-tauri/src/screenshot/` |
| [src/components/sidebar/SessionTree.tsx](../src/components/sidebar/SessionTree.tsx) | 1,963 | 399 | 10 | 354 | `src/components/sidebar/sessionTree/` |
| [src/index.css](../src/index.css) | 1,936 | 26 | 12 | 309 | `src/styles/` |
| [src-tauri/src/database/presto.rs](../src-tauri/src/database/presto.rs) | 1,920 | 36 | 9 | 762 | `src-tauri/src/database/presto/` |
| [src-tauri/src/sdk/detect.rs](../src-tauri/src/sdk/detect.rs) | 1,889 | 32 | 12 | 384 | `src-tauri/src/sdk/detect/` |
| [src/components/mail/MailClientTab.test.tsx](../src/components/mail/MailClientTab.test.tsx) | 1,887 | 129 | 5 | 496 | `src/components/mail/tests/mailClientTab/` |
| [src-tauri/src/agent/acp_bridge/protocol.rs](../src-tauri/src/agent/acp_bridge/protocol.rs) | 1,874 | 45 | 8 | 583 | `src-tauri/src/agent/acp_bridge/protocol/` |
| [src-tauri/src/servers/ssh.rs](../src-tauri/src/servers/ssh.rs) | 1,874 | 53 | 10 | 494 | `src-tauri/src/servers/ssh/` |
| [src-tauri/src/screenshot/scroll.rs](../src-tauri/src/screenshot/scroll.rs) | 1,795 | 45 | 10 | 604 | `src-tauri/src/screenshot/scroll/` |
| [src/components/screenshot/ScreenshotOverlay.tsx](../src/components/screenshot/ScreenshotOverlay.tsx) | 1,747 | 114 | 13 | 350 | `src/components/screenshot/overlay/` |
| [src/components/editor/workspace/dapDebugModel.ts](../src/components/editor/workspace/dapDebugModel.ts) | 1,735 | 130 | 8 | 459 | `src/components/editor/workspace/debug/model/` |
| [src/components/editor/workspace/__fixtures__/jdtls/runner/run-jdtls-fixture.mjs](../src/components/editor/workspace/__fixtures__/jdtls/runner/run-jdtls-fixture.mjs) | 1,728 | 67 | 11 | 462 | `src/components/editor/workspace/__fixtures__/jdtls/runner/` |
| [src/components/editor/workspace/rearrangeCleanupWorkflow.ts](../src/components/editor/workspace/rearrangeCleanupWorkflow.ts) | 1,718 | 65 | 7 | 435 | `src/components/editor/workspace/workflow/` |
| [src/components/session/SessionEditor.test.tsx](../src/components/session/SessionEditor.test.tsx) | 1,713 | 78 | 5 | 481 | `src/components/session/tests/sessionEditor/` |
| [src-tauri/src/servers/rdp/clipboard.rs](../src-tauri/src/servers/rdp/clipboard.rs) | 1,709 | 54 | 11 | 395 | `src-tauri/src/servers/rdp/clipboard/` |
| [src-tauri/src/servers/rdp/display.rs](../src-tauri/src/servers/rdp/display.rs) | 1,698 | 35 | 8 | 461 | `src-tauri/src/servers/rdp/display/` |
| [src-tauri/src/structural_search.rs](../src-tauri/src/structural_search.rs) | 1,654 | 51 | 9 | 488 | `src-tauri/src/structural_search/` |
| [src-tauri/src/config/mod.rs](../src-tauri/src/config/mod.rs) | 1,646 | 77 | 9 | 377 | `src-tauri/src/config/` |
| [src/components/editor/workspace/workspaceActionRegistry.ts](../src/components/editor/workspace/workspaceActionRegistry.ts) | 1,644 | 23 | 14 | 409 | `src/components/editor/workspace/commands/` |
| [src/components/editor/workspace/rearrangeCleanupWorkflow.test.ts](../src/components/editor/workspace/rearrangeCleanupWorkflow.test.ts) | 1,641 | 16 | 6 | 482 | `src/components/editor/workspace/tests/rearrangeCleanupWorkflow/` |
| [src/stores/appStore.ts](../src/stores/appStore.ts) | 1,641 | 68 | 11 | 335 | `src/stores/app/` |
| [src/components/chat/ChatDrawer.tsx](../src/components/chat/ChatDrawer.tsx) | 1,619 | 603 | 5 | 757 | `src/components/chat/drawer/` |
| [src/lib/sessionImportExport.test.ts](../src/lib/sessionImportExport.test.ts) | 1,590 | 21 | 7 | 491 | `src/lib/tests/sessionImportExport/` |
| [src-tauri/src/mail/sync.rs](../src-tauri/src/mail/sync.rs) | 1,579 | 56 | 8 | 597 | `src-tauri/src/mail/sync/` |
| [src/components/editor/workspace/codeWorkspaceModel.ts](../src/components/editor/workspace/codeWorkspaceModel.ts) | 1,577 | 162 | 12 | 291 | `src/components/editor/workspace/model/` |
| [src/components/git/DiffViewer.tsx](../src/components/git/DiffViewer.tsx) | 1,576 | 498 | 7 | 525 | `src/components/git/diff/` |
| [src/lib/editor/lsp.ts](../src/lib/editor/lsp.ts) | 1,569 | 153 | 11 | 689 | `src/lib/editor/lsp/` |
| [src-tauri/src/rdp/rdpdr.rs](../src-tauri/src/rdp/rdpdr.rs) | 1,565 | 52 | 10 | 280 | `src-tauri/src/rdp/rdpdr/` |
| [src-tauri/src/sockscap/capture/linux/tracer.rs](../src-tauri/src/sockscap/capture/linux/tracer.rs) | 1,546 | 33 | 10 | 423 | `src-tauri/src/sockscap/capture/linux/tracer/` |
| [src/components/editor/workspace/refactorPlan.ts](../src/components/editor/workspace/refactorPlan.ts) | 1,522 | 60 | 6 | 431 | `src/components/editor/workspace/refactor/` |
| [src-tauri/src/agent/cc_bridge/mcp_control.rs](../src-tauri/src/agent/cc_bridge/mcp_control.rs) | 1,517 | 22 | 8 | 712 | `src-tauri/src/agent/cc_bridge/mcp_control/` |
| [src/components/editor/workspace/CodeMirrorHost.live-template-interaction.test.tsx](../src/components/editor/workspace/CodeMirrorHost.live-template-interaction.test.tsx) | 1,503 | 52 | 5 | 456 | `src/components/editor/workspace/tests/codeMirrorHost.live-template-interaction/` |
| [src/components/editor/workspace/workspaceActionHost.ts](../src/components/editor/workspace/workspaceActionHost.ts) | 1,482 | 22 | 21 | 591 | `src/components/editor/workspace/actions/` |
| [src/components/editor/workspace/liveTemplates.ts](../src/components/editor/workspace/liveTemplates.ts) | 1,475 | 17 | 14 | 312 | `src/components/editor/workspace/templates/` |
| [src-tauri/src/terminal/local_directories.rs](../src-tauri/src/terminal/local_directories.rs) | 1,464 | 55 | 9 | 372 | `src-tauri/src/terminal/local_directories/` |
| [src-tauri/src/asr/models.rs](../src-tauri/src/asr/models.rs) | 1,458 | 63 | 8 | 536 | `src-tauri/src/asr/models/` |
| [src-tauri/src/lanchat/swarm.rs](../src-tauri/src/lanchat/swarm.rs) | 1,457 | 49 | 11 | 351 | `src-tauri/src/lanchat/swarm/` |
| [src/components/editor/workspace/replaceInFilesModel.test.ts](../src/components/editor/workspace/replaceInFilesModel.test.ts) | 1,454 | 57 | 6 | 385 | `src/components/editor/workspace/tests/replaceInFilesModel/` |
| [src-tauri/src/mail/filters.rs](../src-tauri/src/mail/filters.rs) | 1,450 | 61 | 9 | 353 | `src-tauri/src/mail/filters/` |
| [src/components/editor/workspace/refactorPlan.test.ts](../src/components/editor/workspace/refactorPlan.test.ts) | 1,443 | 13 | 5 | 503 | `src/components/editor/workspace/tests/refactorPlan/` |
| [src/components/database/DbClientTab.test.tsx](../src/components/database/DbClientTab.test.tsx) | 1,420 | 29 | 4 | 474 | `src/components/database/tests/dbClientTab/` |
| [src-tauri/src/database/mod.rs](../src-tauri/src/database/mod.rs) | 1,411 | 166 | 10 | 340 | `src-tauri/src/database/` |
| [src/components/database/HBaseShellTab.tsx](../src/components/database/HBaseShellTab.tsx) | 1,399 | 323 | 6 | 457 | `src/components/database/hbase/` |
| [src/components/editor/workspace/workspaceEditApply.test.ts](../src/components/editor/workspace/workspaceEditApply.test.ts) | 1,394 | 11 | 4 | 483 | `src/components/editor/workspace/tests/workspaceEditApply/` |
| [src-tauri/src/lanchat/store.rs](../src-tauri/src/lanchat/store.rs) | 1,384 | 41 | 11 | 368 | `src-tauri/src/lanchat/store/` |
| [src/components/editor/workspace/workspaceVirtualSpace.test.ts](../src/components/editor/workspace/workspaceVirtualSpace.test.ts) | 1,381 | 17 | 6 | 458 | `src/components/editor/workspace/tests/workspaceVirtualSpace/` |
| [src-tauri/src/mail/archive.rs](../src-tauri/src/mail/archive.rs) | 1,377 | 41 | 7 | 501 | `src-tauri/src/mail/archive/` |
| [src-tauri/src/vnc/encodings.rs](../src-tauri/src/vnc/encodings.rs) | 1,374 | 29 | 7 | 537 | `src-tauri/src/vnc/encodings/` |
| [src-tauri/src/bin/rdp-probe/scenarios.rs](../src-tauri/src/bin/rdp-probe/scenarios.rs) | 1,365 | 27 | 10 | 297 | `src-tauri/src/bin/rdp-probe/scenarios/` |
| [src-tauri/src/sockscap/capture/linux/launched.rs](../src-tauri/src/sockscap/capture/linux/launched.rs) | 1,364 | 27 | 7 | 712 | `src-tauri/src/sockscap/capture/linux/launched/` |
| [src/components/editor/workspace/panels/FindInFilesPanel.test.tsx](../src/components/editor/workspace/panels/FindInFilesPanel.test.tsx) | 1,363 | 54 | 5 | 418 | `src/components/editor/workspace/panels/tests/findInFilesPanel/` |
| [src-tauri/src/servers/rdp/gfx.rs](../src-tauri/src/servers/rdp/gfx.rs) | 1,361 | 34 | 6 | 424 | `src-tauri/src/servers/rdp/gfx/` |
| [src-tauri/src/lib.rs](../src-tauri/src/lib.rs) | 1,353 | 592 | 51 | 807 | `src-tauri/src/commands/` |
| [src/components/editor/workspace/panels/FindInFilesPanel.tsx](../src/components/editor/workspace/panels/FindInFilesPanel.tsx) | 1,344 | 526 | 6 | 509 | `src/components/editor/workspace/panels/findInFiles/` |
| [src-tauri/src/servers/rdp/input.rs](../src-tauri/src/servers/rdp/input.rs) | 1,314 | 61 | 10 | 246 | `src-tauri/src/servers/rdp/input/` |
| [src/components/editor/workspace/panels/DebugPanel.test.tsx](../src/components/editor/workspace/panels/DebugPanel.test.tsx) | 1,306 | 13 | 4 | 481 | `src/components/editor/workspace/panels/tests/debugPanel/` |
| [src/stores/chatStore.ts](../src/stores/chatStore.ts) | 1,306 | 33 | 11 | 338 | `src/stores/chat/` |
| [src-tauri/src/notes/db.rs](../src-tauri/src/notes/db.rs) | 1,299 | 54 | 11 | 423 | `src-tauri/src/notes/db/` |
| [src/components/agent/CcAgentBridge.tsx](../src/components/agent/CcAgentBridge.tsx) | 1,296 | 349 | 9 | 252 | `src/components/agent/bridge/` |
| [src-tauri/src/objectstorage/s3.rs](../src-tauri/src/objectstorage/s3.rs) | 1,291 | 27 | 10 | 391 | `src-tauri/src/objectstorage/s3/` |
| [src-tauri/src/terminal/mod.rs](../src-tauri/src/terminal/mod.rs) | 1,277 | 143 | 9 | 331 | `src-tauri/src/terminal/` |
| [src/components/sockscap/SocksCapPanel.test.tsx](../src/components/sockscap/SocksCapPanel.test.tsx) | 1,273 | 97 | 4 | 491 | `src/components/sockscap/tests/socksCapPanel/` |
| [src-tauri/src/screenshot/record.rs](../src-tauri/src/screenshot/record.rs) | 1,255 | 47 | 9 | 308 | `src-tauri/src/screenshot/record/` |
| [src/components/editor/workspace/EditorGroup.tsx](../src/components/editor/workspace/EditorGroup.tsx) | 1,251 | 654 | 4 | 255 | `src/components/editor/workspace/group/` |
| [src/components/filebrowser/FileBrowser.tsx](../src/components/filebrowser/FileBrowser.tsx) | 1,248 | 373 | 7 | 503 | `src/components/filebrowser/browser/` |
| [src/components/database/SchemaTree.tsx](../src/components/database/SchemaTree.tsx) | 1,247 | 386 | 5 | 619 | `src/components/database/schema/` |
| [src/components/editor/workspace/recursiveLayoutTree.ts](../src/components/editor/workspace/recursiveLayoutTree.ts) | 1,237 | 34 | 8 | 352 | `src/components/editor/workspace/layoutTree/` |
| [src-tauri/src/mail/contacts.rs](../src-tauri/src/mail/contacts.rs) | 1,236 | 49 | 8 | 409 | `src-tauri/src/mail/contacts/` |
| [src-tauri/src/sockscap/redirector/runtime.rs](../src-tauri/src/sockscap/redirector/runtime.rs) | 1,233 | 26 | 9 | 317 | `src-tauri/src/sockscap/redirector/runtime/` |
| [src-tauri/src/dap.rs](../src-tauri/src/dap.rs) | 1,232 | 42 | 7 | 312 | `src-tauri/src/dap/` |
| [src/components/editor/workspace/workspaceEditorCommands.ts](../src/components/editor/workspace/workspaceEditorCommands.ts) | 1,224 | 59 | 9 | 305 | `src/components/editor/workspace/editorCommands/` |
| [src/components/editor/workspace/codeActionProviderAdapter.ts](../src/components/editor/workspace/codeActionProviderAdapter.ts) | 1,214 | 28 | 5 | 643 | `src/components/editor/workspace/codeActions/` |
| [src-tauri/src/lanchat/transport.rs](../src-tauri/src/lanchat/transport.rs) | 1,205 | 32 | 8 | 441 | `src-tauri/src/lanchat/transport/` |
| [src/components/screenshot/AnnotationCanvas.tsx](../src/components/screenshot/AnnotationCanvas.tsx) | 1,193 | 593 | 5 | 264 | `src/components/screenshot/annotation/` |
| [src/components/editor/workspace/codeActionProviderAdapter.test.ts](../src/components/editor/workspace/codeActionProviderAdapter.test.ts) | 1,176 | 19 | 7 | 365 | `src/components/editor/workspace/tests/codeActionProviderAdapter/` |
| [src-tauri/src/hbase/native/client.rs](../src-tauri/src/hbase/native/client.rs) | 1,169 | 36 | 11 | 225 | `src-tauri/src/hbase/native/client/` |
| [src/stores/codeWorkspaceStore.ts](../src/stores/codeWorkspaceStore.ts) | 1,165 | 40 | 8 | 357 | `src/stores/codeWorkspace/` |
| [src/stores/chatStore.test.ts](../src/stores/chatStore.test.ts) | 1,152 | 10 | 4 | 465 | `src/stores/tests/chatStore/` |
| [src-tauri/src/screenshot/capture.rs](../src-tauri/src/screenshot/capture.rs) | 1,140 | 116 | 8 | 242 | `src-tauri/src/screenshot/capture/` |
| [src/components/rdp/RdpPanel.tsx](../src/components/rdp/RdpPanel.tsx) | 1,127 | 208 | 6 | 513 | `src/components/rdp/panel/` |
| [src-tauri/src/database/sql_rewrite.rs](../src-tauri/src/database/sql_rewrite.rs) | 1,113 | 25 | 7 | 286 | `src-tauri/src/database/sql_rewrite/` |
| [src/components/editor/workspace/editorSearchPanel.ts](../src/components/editor/workspace/editorSearchPanel.ts) | 1,071 | 16 | 6 | 528 | `src/components/editor/workspace/searchPanel/` |
| [src/components/editor/workspace/KeymapSettingsDialog.tsx](../src/components/editor/workspace/KeymapSettingsDialog.tsx) | 1,066 | 470 | 4 | 546 | `src/components/editor/workspace/keymapSettings/` |
| [src-tauri/src/filebrowser/sftp.rs](../src-tauri/src/filebrowser/sftp.rs) | 1,061 | 94 | 9 | 275 | `src-tauri/src/filebrowser/sftp/` |
| [src-tauri/src/sockscap/relay.rs](../src-tauri/src/sockscap/relay.rs) | 1,061 | 38 | 8 | 343 | `src-tauri/src/sockscap/relay/` |
| [src-tauri/src/rdp/ws.rs](../src-tauri/src/rdp/ws.rs) | 1,057 | 49 | 6 | 329 | `src-tauri/src/rdp/ws/` |
| [src-tauri/src/agent/acp_bridge/process.rs](../src-tauri/src/agent/acp_bridge/process.rs) | 1,051 | 26 | 9 | 315 | `src-tauri/src/agent/acp_bridge/process/` |
| [src-tauri/src/objectstorage/azure.rs](../src-tauri/src/objectstorage/azure.rs) | 1,048 | 28 | 8 | 227 | `src-tauri/src/objectstorage/azure/` |
| [src-tauri/src/agent/cc_bridge/mcp_sql.rs](../src-tauri/src/agent/cc_bridge/mcp_sql.rs) | 1,047 | 33 | 8 | 546 | `src-tauri/src/agent/cc_bridge/mcp_sql/` |
| [src-tauri/src/terminal/pty.rs](../src-tauri/src/terminal/pty.rs) | 1,046 | 37 | 8 | 243 | `src-tauri/src/terminal/pty/` |
| [src-tauri/src/database/panwei.rs](../src-tauri/src/database/panwei.rs) | 1,039 | 29 | 7 | 268 | `src-tauri/src/database/panwei/` |
| [src-tauri/src/voice/streaming.rs](../src-tauri/src/voice/streaming.rs) | 1,039 | 60 | 6 | 264 | `src-tauri/src/voice/streaming/` |
| [src/components/filebrowser/FilePanel.tsx](../src/components/filebrowser/FilePanel.tsx) | 1,036 | 298 | 7 | 492 | `src/components/filebrowser/filePanel/` |
| [src-tauri/src/chat/acp.rs](../src-tauri/src/chat/acp.rs) | 1,031 | 18 | 6 | 344 | `src-tauri/src/chat/acp/` |
| [src/stores/appStore.test.ts](../src/stores/appStore.test.ts) | 1,025 | 10 | 4 | 377 | `src/stores/tests/appStore/` |
| [src-tauri/src/terminal/ssh.rs](../src-tauri/src/terminal/ssh.rs) | 1,014 | 21 | 5 | 276 | `src-tauri/src/terminal/ssh/` |
| [src/lib/mailHtml.ts](../src/lib/mailHtml.ts) | 1,003 | 27 | 7 | 381 | `src/lib/mailHtml/` |
| [src/lib/sqlMetadataCompletions.ts](../src/lib/sqlMetadataCompletions.ts) | 1,002 | 7 | 12 | 180 | `src/lib/sqlMetadataCompletions/` |
| [src-tauri/src/ai/config.rs](../src-tauri/src/ai/config.rs) | 996 | 31 | 7 | 344 | `src-tauri/src/ai/config/` |
| [src-tauri/src/servers/rdp/capture/x11.rs](../src-tauri/src/servers/rdp/capture/x11.rs) | 988 | 48 | 7 | 275 | `src-tauri/src/servers/rdp/capture/x11/` |
| [src-tauri/src/sdk/mod.rs](../src-tauri/src/sdk/mod.rs) | 974 | 89 | 6 | 348 | `src-tauri/src/sdk/` |
| [src-tauri/src/session/import.rs](../src-tauri/src/session/import.rs) | 974 | 34 | 8 | 222 | `src-tauri/src/session/import/` |
| [src/components/vnc/VncPanel.test.tsx](../src/components/vnc/VncPanel.test.tsx) | 971 | 10 | 4 | 351 | `src/components/vnc/tests/vncPanel/` |
| [src-tauri/src/tunnel/mod.rs](../src-tauri/src/tunnel/mod.rs) | 966 | 61 | 9 | 232 | `src-tauri/src/tunnel/` |
| [src/components/editor/workspace/dapDebugModel.test.ts](../src/components/editor/workspace/dapDebugModel.test.ts) | 963 | 9 | 3 | 513 | `src/components/editor/workspace/tests/dapDebugModel/` |
| [src-tauri/src/qa_driver.rs](../src-tauri/src/qa_driver.rs) | 962 | 26 | 9 | 233 | `src-tauri/src/qa_driver/` |
| [src-tauri/src/agent/context.rs](../src-tauri/src/agent/context.rs) | 959 | 27 | 8 | 209 | `src-tauri/src/agent/context/` |
| [src-tauri/src/mail/storage.rs](../src-tauri/src/mail/storage.rs) | 949 | 41 | 7 | 280 | `src-tauri/src/mail/storage/` |
| [src/components/editor/workspace/panels/RunPanel.tsx](../src/components/editor/workspace/panels/RunPanel.tsx) | 944 | 276 | 4 | 378 | `src/components/editor/workspace/panels/run/` |
| [src-tauri/src/servers/rdp.rs](../src-tauri/src/servers/rdp.rs) | 941 | 151 | 6 | 315 | `src-tauri/src/servers/rdp/` |
| [src/components/tabbar/TabBar.tsx](../src/components/tabbar/TabBar.tsx) | 941 | 608 | 3 | 262 | `src/components/tabbar/tabs/` |
| [src-tauri/src/mail/pop3.rs](../src-tauri/src/mail/pop3.rs) | 939 | 160 | 5 | 310 | `src-tauri/src/mail/pop3/` |
| [src/components/filebrowser/FileToolbarWiring.test.tsx](../src/components/filebrowser/FileToolbarWiring.test.tsx) | 936 | 24 | 3 | 506 | `src/components/filebrowser/tests/fileToolbarWiring/` |
| [src/components/editor/workspace/workspaceCodeMirrorKeymap.ts](../src/components/editor/workspace/workspaceCodeMirrorKeymap.ts) | 935 | 16 | 4 | 599 | `src/components/editor/workspace/keymap/` |
| [src/components/settings/SettingsPanel.tsx](../src/components/settings/SettingsPanel.tsx) | 933 | 277 | 3 | 616 | `src/components/settings/panel/` |
| [src/components/editor/workspace/useWorkspaceLspSession.ts](../src/components/editor/workspace/useWorkspaceLspSession.ts) | 927 | 5 | 4 | 771 | `src/components/editor/workspace/lspSession/` |
| [src/stores/aiStore.ts](../src/stores/aiStore.ts) | 926 | 248 | 5 | 261 | `src/stores/ai/` |
| [src/components/tunnel/TunnelManager.tsx](../src/components/tunnel/TunnelManager.tsx) | 924 | 489 | 3 | 279 | `src/components/tunnel/manager/` |
| [src/stores/sftpStore.ts](../src/stores/sftpStore.ts) | 921 | 680 | 3 | 142 | `src/stores/sftp/` |
| [src-tauri/src/sdk/runtime.rs](../src-tauri/src/sdk/runtime.rs) | 916 | 18 | 7 | 376 | `src-tauri/src/sdk/runtime/` |
| [src/lib/mail.ts](../src/lib/mail.ts) | 909 | 121 | 8 | 501 | `src/lib/mail/` |
| [src-tauri/src/servers/rdp/capture/wayland.rs](../src-tauri/src/servers/rdp/capture/wayland.rs) | 907 | 28 | 8 | 311 | `src-tauri/src/servers/rdp/capture/wayland/` |
| [src/components/chat/ChatDrawer.test.tsx](../src/components/chat/ChatDrawer.test.tsx) | 905 | 10 | 4 | 368 | `src/components/chat/tests/chatDrawer/` |
| [src-tauri/src/bin/rdp-probe/session.rs](../src-tauri/src/bin/rdp-probe/session.rs) | 902 | 28 | 8 | 168 | `src-tauri/src/bin/rdp-probe/session/` |
| [src/components/settings/BackupSettingsPanel.tsx](../src/components/settings/BackupSettingsPanel.tsx) | 902 | 301 | 1 | 716 | `src/components/settings/backup/` |
| [src/components/lanchat/LanChatPanel.tsx](../src/components/lanchat/LanChatPanel.tsx) | 901 | 376 | 5 | 191 | `src/components/lanchat/panel/` |
| [src-tauri/src/session/resume.rs](../src-tauri/src/session/resume.rs) | 896 | 51 | 8 | 381 | `src-tauri/src/session/resume/` |
| [src/components/editor/workspace/Breadcrumbs.tsx](../src/components/editor/workspace/Breadcrumbs.tsx) | 895 | 437 | 3 | 296 | `src/components/editor/workspace/breadcrumbs/` |
| [src/components/WelcomePanel.test.tsx](../src/components/WelcomePanel.test.tsx) | 893 | 7 | 3 | 414 | `src/components/tests/welcomePanel/` |
| [src/lib/editor/workspace.ts](../src/lib/editor/workspace.ts) | 893 | 71 | 9 | 277 | `src/lib/editor/workspace/` |
| [src-tauri/src/terminal/network.rs](../src-tauri/src/terminal/network.rs) | 889 | 25 | 6 | 421 | `src-tauri/src/terminal/network/` |
| [src/components/editor/workspace/panels/debug/BreakpointsView.tsx](../src/components/editor/workspace/panels/debug/BreakpointsView.tsx) | 887 | 140 | 4 | 308 | `src/components/editor/workspace/panels/debug/breakpoints/` |
| [src-tauri/src/sockscap/helper.rs](../src-tauri/src/sockscap/helper.rs) | 882 | 45 | 8 | 371 | `src-tauri/src/sockscap/helper/` |
| [src-tauri/src/sockscap/config.rs](../src-tauri/src/sockscap/config.rs) | 881 | 32 | 8 | 218 | `src-tauri/src/sockscap/config/` |
| [src/components/editor/workspace/workspaceEditApply.ts](../src/components/editor/workspace/workspaceEditApply.ts) | 875 | 24 | 5 | 225 | `src/components/editor/workspace/editApply/` |
| [src/components/editor/workspace/replaceInFilesModel.ts](../src/components/editor/workspace/replaceInFilesModel.ts) | 871 | 39 | 7 | 181 | `src/components/editor/workspace/replaceModel/` |
| [src-tauri/src/lanchat/commands.rs](../src-tauri/src/lanchat/commands.rs) | 868 | 115 | 8 | 197 | `src-tauri/src/lanchat/commands/` |
| [src-tauri/src/llm/router.rs](../src-tauri/src/llm/router.rs) | 868 | 19 | 5 | 255 | `src-tauri/src/llm/router/` |
| [src/components/editor/workspace/workspaceTabPolicy.ts](../src/components/editor/workspace/workspaceTabPolicy.ts) | 853 | 30 | 6 | 267 | `src/components/editor/workspace/tabPolicy/` |
| [src-tauri/src/servers/mod.rs](../src-tauri/src/servers/mod.rs) | 850 | 127 | 8 | 234 | `src-tauri/src/servers/` |
| [src/components/editor/workspace/useWorkspaceLspSession.test.tsx](../src/components/editor/workspace/useWorkspaceLspSession.test.tsx) | 842 | 25 | 3 | 465 | `src/components/editor/workspace/tests/useWorkspaceLspSession/` |
| [src/components/git/WorkspaceGitManager.test.tsx](../src/components/git/WorkspaceGitManager.test.tsx) | 826 | 92 | 3 | 474 | `src/components/git/tests/workspaceGitManager/` |
| [src/components/editor/workspace/workspaceClipboardSession.ts](../src/components/editor/workspace/workspaceClipboardSession.ts) | 825 | 51 | 5 | 370 | `src/components/editor/workspace/clipboardSession/` |
| [src/components/terminal/TerminalAppearanceSettings.tsx](../src/components/terminal/TerminalAppearanceSettings.tsx) | 825 | 600 | 4 | 97 | `src/components/terminal/appearance/` |
| [src-tauri/src/mail/fake_imap.rs](../src-tauri/src/mail/fake_imap.rs) | 823 | 20 | 4 | 498 | `src-tauri/src/mail/fake_imap/` |
| [src/components/git/WorkspaceChangesView.tsx](../src/components/git/WorkspaceChangesView.tsx) | 823 | 269 | 5 | 246 | `src/components/git/changes/` |
| [src/lib/vnc.ts](../src/lib/vnc.ts) | 821 | 45 | 7 | 148 | `src/lib/vnc/` |
| [src/components/editor/workspace/workspaceVirtualSpace.ts](../src/components/editor/workspace/workspaceVirtualSpace.ts) | 812 | 53 | 7 | 359 | `src/components/editor/workspace/virtualSpace/` |
| [src-tauri/src/servers/rdp/capture/mac/sck.rs](../src-tauri/src/servers/rdp/capture/mac/sck.rs) | 809 | 155 | 6 | 216 | `src-tauri/src/servers/rdp/capture/mac/sck/` |
| [src/components/settings/LanguageServersSettings.tsx](../src/components/settings/LanguageServersSettings.tsx) | 801 | 677 | 1 | 115 | `src/components/settings/languageServers/` |

## 保留的 5 个原大文件与 1 个新增规模例外

| 文件 | 拆分前 | 当前 | 处理原因 |
| --- | ---: | ---: | --- |
| [src-tauri/src/hbase/thrift/idl.rs](../src-tauri/src/hbase/thrift/idl.rs) | 14,212 | 14,212 | 生成绑定，保持生成/声明整体性；blob 未变 |
| [src/lib/i18n/locales/en.ts](../src/lib/i18n/locales/en.ts) | 4,365 | 4,365 | 语言字典，保持生成/声明整体性；blob 未变 |
| [src/lib/i18n/locales/zh-CN.ts](../src/lib/i18n/locales/zh-CN.ts) | 4,340 | 4,340 | 语言字典，保持生成/声明整体性；blob 未变 |
| [src-tauri/proto/Master.proto](../src-tauri/proto/Master.proto) | 1,364 | 1,364 | 协议定义，保持生成/声明整体性；blob 未变 |
| [src-tauri/thrift/hbase.thrift](../src-tauri/thrift/hbase.thrift) | 1,031 | 1,031 | 协议定义，保持生成/声明整体性；blob 未变 |
| [src-tauri/src/commands/mod.rs](../src-tauri/src/commands/mod.rs) | 不存在 | 807 | 新增的同构静态 Tauri 命令注册表，已登记规模例外 |

除上述 4 个代码类规模例外（生成 Thrift、两份语言字典、静态命令表）及 2 个协议 schema 外，产品统计范围的手维护源码均在 800 行内。QA/技能工具与 vendor 不属于本轮产品规模门禁范围，见全仓 Top 30；不能据产品检查通过声称这些工具也全部小于 800 行。

## 拆分后全仓 Top 30（含 QA/技能工具）

同一扩展名集合，覆盖 Git 跟踪文件，包含 QA/技能工具、生成代码、字典和协议定义；排除 vendor/依赖与构建产物。行数降序，相同行数按完整路径排序。

| 排名 | 当前行数 | 文件 | 类型/范围 |
| ---: | ---: | --- | --- |
| 1 | 14,212 | [src-tauri/src/hbase/thrift/idl.rs](../src-tauri/src/hbase/thrift/idl.rs) | 生成绑定 |
| 2 | 4,365 | [src/lib/i18n/locales/en.ts](../src/lib/i18n/locales/en.ts) | 语言字典 |
| 3 | 4,340 | [src/lib/i18n/locales/zh-CN.ts](../src/lib/i18n/locales/zh-CN.ts) | 语言字典 |
| 4 | 3,412 | [.agents/skills/qa-ui-auto/scripts/qa_ui_auto/native_steps.py](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/native_steps.py) | QA/技能工具（产品拆分范围外） |
| 5 | 1,490 | [.agents/skills/qa-ui-auto/scripts/tauri_webdriver.py](../.agents/skills/qa-ui-auto/scripts/tauri_webdriver.py) | QA/技能工具（产品拆分范围外） |
| 6 | 1,474 | [.agents/skills/qa-ui-auto/scripts/test_tauri_webdriver.py](../.agents/skills/qa-ui-auto/scripts/test_tauri_webdriver.py) | QA/技能工具（产品拆分范围外） |
| 7 | 1,364 | [src-tauri/proto/Master.proto](../src-tauri/proto/Master.proto) | 协议定义 |
| 8 | 1,114 | [.agents/skills/qa-ui-auto/scripts/qa_ui_auto/runner.py](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/runner.py) | QA/技能工具（产品拆分范围外） |
| 9 | 1,031 | [src-tauri/thrift/hbase.thrift](../src-tauri/thrift/hbase.thrift) | 协议定义 |
| 10 | 945 | [.agents/skills/vnc-realvnc-task/scripts/vnc_native_scenarios.py](../.agents/skills/vnc-realvnc-task/scripts/vnc_native_scenarios.py) | QA/技能工具（产品拆分范围外） |
| 11 | 926 | [.agents/skills/qa-ui-auto/scripts/qa_ui_auto/rdp_steps.py](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/rdp_steps.py) | QA/技能工具（产品拆分范围外） |
| 12 | 896 | [.agents/skills/qa-ui-auto/scripts/qa_ui_auto/mail_fake_server.py](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/mail_fake_server.py) | QA/技能工具（产品拆分范围外） |
| 13 | 889 | [.agents/skills/qa-ui-auto/scripts/editor_baseline_summary.py](../.agents/skills/qa-ui-auto/scripts/editor_baseline_summary.py) | QA/技能工具（产品拆分范围外） |
| 14 | 807 | [src-tauri/src/commands/mod.rs](../src-tauri/src/commands/mod.rs) | 静态注册表（规模例外） |
| 15 | 799 | [src/components/mail/MailClientTab.tsx](../src/components/mail/MailClientTab.tsx) | 前端实现 |
| 16 | 798 | [src-tauri/src/rdp/gateway/ndr.rs](../src-tauri/src/rdp/gateway/ndr.rs) | Rust 实现 |
| 17 | 791 | [src/components/vnc/VncPanel.tsx](../src/components/vnc/VncPanel.tsx) | 前端实现 |
| 18 | 790 | [src-tauri/src/webview_recovery/mod.rs](../src-tauri/src/webview_recovery/mod.rs) | Rust 实现 |
| 19 | 783 | [src/lib/sessionImportExport/database.ts](../src/lib/sessionImportExport/database.ts) | 前端实现 |
| 20 | 782 | [src-tauri/src/backup/engine.rs](../src-tauri/src/backup/engine.rs) | Rust 实现 |
| 21 | 776 | [src-tauri/src/workspace_execution/tests.rs](../src-tauri/src/workspace_execution/tests.rs) | 测试 |
| 22 | 775 | [src/components/editor/workspace/controller/navigationActions.tsx](../src/components/editor/workspace/controller/navigationActions.tsx) | 前端实现 |
| 23 | 774 | [src-tauri/src/screenshot/qa/capture_scenarios.rs](../src-tauri/src/screenshot/qa/capture_scenarios.rs) | Rust 实现 |
| 24 | 771 | [src/components/editor/workspace/controller/codeActionActions.tsx](../src/components/editor/workspace/controller/codeActionActions.tsx) | 前端实现 |
| 25 | 771 | [src/components/editor/workspace/lspSession/useWorkspaceLspSession.ts](../src/components/editor/workspace/lspSession/useWorkspaceLspSession.ts) | 前端实现 |
| 26 | 769 | [src/components/session/editor/MailSettings.tsx](../src/components/session/editor/MailSettings.tsx) | 前端实现 |
| 27 | 767 | [src/components/editor/workspace/tests/save.cases.tsx](../src/components/editor/workspace/tests/save.cases.tsx) | 测试 |
| 28 | 763 | [src-tauri/src/java_debug_adapter.rs](../src-tauri/src/java_debug_adapter.rs) | Rust 实现 |
| 29 | 762 | [src-tauri/src/database/presto/tests.rs](../src-tauri/src/database/presto/tests.rs) | 测试 |
| 30 | 760 | [.agents/skills/vnc-realvnc-task/scripts/task_board.py](../.agents/skills/vnc-realvnc-task/scripts/task_board.py) | QA/技能工具（产品拆分范围外） |

## 拆分后产品范围 Top 30（与重构盘点对应）

该表去除上一表中的 QA/技能工具，保留生成代码、字典、schema 与静态注册表，避免把例外从排名中隐去。

| 排名 | 当前行数 | 文件 | 类型 |
| ---: | ---: | --- | --- |
| 1 | 14,212 | [src-tauri/src/hbase/thrift/idl.rs](../src-tauri/src/hbase/thrift/idl.rs) | 生成绑定 |
| 2 | 4,365 | [src/lib/i18n/locales/en.ts](../src/lib/i18n/locales/en.ts) | 语言字典 |
| 3 | 4,340 | [src/lib/i18n/locales/zh-CN.ts](../src/lib/i18n/locales/zh-CN.ts) | 语言字典 |
| 4 | 1,364 | [src-tauri/proto/Master.proto](../src-tauri/proto/Master.proto) | 协议定义 |
| 5 | 1,031 | [src-tauri/thrift/hbase.thrift](../src-tauri/thrift/hbase.thrift) | 协议定义 |
| 6 | 807 | [src-tauri/src/commands/mod.rs](../src-tauri/src/commands/mod.rs) | 静态注册表（规模例外） |
| 7 | 799 | [src/components/mail/MailClientTab.tsx](../src/components/mail/MailClientTab.tsx) | 前端实现 |
| 8 | 798 | [src-tauri/src/rdp/gateway/ndr.rs](../src-tauri/src/rdp/gateway/ndr.rs) | Rust 实现 |
| 9 | 791 | [src/components/vnc/VncPanel.tsx](../src/components/vnc/VncPanel.tsx) | 前端实现 |
| 10 | 790 | [src-tauri/src/webview_recovery/mod.rs](../src-tauri/src/webview_recovery/mod.rs) | Rust 实现 |
| 11 | 783 | [src/lib/sessionImportExport/database.ts](../src/lib/sessionImportExport/database.ts) | 前端实现 |
| 12 | 782 | [src-tauri/src/backup/engine.rs](../src-tauri/src/backup/engine.rs) | Rust 实现 |
| 13 | 776 | [src-tauri/src/workspace_execution/tests.rs](../src-tauri/src/workspace_execution/tests.rs) | 测试 |
| 14 | 775 | [src/components/editor/workspace/controller/navigationActions.tsx](../src/components/editor/workspace/controller/navigationActions.tsx) | 前端实现 |
| 15 | 774 | [src-tauri/src/screenshot/qa/capture_scenarios.rs](../src-tauri/src/screenshot/qa/capture_scenarios.rs) | Rust 实现 |
| 16 | 771 | [src/components/editor/workspace/controller/codeActionActions.tsx](../src/components/editor/workspace/controller/codeActionActions.tsx) | 前端实现 |
| 17 | 771 | [src/components/editor/workspace/lspSession/useWorkspaceLspSession.ts](../src/components/editor/workspace/lspSession/useWorkspaceLspSession.ts) | 前端实现 |
| 18 | 769 | [src/components/session/editor/MailSettings.tsx](../src/components/session/editor/MailSettings.tsx) | 前端实现 |
| 19 | 767 | [src/components/editor/workspace/tests/save.cases.tsx](../src/components/editor/workspace/tests/save.cases.tsx) | 测试 |
| 20 | 763 | [src-tauri/src/java_debug_adapter.rs](../src-tauri/src/java_debug_adapter.rs) | Rust 实现 |
| 21 | 762 | [src-tauri/src/database/presto/tests.rs](../src-tauri/src/database/presto/tests.rs) | 测试 |
| 22 | 760 | [src-tauri/src/rdp/gateway/ntlm.rs](../src-tauri/src/rdp/gateway/ntlm.rs) | Rust 实现 |
| 23 | 758 | [src-tauri/src/java_bundles.rs](../src-tauri/src/java_bundles.rs) | Rust 实现 |
| 24 | 758 | [src-tauri/src/servers/rdp/audio_input.rs](../src-tauri/src/servers/rdp/audio_input.rs) | Rust 实现 |
| 25 | 758 | [src/lib/quickConnect.ts](../src/lib/quickConnect.ts) | 前端实现 |
| 26 | 757 | [src/components/chat/drawer/View.tsx](../src/components/chat/drawer/View.tsx) | 前端实现 |
| 27 | 752 | [src-tauri/src/sockscap/redirector/app_identity.rs](../src-tauri/src/sockscap/redirector/app_identity.rs) | Rust 实现 |
| 28 | 750 | [src/components/editor/workspace/workspaceEditorCommands.test.ts](../src/components/editor/workspace/workspaceEditorCommands.test.ts) | 测试 |
| 29 | 749 | [src/components/editor/workspace/host/clipboard.ts](../src/components/editor/workspace/host/clipboard.ts) | 前端实现 |
| 30 | 749 | [src/components/editor/workspace/useWorkspaceFileActions.ts](../src/components/editor/workspace/useWorkspaceFileActions.ts) | 前端实现 |

产品范围排除已登记的生成/声明例外后，最大的手维护文件为 `src/components/mail/MailClientTab.tsx`：**799 行**。

## 校验与边界

- 以上行数从固定两端提交读取，未用旧清单的行数直接相减。
- 195 个原大文件、2,023 个新增路径逐项存在；190 个拆分入口各有对应的新模块，2,006 个关联路径均唯一。
- 所有 2,011 个产品范围新增路径均在清单中；190 个原文件之外的状态/公共支持新增共 5 个单列。
- 当前产品源码 800 行门禁检查、兼容契约与依赖边界检查沿用 `pnpm check:refactor`。
- 本次只增加统计文档，不修改产品或 QA 执行逻辑；三端回归仍对应原验收提交，未为生成统计表重复运行。
- 最终三端回归与外部/人工验证缺口见 [P0→P5 实施与验收](./refactor-p0-p5-implementation-20261021.md#2026-10-22-ae-最终组合验收p0p5-完成)。
