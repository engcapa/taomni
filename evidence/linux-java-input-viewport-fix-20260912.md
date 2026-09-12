# Linux Java 输入链修复与复核（2026-09-12）

后续更正：用户确认 Alt+Enter 在 `pnpm tauri dev` 的 Linux/Windows 均失效。已另行复现并修复 StrictMode 销毁后复用 IntentionSession 的缺陷，见 [Alt+Enter 开发模式修复记录](alt-enter-strictmode-fix-20260912.md)。下文此前的打包 QA 通过仅代表当时覆盖的场景。

## 结论与范围

- 修复一个已确认的输入热点：CodeMirror 的 viewport 结束偏移随输入逐字变化，即使没有滚动，也会通过 `onViewportChange → setViewportRanges` 立即更新整个工作区，绕过已有的文本与光标批处理。
- 文本事务仍立即执行；输入造成的视口通知在 125 ms 空闲后发布最终实时范围，并在卸载时取消。普通滚动在没有待处理输入通知时仍立即发布。没有关闭 JDT、诊断或补全，没有加入 Linux 专属行为分支。
- 原 Alt+Enter review 中关于 `Unidentified` 未回退到 `code` 的判断错误，已撤回；原函数已有回退。未保留重复实现，仅增加直接回归断言。原生 JDT Alt+Enter 应用/撤销再次通过。
- 本次修复不等于“Linux 输入延迟全部解决”。事件排队/呈现仍有长尾；不能仅凭 DOM p95 或自动化用例通过把原性能问题标为 Done。
- 用户补充：相似规模工程在 Windows 正常、macOS 也尚可。这是用户提供的现象，本轮没有取得这两端的修复后原生证据。

## 环境与数据

- 基线：`e1335e318de8920edcb8410f18f205ac21d03cad`，生产源码未改；候选：该提交加本次 `CodeMirrorHost.tsx` 视口通知变更。
- Linux `6.14.0-37-generic`，WebKitGTK `2.52.6-0ubuntu0.24.04.1`。
- 使用独立构建的 `com.taomni.app.qa`，原生 debug 后端、打包前端，每次运行独立 data/config/cache 与 JDT 会话。
- 完整复制用户报告的 `persis-g2` 工程到被忽略的 `qa-ui-auto-report/persis-latency-oo8crs/project`，约 1.1 GB；未对原工程执行输入、保存、格式化或构建。
- 指定文件 `persis-g2-server/src/main/java/com/deepzero/ads/persis/PersisG2Application.java`：72 行、2529 字节。原件和副本文件 SHA-256 均为 `4eff32e5fea54badc8e31852590337b8a2bc7eb25534b133046fdcbfc4ed4cb1`。
- 原生操作：等待 Java session，文件末尾输入 24 个预热字符，再输入两组各 50 字符；断言 124 字符完整有序、光标位置正确、四次撤销回退四字符。这里只覆盖 EOF 连续 ASCII 输入，不冒充 Java 方法体内完整编辑、补全和中文混输性能。

## 测量方法与结果

标准 runner 的 DOM 计时从编辑器元素收到 keydown 开始，遗漏到达这个监听器之前的事件排队/捕获阶段，不能代表完整输入交互。补充的只读观测脚本 `qa-ui-auto-report/persis-latency-oo8crs/profile_native.py` 包裹原 CodeMirror update/measure、布局读取和 timer，收集 WebKit Event Timing；所有按键、事务和断言仍通过原生 runner 执行。

以下是使用相同补充观测的前后对照，单位 ms；两组各 N=50，预热另存，不混入实测。Event Timing 的 threshold 为 16 ms，本表两组 keydown 均收到了全部 50 条记录。

| 指标 | 基线第 1 组 | 候选第 1 组 | 基线第 2 组 | 候选第 2 组 |
|---|---:|---:|---:|---:|
| 元素 keydown → DOM p50 | 19 | 14 | 15 | 10 |
| 元素 keydown → DOM p95 | 48 | 22 | 21 | 20 |
| 元素 keydown → DOM max | 55 | 35 | 33 | 45 |
| DOM observer 后下一帧 p95 | 228 | 140 | 128 | 59 |
| Event Timing keydown 交互时长 p95 | 496 | 368 | 392 | 112 |
| Event Timing input processing max | 214 | 22 | 124 | 30 |

不带上述详细观测的标准 runner 对照也完整执行：基线 DOM p95 为 42 / 20 ms，候选为 32 / 22 ms；下一帧 p95 为 230 / 93 ms 与 129 / 144 ms。后组帧指标没有一致改善，保留该结果；这些有限样本不能证明所有阶段均无回归，也不能替代实体键盘到屏幕延迟预算。MutationObserver 中申请的 rAF 是后续帧，不是文字首次呈现帧。

