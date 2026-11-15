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

## 07:49 Windows 扩展回归与测试基础修复

产品源码与上述 QA release 相同。完整 browser 选择（crash-regression 加受影响用例）在
`qa-ui-auto-report/_local/browser-complete-1116/run-20261116-070140-264120000`
得到 **27 passed / 0 failed / 1 skipped**；跳过项为当时缺 SSH 的 TC-FILE-OPEN-008。
修正原生异步完成时序与选择器后，browser focused
`qa-ui-auto-report/_local/browser-focused-1116/run-20261116-072512-603632300`
为 **3/3 passed**（FILE013、NOTES008/014）。

完整 native 选择首次遭遇 Windows 超长 mail cache 路径清理失败，造成后续 setup 连锁失败。
修复已验证的 QA 根路径使用 Win32 verbatim namespace，保留根边界及 symlink 拒绝。
较短报告路径的运行 `C:/tmp/tqa-1116/run-20261116-070836-744380800` 为
**21 passed / 5 failed / 1 skipped**；5 个失败均保留。后续针对修正结果如下：

| 具名用例 | 最后补测结果与报告 |
|---|---|
| FILE011、MOBILE013、NOTES014 | `C:/tmp/tqa-focus-1116/run-20261116-072509-889414900` 三项 passed；同报告 FILE007/013 仍失败，不能整份计通过 |
| FILE013 | `C:/tmp/tqa-md2-1116/run-20261116-073342-846127400` passed；同报告 FILE007 的旧 OLE 写剪贴板失败保留 |
| FILE007 | `C:/tmp/tqa-exp3-1116/run-20261116-074528-226249800` **1/1 passed**：真实 CF_DIB 粘贴、系统 Save/Cancel、HTML/PNG/DOCX/Markdown 产物以及源文件不变 |
| FILE008 browser | SSH 恢复后 `C:/tmp/tqa-ssh-browser-1116/run-20261116-074528-523561000` **1/1 passed** |
| FILE008 native | SSH 恢复后 `C:/tmp/tqa-ssh-native-1116/run-20261116-074708-980977500` **1/1 passed**：实际 AI 路径点击、Git 预览、POSIX SSH/SFTP 文件与终端链接边界 |

以上报告均 `source stable: True`。它们建立具名补测证据；期间 runner/YAML 输入有修正，
不能据此声称最后版本的一次完整 crash suite 全绿，最后输入的整批验证仍需执行。

修正未降低产物要求：先独立校验 OS 粘贴的几何/颜色覆盖，再要求每种导出精确保留
该已保存 PNG 的像素；DOCX 仍需真正的 drawing extent/media 和清晰度断言。
换行链接使用实际 client rect 命中同一元素，不绕过遮挡；长保存路径用逐字符 OS 输入，
仍独立读回完整字段。Windows OLE 写入反复失败后改用 Win32 CF_DIB/Unicode，真实图片
往返和原有文本恢复已独立验证。未修改个人应用进程/配置；临时 SSH 密码只在脚本内读取，
不写入命令、报告或提交。

本批 Python 单元 **55 run / 54 passed / 1 skipped**；唯一跳过为当前 Windows 账号没有
symlink 权限的 POSIX 根边界测试。跨平台原生 pointer 全模块另有同类 symlink 权限错误，
不作为全模块通过。`pnpm check:refactor` 用 Node 22.23.5/pnpm 10.30.1 通过。

Hosted run [43772442032](https://github.com/engcapa/taomni/actions/runs/43772442032)
已完成 browser：Linux 27 pass/1 fail，macOS 27 pass/2 fail（raw summaries，不按 job 颜色统计）。
失败为旧 workspace 选择器和 NOTES008 布局测量时序，当前已修正并经 Windows 补测；
Linux native producer 被过期的 crash selection 单测阻断，预期集合已修复。
macOS native release producer 已成功，四个 native shard 正在执行。
这些跨平台失败仍需新提交后的 hosted 回执关闭。
