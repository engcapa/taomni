# Tao Home 后续验证 · 2026-11-16

分支：`feat/tao-home-follow-up`。本批先完成用户反馈和已实施能力的真实验证，完整原型对齐与未贯通 AC 继续保留在 development-tasks.md。

**最新源码汇总：[e57779493 当前批次](#e57779493-当前源码的最终验证批次)**。下方按时间保留不同源码/runner 的执行与失败记录；历史批次不替代最新源码结果。

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
3. Windows SSH/SFTP 服务已恢复；通过用户提供的本机临时凭据完成 POSIX 认证，FILE008 browser/native 补测均已通过，最终整批结果见后文。此前因环境缺失的跳过记录仍保留。
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

## Vault 修复后的完整批次（`586f036a4`）

匹配的 Windows 隔离 QA release 已构建完成，source SHA-256 为
`5ab82ef5344a0ae7b765fec96fd510ae7aff78eb5f92b4d7ad17b3c5a0f7fa1d`，
binary SHA-256 为
`6a388d8c539a4c539c5c548cc90648338eaf4a79f28239a3ba53ce4fdfe41683`。

- Windows browser：`C:/tmp/tqa-final-browser-1116/run-20261116-075218-648556300`，
  **28 passed / 0 failed / 0 skipped**，743.6 秒，source stable；包含完整适用的
  crash-regression 与受影响 Tao、Markdown、Notes、目录用例。status 验证接受其 receipt，
  没有 rejected report。
- Windows Vault native：`C:/tmp/tqa-vault-1116/run-20261116-075803-131992600`，
  **1 passed / 0 failed / 0 skipped**，25.0 秒，source stable。TC-TAO-HOME-009
  经真实 Settings 锁定与解锁，服务端记录取消；部分回复、草稿、取消解锁、焦点恢复及
  解锁后不自动重发均有独立断言。
- Windows 完整 native：`C:/tmp/tqa-final-native-1116/run-20261116-080006-117923000`，
  **34 passed / 0 failed / 0 skipped**，882.2 秒，source stable。包含完整适用
  crash-regression、受影响功能和上述 Vault 场景；FILE008 为实际 POSIX SSH/SFTP。
  商业 DeepSeek TC005 本批为 `response-complete`，助手长度 35、IPC fulfilled、
  生成结束且无错误，脱敏日志 `request_prepared → response-complete → fixture_cleaned`。
- Linux hosted browser：[43777349601](https://github.com/engcapa/taomni/actions/runs/43777349601)
  的两个 raw summary 合计 **28 passed / 0 failed / 0 skipped**，均 source stable。
  Linux/macOS native 与 macOS browser 仍以各自最终报告为准。

上一轮 [43772442032](https://github.com/engcapa/taomni/actions/runs/43772442032)
完整汇总为 Linux browser 27/28、macOS browser 27/29、macOS native 33/35；
Linux native 被 producer 阻断。除已修正的 workspace 选择器与 Notes 测量时序外，
macOS FILE013 的原始事件日志显示：mousedown 更换复选框 DOM 后，桥接器向新控件
再次发送 click，造成一次操作两次切换。本地最小复现得到 2 次处理，修复候选为 1 次；
后续需要桥接器单元回归和真实 hosted WKWebView 执行，不能放宽勾选断言。

## Word 客户端排版与新增公式回归

实际打开上批 FILE007 的 `exports/native.docx`：独立隐藏只读的 Microsoft Word 16.0
（build 16.0.20527），重新分页并由 Word 导出 PDF，再按 96/192 DPI 渲染 100%/200%
尺寸图。结果在 `output/pdf/tao-home-word-20261116/`（word-client.json、PDF 和两张 PNG）。
源文件哈希不变；独立 Word 实例结束后退出。此证据是 Word 排版引擎输出，
不是交互式 Word 缩放 UI 的截图。

实测 Mermaid 使用 SVG（Word InlineShape type 17），显示 482.25×50.25 pt，约等于
A4 内容宽；PNG fallback 为 2010×210，实际约 300 DPI。两种尺寸下节点文字、边框、
箭头清楚，代表流程图没有小图/模糊问题。范围限于该图、纸张和 Word 版本，
不把它推断为所有 Mermaid 类型和 Word 客户端通过。

同一页公式显示 `x2x^2x2` 和 `12\frac{1}{2}21`，因此整页不计视觉通过。新增 MD-007：
共享 DOCX 转换优先将常见 KaTeX MathML 输出为单份可编辑 Office Math；
无法表达的结构保留一次完整 TeX。本批新增 6 个真实 ZIP 行为测试，相关 4 文件/
20 个 frontend tests 通过；Python 30 tests、Node 12 tests 通过，已把辅助工具回归
加入 hosted producer。FILE004 的真实 Word 下载与 FILE007 的 OOXML 独立检查
继续随新构建执行。

macOS pointer bridge 的事件序列与 browser 首次 Vault 等待属于 QA 工具修复，
不改变产品用户流程；复用 FILE013、NOTES008 和既有 Vault/完整 crash 用例验证，
不为同一行为创建重复产品用例。native bridge 是构建输入，已启动重新构建，
不会用上批源码身份冒充修复后的通过结果。

## `c460283a3` 最终 Windows 与 Word 结果

本批为 `658d6e363`（QA pointer/Vault 等待）和 `c460283a3`（Word 公式），均已推送。
新的隔离 QA release source SHA-256 为
`bbd09b48d7dfd23071f6c8b1b8d4b8ceb638fb4f508499446e37c34155441741`，
binary SHA-256 为
`ec792c66860ae0d3b9d0236f8e33dac1065aa9274576ebb07d5cc421fba989d2`。
Node 22.23.5/pnpm 10；生产 frontend build、refactor 边界检查和 native release 构建通过。

| 平台/模式 | 实际结果与报告 |
|---|---|
| Windows browser | **28 passed / 0 failed / 0 skipped**，239.3 秒；`C:/tmp/tqa-final-browser-1116/run-20261116-082719-425733400` |
| Windows native | **34 passed / 0 failed / 0 skipped**，889.4 秒；`C:/tmp/tqa-final-native-1116/run-20261116-083020-686697700` |
| Linux browser | hosted `43780650689` 两个 raw summary 合计 **28 passed / 0 failed / 0 skipped** |
| macOS browser | 同 run 两个 raw summary 合计 **29 passed / 0 failed / 0 skipped**，包括 MAC003 |
| Linux/macOS native | 同 run 的匹配 release/执行仍在进行，以后续 raw summary 和完整汇总为准 |

以上已完成的四组均 source stable、同一 source SHA。Windows status 独立验收接受
28 个 browser 与 34 个 native 回执，没有 rejected report；含全部适用 crash-regression
（browser 18 项，native 22 项）及受影响特性。首轮重跑遇到已停止的 Vite 服务，
在页面打开阶段连接失败并停止；该日志/目录保留，恢复并确认 Node 22 Vite 服务当前
checkout 后才获得本表最终结果，不把环境失败算成通过。

商业 DeepSeek TC005 正常完成，助手长度 35、一个 fulfilled IPC、无错误、停止生成；
脱敏日志 `request_prepared → response-complete → fixture_cleaned`。本批没有命中
credential-invalid 成功分支。临时 key 及 SSH 密码均从用户指定本机文件内存读取。
FILE007 原生产物具有 **2 个 Office Math 公式**（sSup/f），明确检查文本没有重复层；
Mermaid SVG 引用及约 300 DPI 回退不变。FILE004 真实 browser DOCX 另经 ZIP/公式
独立检查，也为两份单次语义公式；不以 ZIP 文件名代替该检查。

重新在 Word 16.0.20527 打开本批 native DOCX，Word 确认 `OMaths.Count = 2`。
实际分页/PDF 排版及 100%/200% 图已检查：上标和分数只出现一次，节点、细框、箭头
清晰；SVG 显示 482.25×50.25 pt，无正文裁切或图像拉伸。证据在
`output/pdf/tao-home-word-math-20261116/`；源文件 SHA-256
`30578d130eff37f46e489f87e6bc442f9ab05b1cbcca38a47afa5de6be3b016e`
保持不变，独立 Word 已退出。仍限于代表流程图/A4/该 Word 版本的排版，未据此关闭
MD-006 的全部长图/中文/class/ER/纸张组合。

补充浏览器视觉证据在 `output/playwright/tao-feedback-1116/`：实际从 Home 界面设置
和更多菜单的 Tao 设置进入，1366×768 与 800×600 均只有一个可见 Settings tab。
Home 小窗 host 的 client/scroll 尺寸均为 750×534，无滚动溢出，建议不出现滚动条，
未显示 WSL 安装提示。没有与高保真原型做本轮全状态对齐验收。
另外定位到 TH-011 的保留缺口：Tao 设置的深链跳转会把节标题/首行置于粘性搜索栏后方，
已保留截图和待办；不能把单 tab 通过扩大为设置页全部视觉通过。

GitHub 当前执行：[43780650689](https://github.com/engcapa/taomni/actions/runs/43780650689)，
head `c460283a35951bab958c990c9c19c498627a7e07`，明确选择 Linux/macOS browser/native、
release、受影响案例及自动附带的完整 crash suite；MAC001/002/003 也纳入，
商业 key 用例只在 Windows 实机执行。macOS native 的桥接事件、AppKit 菜单对象与
OS 全局按键/菜单点击仍按既有边界分别记录。

## 商业 DeepSeek 扩展与最新截图反馈

TC-TAO-HOME-011 首批真实 Windows native 执行：
`C:/tmp/tqa-real-deepseek-scenarios-1116/run-20261116-092006-516896100`，
**1 passed / 0 failed / 0 skipped**，source stable，source SHA-256
`51287d182a49864190f746cc7368fc4774cab493863a177855b9f4c7dd53b3bf`。
脱敏产物 `real-provider-scenarios.json` 为 `scenarios-complete`，四次真实商业请求均 fulfilled：

- 随机 token 首轮回复、第二轮仅凭上一轮上下文回忆及重新生成均正确，消息数保持 2/2。
- 中文/英文切换保留未发送草稿，期间没有新增付费调用；新会话消息与草稿为空。
- 第四次真实流式调用收到部分正文后停止，一个 Stop IPC 完成，保留 305 字符部分回复，
  后续 1 秒内容及调用数稳定，未自动重发。前三次完整回复分别报告 98/132/132 tokens；
  被停止请求未返回 usage，不能把已知合计 362 当成该轮总用量。
- Key 未失效；日志为 `request_prepared → scenarios-complete → fixture_cleaned`。
  此批尚无侧栏布局步骤和 TC013，不能冒充其通过证据；真实服务端 socket 关闭继续由
  loopback native TC002/009 的独立观察补充。

用户最新截图指出四项建议换行、侧栏覆盖聊天区、重复图标与重复关闭行。
已把侧栏从 absolute 覆盖改为并排布局，拖拽同步改变聊天列；更多弹层改为顶部单图标
直接开关，保留上次页签/宽度，删除面板内重复关闭/收缩行。记忆与技能图标分开；
Tao 设置、外观和演示模式为独立入口。建议行按 Composer 居中，四项同排，长文字省略，
保留完整中英文 tooltip；不再按窗口高度隐藏后两项。

Windows browser focused：
`C:/tmp/tqa-sidebar-browser-1116/run-20261116-093702-414879600`，
**6 passed / 0 failed / 0 skipped**，source stable。
TC001/003/006/007/010/012 验证模式/历史/搜索/演示、设置复用、WSL、八个语义页签、
真实指针与键盘调整、聊天与侧栏不重叠和总宽度守恒、重复开关恢复，以及 1366×768/
800×600、中英文四项建议同排与长文省略。新增 frontend 两文件 12 tests、Python
29 tests 与 pointer activation Node 8 tests 通过。工具 schema/契约首次拒绝的日志保留；
修正只读选择器及检查点映射后才获得本批执行结果，不将静态预检算成执行通过。

38623 的 hosted browser 原始汇总已下载核对：run
[43784592897](https://github.com/engcapa/taomni/actions/runs/43784592897)，
Linux **29/29**、macOS **30/30**，source stable；该批不包含最新侧栏产品改动。
Linux/macOS native 继续等待各自原始报告。此前 c460 的 macOS FILE013 事件原件显示
ratio 为 50，pointerdown 后的 move 落到 preview 而非应用捕获的 separator。QA bridge
增加仅限当前 action 序列的 capture 路由，并在取消/异常时恢复原 API；Node 单元通过
仍不能代替新的真实 WKWebView 回执。新 UI 的匹配 release、TC011 新流式侧栏步骤、
TC013 商业 Markdown/分支/历史，以及最后输入的完整 crash/受影响跨平台整批待继续执行。

## 最新截图修复与真实回复的视口验收

本批提交 `89a0ed2e2`（QA pointer capture）及 `801a4132c`（Home 布局、feed 跟随、商业用例），已推送到 `feat/tao-home-follow-up`。匹配 Windows QA release 的 source SHA-256 为 `55a25f84ff52b931098cafe2f68a453db045e7746b1b20767ef80d69eed093dd`，binary SHA-256 为 `f825ebf639725e92a9428965b35021378fdfeaec0d2061689e5a68144f686a00`，应用 ID 为 `com.taomni.app.qa`。

| 执行范围 | 实际结果 |
|---|---|
| Windows browser 完整适用 crash 与受影响功能 | **30 passed / 0 failed / 0 skipped**，111.9 秒，source stable；`C:/tmp/tqa-feedback-final-browser-1116/run-20261116-095846-710927700`，含全部 18 项适用 crash，用独立 status 验收接受 30 个 browser 回执，无 rejected report |
| Windows native 商业扩展 TC011/013 | **2 passed / 0 failed / 0 skipped**，72.7 秒，source stable；`C:/tmp/tqa-real-deepseek-follow-1116/run-20261116-100143-542800400`，七次实际商业请求均完成，无失效 Key 分支 |
| Windows native 本批整批 | **35 passed / 1 failed / 0 skipped**，944.0 秒，source stable；`C:/tmp/tqa-feedback-final-native-1116/run-20261116-100410-454938300`。全部 Tao（含 TC005/011/013）及 SSH/SFTP 通过；FILE007 的原生保存选择器输入将 `C:` 变为 `C`，完整字符串保护正确拒绝继续，保留失败原件，后续复跑，整批不计全通过 |
| Linux/macOS browser | [43789929072](https://github.com/engcapa/taomni/actions/runs/43789929072)，head `801a4132c`；Linux **30/30**、macOS **31/31**，原始 summary、receipt、全部所列产物哈希、源码/runner/case 身份独立校验一致 |
| Linux/macOS native release | 同 run 的两平台构建/执行仍在进行；未据 browser 通过或绿色 job 关闭 native |

实际 native 截图先暴露了长 prompt 后的回复/Stop 卡片留在屏幕外的问题，旧图保留。新增 feed owner 跟随流式正文、Markdown 后续排版和侧栏宽度；读者向上翻阅时停止跟随，回到末尾恢复，切历史显示尾部，inactive/unmount 释放 observer/帧。新 TC011/013 不主动滚动，通过实际 feed 高度、尾部间距与目标上下边界检查：Stop 卡片、Markdown 回复、恢复历史的尾回复均完整进入视口，三个观测点 gap 都为 0。已人工查看新 `real-stopped.png` 和 `real-markdown.png`，侧栏并排、卡片与回复可见，四项建议保持单行省略，没有底部横向滚动条。

商业场景进一步确认中英文切换保留草稿、不额外调用，重新生成不重复消息，新建隔离，native clone 后分支能回忆不可预知 token，返回原会话和分支各自恢复正确消息数与草稿，历史操作没有自动发送。TC013 首次失败是 CSS selector 把分支标题的 `·` 编为 JSON 的 `\uXXXX`，修正为实际 Unicode 并补真实 DOM selector 单元；旧失败回执保留。调用为合成短提示，消耗远低于 1M 预算；被停止请求没有完整 usage，不声称掌握本轮累计精确 token。

本批 10 个 frontend test files / 47 tests、Python 31 tests、Node pointer 8 tests、`pnpm check:refactor`、QA audit、生产 frontend 和 QA release 构建通过。静态 audit 为 760 个 case、catalog up to date、无覆盖回退，未将既有全局覆盖缺口或静态检查当作产品执行通过。

上批 `38623c5f3` 的 Linux native 四个原始 summary 为 **31/32**；FILE011 和 Vault TC009 已通过，唯一失败是 TH003 在平滑滚动尚未完成时执行视口断言。原等待仅要求标题在搜索栏下方，屏幕外的标题也可提前满足。本批补充“标题底边在设置视口内”的联合等待条件，保留独立最终几何检查，后续新 Linux native 回执通过前不将此项记为关闭。旧 macOS FILE013 的 capture 问题也继续以新 WKWebView 实际执行为准。

以上为本批反馈与具名场景验收，不扩大为全部 TH/MD AC、全原型视觉或 macOS OS 全局输入/交通灯交互已经完成。

## 回归中发现的终端文件链接焦点问题

旧 macOS FILE011 原始事件显示，用户已经点击终端 tab，随后又显示文件页。生产 `fileLinks.ts` 在一次打开结束后，仍于 50/250/1000/3000ms 强制激活查看器；全局 `openFile` 的重复打开分支也有无条件的下个 task 激活，都会覆盖之后的手动导航。这是产品焦点所有权缺陷，不通过增加点击/等待来规避。

先加入两个 store/链接边界回归，在旧实现上得到 **2 failed / 9 passed**，均证明手动选择 terminal 后又变回 viewer（`terminal-focus-before-1116.log`）。修复删除两处延迟抢焦点，让共享打开服务只在该次打开时负责去重与激活；同一组为 **11/11**，全部 openFile 相关 6 files / **34 tests** 通过。TC-FILE-OPEN-011 增加手动返回后超过原 3 秒窗口仍保持终端活动的独立断言，保留第二次实际 modifier-click、只一 viewer、磁盘字节和关闭后 PTY 仍可执行的检查。新的匹配 QA release、browser 与完整 native/hosted 回执继续跟进；本节之前的 `801a4132c` 证据保留为该源码批次，不能冒充此修复后的当前源码通过。

修复提交为 `ed351a7c9`，已推送。该源码 Windows browser **30/30**、121.0 秒、source stable：`C:/tmp/tqa-terminal-focus-final-browser-1116/run-20261116-102350-880133900`，独立 status 接受全部 30 个 browser 回执且无 rejected report；完整适用 crash 18 项包含在内，QA audit 亦通过。新 QA release 的 source SHA-256 为 `1a7e311db927b39e05cd80731117e636329e93e24825966445f1a6a37dcb5446`、binary SHA-256 为 `efbf4cf3628f4c114ddf0a139229bd90d200572fdf7043520ac0d93674963911`，`com.taomni.app.qa` 身份已由构建工具生成。FILE007/011 定向 native 与之后的完整 native 使用此构建。Linux/macOS 当前源码执行为 [43791999859](https://github.com/engcapa/taomni/actions/runs/43791999859)；未将仍在进行的 `801a4132c` native 构建结果当成本提交执行通过。

## Windows 系统保存对话框输入修正

`ed351a7c9` 的首次 FILE007/011 native probe 为 **1 passed / 1 failed**：FILE011 通过，FILE007 的保存路径由 `C:\tmp` 丢字成 `C:\tp`。报告保留在 `C:/tmp/tqa-terminal-focus-probe-1116/run-20261116-103030-802960700`。逐字确认后仍复现原生全局送键遗漏，后续失败原件为同目录的 `103628-420690300`、`103857-458768400`、`104146-758306800` 各 run；没有放宽完整路径或产物断言。

最终 helper 向经过进程/窗口/控件归属核验的原生 Edit 发送 Unicode `WM_CHAR`，逐字通过 `WM_GETTEXT` 确认；全选清空也读回确认，并在输入期间保留线程焦点归属检查。原生 Save/Cancel 按钮及真实插件返回仍由系统对话框处理；不改写 plugin-dialog 返回、不用 `WM_SETTEXT` 模拟内部选择、不重播未确认字符，也不操作剪贴板。该证据证明实际系统控件与磁盘导出路径，不声称硬件键盘送达。

最终 probe：`C:/tmp/tqa-terminal-focus-probe-1116/run-20261116-104357-778679300`，**2 passed / 0 failed / 0 skipped**，66.1 秒，source stable。FILE007 的五次原生操作（HTML/PNG/DOCX 保存、Markdown 目录选择、输入路径后取消）全部完成，真实媒体/公式/源文件保留断言通过；FILE011 的 modifier-click、重复打开、手动切回后等待 3.2 秒及 live PTY 均通过。产品 source/binary 与上一节相同，`native_build.py --release --check` 确认可复用；runner SHA-256 为 `917de2316d852b65f399c638a7dde615020342cc690b83ed2cf417ba2516fc0d`。

对话框 Python 单元 **30/30**、PowerShell 内嵌 C# 编译、`pnpm check:refactor` 均通过。相关跨平台测试采用显式 POSIX fixture 路径，并在 Windows 无 symlink 权限时使用真实 NTFS junction 验证逃逸拒绝，没有跳过该边界。最终 30 项 browser / 36 项 native 整批已启动；此前同产品 source 的 Linux browser **30/30**、macOS browser **31/31** 回执保留为旧 runner 批次，最新 runner 的最终跨平台回执另记。

## `704f7aa79` 整批结果

Windows 当前 source / runner 下，browser `C:/tmp/tqa-terminal-focus-final-browser-1116/run-20261116-104542-420521800` 为 **30/30**、121.2 秒；native `C:/tmp/tqa-terminal-focus-final-native-1116/run-20261116-104540-460894500` 为 **36/36**、961.5 秒。均零失败、零跳过、source stable，包含全部适用 crash-regression（18 browser / 22 native）。source / binary 沿用上节匹配 QA release，runner 为 `917de2316d852b65f399c638a7dde615020342cc690b83ed2cf417ba2516fc0d`。

真实商业 TC005/011/013 的脱敏 outcome 分别为 `response-complete` / `scenarios-complete` / `documents-complete`，共八次实际 native 请求；均正常回复，没有命中失效 Key 分支。已人工检查本轮 `real-stopped.png`、`real-markdown.png`、小窗中文建议截图：侧栏并排、Stop 卡片及 Markdown 尾部在视口内、四项建议单行省略且无横向滚动条。未据此宣称全部原型状态视觉验收。

当前 runner 的 hosted 为 [43794207330](https://github.com/engcapa/taomni/actions/runs/43794207330)，head `704f7aa799a299e2d7b64d20e8404d71d3b9152a`；Linux browser **30/30**、macOS browser **31/31**，已逐一验证 raw summary、receipt 签名、所有产物 hash/size、case/source/runner 及 stable 标记，无完整性问题。Linux/macOS native 仍待本轮结果。旧 `43791999859` 在 producer/cache 已结束后取消剩余重复排队 native：Linux producer 的完整 frontend 为 7002 passed / 1 failed / 1 skipped，唯一失败为 ED-REPAIR-006 mounted test 在 journal commit / Undo command ready 前发送 Ctrl+Z；将补正确前置条件，未把构建失败记为通过。

旧 `801a4132c` 的 macOS native raw 合计 **33/35**：FILE011（已在 `ed351a7c9` 修复）和 TH003 设置定位失败，FILE013 原生 pointer capture 拖拽通过。TH003 截图显示异步 ASR 模型卡展开后 Tao 节标题被推离视口；将补导航期间的布局变化保护和用户滚动接管，保留原可见几何要求。

## 设置布局变化与单元前置条件修正

设置深链的 RAF、布局观察及取消由 `panel/sectionReveal.ts` 统一拥有：目标组展开后定位节标题，并观察整个内容容器和视口，处理目标上方的异步模型卡高度变化。用户 wheel、pointer、touch 或键盘输入立即交还滚动所有权；新导航、搜索和 unmount 清理旧 observer/RAF/监听，隐藏页签不主动滚动。带 LSP preset 的深链只做首次节定位，随后仍由 preset 行接管。没有降低 TH003 的“标题完整在视口内、位于搜索栏下至少 12px”断言。

新增 **8 项** focused 单元覆盖异步前置内容、连续 resize 合并、四种用户接管、折叠等待/取消、preset 与隐藏页签；完整 SettingsPanel / CodeWorkspaceTab 加该模块 **3 files / 286 tests** 通过（108.1 秒），`settingsNavigation.test.ts` 另 **3/3** 通过。CI 中的 ED-REPAIR-006 用例补“journal commit 后 Undo command enabled”前置条件，保留大小写不同两文件的独立写入、实际 Ctrl+Z 确认及精确恢复断言。

TH003 补齐 reviewed 的行为检查映射、工作流/语音面板关闭结果和设置定位截图。第一次新增测试定义被 TypeScript mock 类型和 testcase schema 检查拦下，已修正；对应失败日志 `settings-final-build-1116.log` / `settings-final-browser-1116.log` 保留，未产生产品执行通过记录。最终严格 case loader 和 `pnpm check:refactor` 通过（4715 files / 4 documented exceptions）；新 source 的 QA release、完整 browser/native 及 hosted 验证继续执行，不能复用上节旧 source 的通过结果冒充本修复验收。

## `e57779493` 当前源码的最终验证批次

本节对应包含设置异步布局修复的 `e577794931b427cfb82f4f401189508e68d26974`，后续只更新本节同一批次的结果。source SHA-256 为 `1568ca4a45be5baac71fe7de3e2ac7c4e750438fb502c2428a6c644be96db09e`，runner SHA-256 为 `917de2316d852b65f399c638a7dde615020342cc690b83ed2cf417ba2516fc0d`。Windows QA release 的应用 ID 为 `com.taomni.app.qa`，binary SHA-256 为 `74e0ea5eecb3303956558a554b709988d75aa78c190ea306f7b9c31e94815d49`，构建成功且身份与测试源码一致。

| 平台 / 模式 | 执行结果与证据 |
|---|---|
| Windows browser | **30 passed / 0 failed / 0 skipped**，112.1 秒；`C:/tmp/tqa-terminal-focus-final-browser-1116/run-20261116-111021-800883300`，source stable，独立 status 接受全部回执，完整适用 crash **18/18** 无遗漏 |
| Windows native release | **36 passed / 0 failed / 0 skipped**，960.8 秒；`C:/tmp/tqa-terminal-focus-final-native-1116/run-20261116-111828-811391600`，source stable，独立 status 接受全部 36 个 native 回执、无 rejected report 或 native gap，完整适用 crash **22/22** 无遗漏 |
| Linux browser | **30 passed / 0 failed / 0 skipped**；下述 GitHub workflow 的两个原始分片，回执签名、summary 绑定、所列全部产物 hash/size、source/runner/case 身份与 stable 标记均独立校验一致 |
| macOS browser | **31 passed / 0 failed / 0 skipped**；同 workflow 两个原始分片，通过与 Linux 相同的独立校验 |
| Linux native release | **33 passed / 0 failed / 0 skipped**；四个原始分片与 33 项选择清单一致，无遗漏/重复，完整适用 crash **22/22**，回执签名、全部产物 hash/size、source/runner/case/build 身份及 stable 标记独立校验一致 |
| macOS native release | **35 passed / 0 failed / 0 skipped**；四个原始分片与 35 项选择清单一致，无遗漏/重复，完整适用 crash **22/22**，通过与 Linux 相同的独立校验 |

GitHub：[43796588906](https://github.com/engcapa/taomni/actions/runs/43796588906)，head 与本节提交一致，使用 `qa-ui-auto-platforms.yml`、Linux/macOS browser/native release 和显式受影响选择，自动包含完整 crash-regression。选择清单分别为 Linux browser/native **30/33**、macOS browser/native **31/35**。Linux native Rust 契约 **120 passed / 0 failed**；完整 frontend **794 files / 7011 passed / 1 skipped / 0 failed**，Vitest 693.96 秒，ED-REPAIR-006 修正已由本轮完整执行确认。唯一跳过来自已有的终端 text-mirror 构建开关条件测试（`clipboard3.cases.tsx` 的互斥 profile 分支），不是 browser/native 场景跳过。完整 producer 日志保留为 `qa-ui-auto-report/_local/e577-linux-producer-complete-1116.log`。商业 Key 用例继续仅在 Windows 本机执行，未上传 Key。旧 `43794207330` 已在 producer/cache 完成后取消重复排队；旧 `43789929072` 当时已完成，取消未生效，不记录为已取消。

该 workflow 最终结论为 **success**。全部 hosted 原始报告保留于 `qa-ui-auto-report/_local/hosted-43796588906/`，独立完整性结果为其中的 `independent-feedback-verification.json`。最终核对四组 selection 与实际 ID 全量相等，零遗漏/额外/重复；Linux/macOS browser 均完整包含 **18/18** crash，native 均 **22/22**，所有执行为通过。Linux 四个分片的 release binary SHA-256 一致为 `e1e26b324c2ee1a6cfee9412c5e17fe6cc34800a95982d6869cfba522d02fcc8`，macOS 四个分片一致为 `c2dda4ad35089273d4e583e3ca024bbeab1a7170a78269596dc0e14acbdb7a26`；两平台均为 `com.taomni.app.qa` 且 source 与本节一致。

本节 Windows native TC005/011/013 outcome 分别为 `response-complete`、`scenarios-complete`、`documents-complete`，**八次真实 DeepSeek 请求全部正常回复，没有 Key 失效成功分支**。覆盖不可预知 token 的多轮回忆与重新生成、语言切换保留草稿而不额外请求、新会话隔离、真实流式侧栏并排与 Stop、实际 Markdown heading/table/code、native context clone、原会话/分支的消息及独立草稿恢复和无自动发送。Stop 卡片、Markdown 回复及恢复历史尾部的独立几何观测均为 `gap = 0` 且目标上下边界可见；已人工查看该批 `real-stopped.png`、`real-markdown.png` 与基础真实回复截图。三个 fixture 都记录 `fixture_cleaned`。被停止请求不保证完整 usage，预算 1M tokens 为上限，不宣称精确累计消耗。

最新浏览器的 800×600 中英文建议、并排拖拽侧栏，以及 Windows/Linux/macOS native 的 Tao 设置定位截图已查看：四项建议保持单行、省略而不折叠，侧栏不覆盖聊天，设置只有一个 tab 且标题在粘性搜索栏下。FILE011（终端文件链接焦点）、FILE013（Markdown 分栏实际拖拽）、TH003（设置异步布局定位）均在本源码的真实 native 测试中通过。`pnpm check:refactor` 最终通过（855 commands、328 facade exports、39 events、944 implementation modules、4715 files / 4 documented exceptions）。

本批用户反馈和具名保留回归已完成验证，完整原型对齐及未覆盖的 TH/MD AC 继续保留待办。Linux 证据限于本轮 Xvfb/WebKitGTK profile，macOS 的 WKWebView/AppKit 对象自动化不等同于 OS 硬件按键送达、真实菜单栏点击或所有 macOS 版本/架构验收；Word 视觉证据仍限于此前记录的 Word 16 代表样例。