收益证据：回归测试证明逐键同步通知被合并；同观测条件下 input processing 峰值显著下降。限制：首次打开/索引、宿主负载、WebDriver 投递和 WebKit 呈现仍会影响结果，不把自动化步骤耗时当应用延迟。Tauri 的 `invoke` 属性不可写，补充脚本中的 IPC 包裹未生效；没有独立的 provider roundtrip 或 store commit 分段数据。

## 验证

- 新回归测试在旧实现上失败：输入 3 字符立即产生 3 次 viewport 通知。修复后通过：文字立即到达、空闲后仅一次最终范围通知，卸载后无延迟回调。
- 7 个编辑器测试文件，共 283 项通过，覆盖 CodeMirrorHost、IME、补全/撤销、CodeWorkspaceTab 和快捷键。
- scoped typecheck：范围内与范围外均 0 错误；QA 应用构建成功。
- Linux 原生：Alt+Enter JDT 修复/撤销、真实 JDT Format Document 与不可用提示、真实 fcitx5 IME 提交/取消/逻辑撤销，3 passed / 0 failed / 0 skipped。
- 原项目副本：补充观测候选和标准 runner 候选各 1 passed / 0 failed / 0 skipped。
- 标准 runner 候选首轮在第 17 步出现 WebDriver `Connection reset by peer` / `RemoteDisconnected`，未计为通过。仍能获取应用现场，未发现内核 OOM/崩溃记录；新隔离会话重跑完成。首次失败保留。
- 大文件原生首轮：1 MiB 实测两组 DOM p95 为 20 / 17 ms，5 MiB 四组为 18 / 15 / 11 / 17 ms。1 MiB 保存与四次撤销后的磁盘哈希断言通过；第 39 步（5 MiB 保存）WebKitWebDriver 断开，内核日志确认 `WebKitWebDriver ... segfault`（20:49:26），整条用例为失败，不声称完整通过。新会话重跑在相同步骤再次失败，内核在 20:52:15 记录相同驱动崩溃。两轮均为 0 passed / 1 failed / 0 skipped，未降低预算或跳过保存断言。根因与本次视口变更的关联尚未确认；5 MiB 保存及其后的小文件步骤未完成验证。

## 原始证据位置

保留完整目录中的 `summary.json`、`runner_receipt.json`、原始样本与失败现场；补充观测属于诊断证据，不能单凭原 runner receipt 把本地包装脚本认定为发布门禁。

- 标准基线：`qa-ui-auto-report/persis-latency-oo8crs/baseline/run-20260912-202522-479041402/`
- 详细观测基线：`qa-ui-auto-report/persis-latency-oo8crs/profile-events/run-20260912-203303-536919704/`
- 详细观测候选：`qa-ui-auto-report/persis-latency-oo8crs/profile-candidate/run-20260912-204242-337469238/`
- 标准候选失败：`qa-ui-auto-report/persis-latency-oo8crs/candidate/run-20260912-204459-299968161/`
- 标准候选重跑：`qa-ui-auto-report/persis-latency-oo8crs/candidate-retry/run-20260912-204616-139835667/`
- 3 项原生功能回归：`qa-ui-auto-report/input-fix-native-regression/run-20260912-204047-756925379/`
- 大文件首轮失败：`qa-ui-auto-report/input-fix-large-files/run-20260912-204735-423876883/`
- 大文件重跑失败：`qa-ui-auto-report/input-fix-large-files-retry/run-20260912-205017-808750604/`
- 用例与本地诊断脚本：`qa-ui-auto-report/persis-latency-oo8crs/cases/`、`qa-ui-auto-report/persis-latency-oo8crs/profile_native.py`。

## 尚未闭环

1. Linux Event Timing 仍有数百毫秒的排队/呈现长尾；继续区分实际键盘投递、WebKit 呈现与异步 UI 提交，补足独立 store/provider 分段数据。
2. 新增 Java 方法体内输入、补全参与时和索引稳定后的匹配性能场景；当前 EOF 场景只证明一个已确认热点的修复收益。
3. Windows/WebView2 与 macOS/WKWebView 的修改后原生回归。本轮没有把用户的跨平台体感补充当成已执行的验证。
4. 5 MiB 保存原生流程重复触发 WebKitWebDriver 崩溃，需要独立核验应用保存阻塞与驱动错误之间的关系。没有基线保存对照，不能断言是既有问题或本次回归。
