# Tao Home 后续验证 · 2026-11-16

分支：`feat/tao-home-follow-up`。本批先完成用户反馈和已实施能力的真实验证，完整原型对齐与未贯通 AC 继续保留在 development-tasks.md。

## Windows Tao 真机

匹配的隔离 QA release：`src-tauri/target/qa-ui-auto/release/taomni.exe`，应用 ID `com.taomni.app.qa`。产品源码 hash 为 `332e9bcd8dbf45c91a782d182c821777120d05bcdc47a4c38e38778e9a7b2f88`，二进制 SHA-256 为 `51c1536b36e56611935479367641ec5c2203b4ca365b7e39985d78554dd392c9`。WebView2 与 msedgedriver 均为 `157.0.4341.46`；没有修改个人应用或数据。

最终报告：`qa-ui-auto-report/_local/native-tao-resume-1116/run-20261116-065625-948299600`，**7 passed / 0 failed / 0 skipped，source stable: True**，134.4 秒。每项有 summary、runner_receipt、运行时检查和截图。

| 用例 | 已建立的证据 |
|---|---|
| TC-TAO-HOME-001 | 多语言外壳、明显的新建入口、历史浮层关闭和局部搜索 |
| TC-TAO-HOME-002 | 原生 IPC/HTTP Messages、按序多轮上下文、不回传旧 thinking、流式部分回复、停止后服务端 socket 关闭、刷新恢复、应用/自定义/直连三种代理模式，以及 Vault 首次设置后保存 |
| TC-TAO-HOME-003 | 绑定/能力浮层交互、设置入口与侧栏可达 |
| TC-TAO-HOME-004 | 消息分支、401 可见错误、重试时仅一个错误卡、保留旧回复、原线程编辑回填 |
| TC-TAO-HOME-005 | 使用临时 key 的真实商业 DeepSeek 原生请求，结果为 `response-complete`，助手非空、请求已结束且无错误 |
| TC-TAO-HOME-007 | 语义图标、tooltip、侧栏拖拽、收缩/展开与关闭 |
| TC-TAO-HOME-008 | 中文用户标题不随英文界面翻译，真实 workspace 绑定/引用/重绑/解绑移除旧片段 |

TC-005 的脱敏状态日志为 `request_prepared → response-complete → fixture_cleaned`，独立 outcome 记录请求已 fulfilled、回复长度 48、无错误且已停止生成。Key 只在运行脚本内读取；fixture teardown 删除隔离配置。仅 401/403 或明确凭据过期允许成功分支 `credential-invalid`；网络、代理、配置、协议和其他 provider 错误仍失败。本轮实际命中正常回复分支。

首轮与第二轮失败报告保留在同一父目录，未覆盖：用例曾使用不存在的 welcome tab、原生不支持的 Playwright nth 选择器、未处理的首次 Vault 流程、分支/流结束时序错误，以及不完整的真实 provider fixture。真实回复结果记录器还错误读取了仅 fixture context 拥有的 values；已改为共享 case directory，并增加匹配 native context 的单元验证。没有放宽非凭据错误的成功条件。

## 静态与单元验证

- `pnpm check:refactor`：通过；855 IPC commands、328 facade exports、39 literal events，943 implementation modules，4705 个文件/4 个声明例外。
- `python -m unittest test_crash_regressions`：6 passed。
- `python -m unittest test_tao_provider_observation test_markdown_docx_quality`：14 passed。
- `python -m qa_ui_auto audit --gate`：通过；shallow 60 与基线相同，orphan 从基线 4 降为 2，catalog 已同步。

本次追加修改仅涉及 QA fixture、用例、policy、catalog 与文档。此前产品实现的 frontend/Rust/build 结果见 development-tasks.md；不能将这些局部结果推断为全部 TH-* 完成。

## 继续执行的验证

1. Windows 完整 crash-regression browser/native，加受影响 Markdown/Notes、目录与 Tao UI 用例。
2. Linux/macOS 通过 `qa-ui-auto-platforms.yml` 执行 browser/native，包含自动追加的完整 crash suite。首次 hosted run `43770604009` 在 plan 单元检查失败，未运行产品用例；已补齐 crash suite expected/smoke 集合后重新调度。
3. 当前 Windows SSH/SFTP 测试服务不可达，Docker daemon 也不可用；相关用例若因缺环境跳过，仍记为验证缺口。尚未将完整 crash suite 标为通过。
4. Word 客户端实际放大视觉、macOS 真实菜单/OS 输入、未贯通的工作流/安全/语音等 AC 仍需各自证据；DOCX XML/像素 oracle 与 WKWebView bridge 不替代这些边界。

所有运行产物在 gitignored 的 `qa-ui-auto-report/`，此文记录可定位的本地证据，不承诺它们已上传。
