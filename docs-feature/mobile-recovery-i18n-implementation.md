# Mobile P0：离线恢复、数据新鲜度与设置多语言

关联 [P0 设计](mobile-remote-p0-design.md) AC-04、AC-08、AC-09、AC-13、AC-15 / TASK-04。
2026-11-05 在 `feat/mobile-terminal-auth-ux` 推进已有设计缺口，不新增中继、headless 终端创建或第三方 IM 渠道。

## 实现边界

- Settings → Network 的移动服务与飞书适配器接入桌面现有 `en` / `zh-CN` 字典。标题、按钮、状态、计数、二维码可访问名称、安全告知、凭据库取消与已知错误说明均随语言切换；诊断错误码保留。设备时间使用应用 locale。搜索索引包含翻译后的可见标题。切换语言不重建设置、不清空监听选项、配对地址、配对码或飞书草稿；不自动启动飞书，也不保存未提交的凭据。
- 字典按 feature 提取到 `src/lib/i18n/locales/mobileSettings.ts`，不继续扩大已有大字典。Mobile Web 是独立应用，本轮不把手机文案混进桌面 i18n，也不宣称手机端已国际化。
- 缓存 PWA 首页明确显示本机离线和数据可能过期；已保存实例保留。网络在线不等于远程实例在线，未实际连接时显示“当前连通性未检查”，不用浏览器网络状态伪造实例健康。
- 终端流、事件流分别最多自动重试 5 次，间隔为 1 / 2 / 5 / 10 / 30 秒；耗尽后显示手动重连，不清空 xterm 或重建 `useLive` 的序列游标。正常恢复只在收到合法应用帧后重置预算；仅握手成功但马上断开不会无限重置预算。网络离线立即标记过期，在线事件可恢复未耗尽的连接。吊销、Origin 拒绝和终端退出仍不重试。
- 任务、改动列表、当前文件／diff 各有最后成功更新时间、加载状态和失败状态。局部失败不会被其他成功请求刷新时间；同资源保留旧内容并标记可能过期，手动刷新可恢复。路径／实例切换不展示上一资源内容，取消与迟到响应不得覆盖当前资源；不引入任务状态定时轮询。
- 接管前恢复“输入可能打断命令”提示及桌面最近活动，直接与接管按钮关联，不藏在 More 菜单。持有后收起提示保留终端空间；输入／resize 写权与桌面抢回协议不变。

## 验证映射

| 验收 | 自动化 |
| --- | --- |
| Settings 多语言与保留草稿 | `MobileServiceSettings.test.tsx`、`FeishuAdapterSettings.test.tsx`、`settingsSearch.test.ts`；TC-MOBILE-010 browser/native，实际全局入口和语言菜单，原生执行真实配对／启停 IPC |
| AC-04 接管提示与键盘布局 | `TerminalView.test.tsx`；TC-MOBILE-001 / 006 保留键盘、方向键、fullscreen 几何断言；TC-MOBILE-011 在接管前验证提示 |
| AC-08 有界重连与序列续接 | `live.test.tsx`；TC-MOBILE-011 对真实浏览器 WS 注入断连、失败票据，验证每条流 5 次、暂停、保留输出、手动 after_seq 恢复 |
| AC-09 / 13 缓存外壳 | `App.test.tsx`；TC-MOBILE-003 用实际无 Display headless listener + 内嵌 production PWA 验证离线提示、实例保留、恢复联网 |
| AC-15 各块更新时间 | `TaskView.test.tsx`、`useSnapshot.test.tsx`；TC-MOBILE-011 只让任务详情成功而使 changes / file 失败，验证独立过期与刷新恢复 |
| 桌面生命周期 | 完整 `crash-regression` browser/native，匹配当前源码 QA release |

TC-MOBILE-002 / 004 / 005 / 007 / 008 的原硬编码中文设置断言更新为应用默认英语；真实 native 副作用断言保留，不改为 stub 或跳过。
TC-MOBILE-011 是 browser 网络注入，不代替真实 Rust 服务。TC-MOBILE-003 单独补原生缓存外壳证据。新 case 已登记 policy / dependencies / controls，probe/schema/verb catalog 一并维护。

## 本地验证记录

- 缺陷改前：移动设置英文回归 2 项均失败（仍是硬编码中文）；改后纳入下述通过集合。
- focused Vitest：初轮 20 文件、74 项通过；异步边界补充后 20 文件、77 项通过，覆盖全部 `mobile-web/src` 与移动／飞书设置、搜索、i18n。
- `tsc -b`、mobile TypeScript、`pnpm check:refactor`、最终稳定输入 `pnpm build` 均通过。构建含内嵌 mobile bundle 与桌面产物；现有 Vite import/config 与大 chunk 提示仍为警告。
- `cargo check --manifest-path src-tauri/Cargo.toml --lib --locked`：系统 PipeWire 0.3.48 首轮因缺少 `pw_buffer.requested` 失败；设置已有 `~/.cache/taomni-qa/unit-pipewire/install` 1.0.9 的 pkg-config/library 环境后通过。未修改产品 Rust 依赖或系统文件。原生场景仍以 GitHub 的匹配 QA release 为准。
- Python fixture/CI selection/crash/control 契约：修正调用不存在的 `test_control_coverage` 模块后，正确集合 38 项通过；recovery 断言预算单测 2 项通过。
- 初轮本地 browser crash-regression：8/8 通过、0 skip，`qa-ui-auto-report/mobile-crash-local/run-20261105-070309-865627176/`，`identity_stable=true`。最终 async/fixture 修复后完整重跑仍 **8/8、0 failed、0 skipped、稳定来源、exit 0**：`qa-ui-auto-report/mobile-crash-final/run-20261105-075427-159195783/`。
- browser 功能首轮：TC-MOBILE-001/004/006/009/010 通过，011 的测试探针先后遇到 deadline 包装、Playwright expect 签名、全屏遮挡；修正 probe，未强制点击或弱化产品断言。之后 011 的每步断言通过，但当轮编辑了来源，runner 正确判定 `identity_stable=false` 并退出非零；不能作为最终通过；稳定来源完整重跑见下一条。
- 最终稳定来源 browser 功能 **6/6 通过、0 failed、0 skipped**：`qa-ui-auto-report/mobile-final/run-20261105-073459-960129656/`，`identity_stable=true`、runner exit 0。包含 TC-MOBILE-001/004/006/009/010/011；配对／草稿即时翻译、每流 5 次后暂停、after_seq 手动续接、旧内容独立过期与刷新恢复均实际执行。
- fixture 隔离补充后两 worker mobile **6/6**、`identity_stable=true`、exit 0：`qa-ui-auto-report/mobile-parallel/run-20261105-074852-366872636/`。之后 async 边界测试新增未使用形参曾被 mobile `noUnusedParameters` 拒绝（setup 未执行用例）；更名 `_body` 后重新构建与跑例，不把 setup 失败计通过。
- 最终 async/fixture 修复来源两 worker **6/6 通过、稳定来源、receipt exit 0**：`qa-ui-auto-report/mobile-owned-final/run-20261105-075403-506697823/`。receipt 额外确认 `status_failure_blocks_send=true`，失败状态手动重读后 draft 保留。与最终 crash-run 同一 source `7a8d9a9b0d9fb192d3b30c69d882ecc6c521a3e4ad7f3a144b2256f81e6b8101`、runner `f0456cb4c274cccd0c669ed30c4d1583f484c7114422e73e9e049130b3203cad`。
- 首轮失败原件保留在 `qa-ui-auto-report/mobile-local/` 与 `mobile-owned/`，不覆盖失败证据。未提交 runtime artifact。

## GitHub 验证

使用 `.github/workflows/qa-ui-auto-platforms.yml`，selected TC-MOBILE-001～011，三平台 browser/native，`native_release=true`，保留 workflow 自动合并的完整 crash-regression。

- 被测代码：`cbbd11cbaf4d3f11c72d3f24d28be747e8fd08f4`。
- 首轮 [run 41935060538](https://github.com/engcapa/taomni/actions/runs/41935060538) 在 checkout 阶段失败：`actions/checkout` 把短 SHA 当分支名；无产品用例执行。不删除该失败记录。
- 修正 dispatch 的 `head` 为完整 40 位 SHA，其余选择不变，已启动：[run 41935324853](https://github.com/engcapa/taomni/actions/runs/41935324853)。
- 已下载 hosted `selection.json` 核对：被测完整 SHA 正确、无 gaps / unreviewed；Linux browser 14 + native 16、Windows browser 14 + native 12、macOS browser 14 + native 12，共 82 个平台／模式用例。
- plan 与 catalog gate 已通过，browser、三平台 release build 和 native contracts 已进入执行。
- 检查 Linux browser 原始 summary/receipt 发现 job 绿色但逐例为 13/14、exit 1：TC-MOBILE-006 加载时收到目录列表（仅 manifest/icons，无 index/assets）。两个 worker 均构建到 Vite `emptyOutDir` 的同一目录，导致已运行的 peer 读取另一次构建中间态。保留失败 artifact；修复为按 checkout 跨进程锁保护“构建 + 复制”，每个 peer 服务独立 immutable snapshot。专门单测覆盖锁互斥、下一轮清空输出不破坏现有 peer、失败释放；不降 browser workers 或删除测试。
- 同轮 Windows / macOS browser 原始报告各 14/14、稳定来源、exit 0；Linux native contracts 原始日志为 Rust 91/91（含 mobile 与既有 workspace 合约）及配套 Vitest 98/98。它们只属于 `cbbd11cba`，不替代最终来源验证。
- 独立检查新增两项可复现异步问题：离线旧 socket 的迟到 close 会清除 pending ticket 的连接门闩并产生并发连接；revision 中止 action 自己的 detail 刷新后，旧 idle 值会过早允许第二条指令。两项均先新增失败回归，再修复（新 attempt 等待前退役旧 socket；task loading/unknown/error 阻止发指令并提供状态重试）。
- 旧 run 不能证明这些后续修复。为避免继续构建过期来源，已取消该 run，保留已有报告；最终完整 SHA 的三平台 selected + crash-regression 另起，不复用旧二进制冒充新源码。
- 最终修复代码：`45823a09a830f7f607569222a2c78ba619493f23`；[run 41937465958](https://github.com/engcapa/taomni/actions/runs/41937465958)，仍是三平台 browser/native、2 browser workers、QA release 与完整 crash-regression，不减少选择。已下载该 run 的 `selection.json`，source/runner 指纹与上述最终本地证据完全一致，82 个选择无 gaps/unreviewed。
- `41937465958` 的 Linux browser 原始报告仍为 13/14：TC-MOBILE-011 探针在 stop 之后先注入 GET 状态失败，迟到的 stop 事件刷新可能先命中，导致下一条消息还没提交，Send 已因状态未知正确禁用。修复仅测试探针：实际 message POST 才开启后续 GET 失败；保留禁发／手动重读／draft 断言，并加网络路由单测。当时本地 Playwright 1.61 用 `thread**` 包含 `/message`（后来确认 1.55 行为不同，最终用 URL predicate）；该中间修复后 TC-MOBILE-011 本地稳定来源 **1/1、exit 0**：`qa-ui-auto-report/mobile-ordered-post/run-20261105-080827-222112800/`，专门 fixture/probe 单测 6 项通过。产品源码不变，当前 native 构建继续，不浪费已在运行的构建；最终 runner 修复后必须新 run 验证，不能混合不同 runner 指纹的报告。
- `41937465958` Linux QA release build 已成功；构建 job 的完整 Vitest 为 **691 文件通过，6314 passed / 1 skipped**（跳过项位于既有 `TerminalPanel.test.tsx`，不宣称 6315 全过）。Linux native 4 分片已进入执行；最新 runner 全量重跑安排在三平台匹配 build cache 完成后触发。
- `41937465958` Linux native 四分片原始报告已全部下载核对：**16/16 passed、0 failed、0 skipped、稳定来源、各 receipt exit 0**。包含 TC-MOBILE-002/003/004/005/007/008/010 与完整 native crash 保护；TC-MOBILE-003 的真实 headless receipt 明确为 `display=false`、`offline_shell=true`、`offline_notice=true`、`online_recovery=true`、`passed=true`。这些证明最终产品源码的 Linux native 行为，但后续 runner 修复仍另跑统一验收。
- 三平台 release build 均成功并保存匹配缓存后，自动触发最新 runner 完整 run：[41942305100](https://github.com/engcapa/taomni/actions/runs/41942305100)，被测 `9f808fc69fe4fa46dcf51a720e9f8cf9a43bfad4`。产品源码同 `45823a09a`，不把旧 runner 报告混入该次统一验收。已核对最新 selection：仍为 82 个用例、无 gaps/unreviewed，source `7a8d9a9b0d9fb192d3b30c69d882ecc6c521a3e4ad7f3a144b2256f81e6b8101`，runner 更新为 `37626620018fba72874d1d4aa0a853a1dc9478020ce5c19d41afb03911cd21f8`。
- 前一产品 run `41937465958` macOS native **12/12** 全部通过；Windows 四分片 **12/12**（含 TC-MOBILE-004/007/010）全部通过，来源稳定、receipt exit 0。这些只作产品边界辅助证据，统一结果仍取最新 run。
- 最新 run `41942305100` 的 Linux/macOS browser 原始报告为 13/14：网络 trace 显示第二条 message 与所有 detail GET 都返回 200，故障未注入。已用实际 Playwright 1.55/1.61 的 matcher 对比确认：`thread**` 在 1.61 匹配 `/message`，在 hosted 固定的 1.55 不匹配。改用 `urlsplit(url).path` 明确判断，避免版本相关 glob 语义；不放宽失败后禁发和 draft 保持断言。当前版本本地 TC-MOBILE-011 稳定 1/1、exit 0：`qa-ui-auto-report/mobile-url-predicate/run-20261105-084535-504903231/`；独立 Playwright 1.55 实际 Chromium + loopback HTTP 验证新 predicate：stop 后 GET 200、真实 message POST 200、下一 GET 503。正下载该版专属 Chromium 再跑完整 case；未把接口单测或 matcher 检查冒充 UI case 通过。
- 精确 predicate 修复提交 `f6a6606c43e0f9cfd541bc999f8e44ba88b12e5e` 已推送；完整三平台 82 项新运行：[41944281882](https://github.com/engcapa/taomni/actions/runs/41944281882)。为释放 runner 已取消 `41942305100` 的剩余重复任务，保留失败报告。
- `41944281882` Linux browser TC-MOBILE-011 后段仍出现探针竞争：实际 GET 503 已显示重试按钮，但撤销故障后，迟到的 `task_status` 触发 GET 200 自动恢复，按钮在 Playwright 点击前消失。产品自动恢复正确；不改产品或扩大 timeout。将手动恢复阶段的 task_status 推送在网络拦截器中暂缓（从 stop 前开始），前段实时事件与独立数据过期仍正常验证；心跳与其余事件继续转发，assert 实际暂缓了 stop/message 两个状态事件，再通过真实 retry 按钮恢复。独立单测保护转发／暂缓规则，8 项 fixture/probe 单测通过；完整 case 用 hosted Playwright 1.55 + Chromium 140 执行，稳定来源 **1/1 passed、0 skipped、exit 0**：`qa-ui-auto-report/mobile-manual-status/run-20261105-090257-493720354/`，receipt 另断言 `manual_status_retry=true`。
- 最后手动恢复阶段修复提交 `5d3a8be2b7c2b3fb6e2047a75a5194e384dedbab`。同 hosted Playwright 1.55 + Chromium 140 重复执行 TC-MOBILE-011，再次稳定 **1/1、exit 0**：`qa-ui-auto-report/mobile-manual-status-repeat/run-20261105-090447-126426467/`。不调整 timeout、重试预算、产品逻辑或断言。
- 当前统一验收：[41946131514](https://github.com/engcapa/taomni/actions/runs/41946131514)，完整三平台 browser/native、全部 mobile 与 crash-regression、2 browser workers、matching QA release。已下载最新 selection 核对：82 项、无 gaps/unreviewed；source `7a8d9a9b0d9fb192d3b30c69d882ecc6c521a3e4ad7f3a144b2256f81e6b8101`，runner `34b9f0e62999dae04a146b371fdaad9cf93d2c3a90965e83e2ac768688b1e2d8`。已取消 `41944281882` 的过期重复任务并保留 artifacts。
### 当前 82 项最终验收（已完成）

[41946131514](https://github.com/engcapa/taomni/actions/runs/41946131514) 已成功结束，验证提交 `5d3a8be2b7c2b3fb6e2047a75a5194e384dedbab`。下载全部报告后独立重新聚合与 hosted 结果一致：**82/82 passed、0 failed、0 skipped，passed=true、report_ok=true**。无缺失、重复、gaps、unreviewed 或 infrastructure_errors。

| 平台 | Browser | Native QA release |
| --- | --- | --- |
| Linux | 14/14 | 16/16 |
| Windows | 14/14 | 12/12 |
| macOS | 14/14 | 12/12 |
| 合计 | 42/42 | 40/40 |

15 份 runner receipt 已验证，全部来源稳定、非 dry-run，逐个核对 1210 个关联文件的 SHA-256/大小，artifact_errors 与 hosted/independent comparison_errors 均为空；每个平台各分片使用同一个已验证 QA release。Rust 契约 91/91，配套前端合约 18 文件 / 101 项通过。

原始证据与独立结果：`qa-ui-auto-report/hosted-evidence-wedxdcv5/`，其中 `verification-result.json` 为 `passed=true`，`local-verified-ci-summary.json` 与 `hosted-summary/ci-summary.json` 的分组／身份／错误完全一致。测试产品指纹 `7a8d9a9b0d9fb192d3b30c69d882ecc6c521a3e4ad7f3a144b2256f81e6b8101`、runner `34b9f0e62999dae04a146b371fdaad9cf93d2c3a90965e83e2ac768688b1e2d8`。

Linux 二进制 `06f5c58cbfe36a7572e5e68f81afc19d46de0603e67504f48ba672e4d5f522da`；Windows `7b771fb5b3702cb7dc206aff5fd80e744bda7ba90a2d7cd96d9b44f86264b8be`；macOS `409ff333a61df1e1d3ffaa1d52361b95adb79ea8b678ee2d2c255cf3d2f1e4eb`。后续文档不修改被测源码、runner 或用例。

仍未验证且不得宣称完成：Android/iOS 真机 IME／相机／安装、用户自备公网 TLS／双 endpoint／PNA、真实飞书应用通知。用户已明确本轮只要求 Android，iOS 保留未验证但不阻塞；本机 Linux 端口交付前先完成额外真实服务模拟手机 E2E。既有 headless 能力限制不变。

## Session 小结与剩余工作（2026-11-05）

- 本轮新增产品完善：桌面 Network 移动／飞书设置中英文及翻译标题搜索；切换语言保留配对和草稿；离线外壳告知；两条流有界重连和手动 after_seq 恢复；任务／改动／文件各自的成功时间与过期提示；状态未知时禁止重复发送并提供重试；接管风险及桌面最近活动可见；旧 socket 迟到关闭与 task revision 异步所有权修复。
- 本轮验证工具完善：TC-MOBILE-010/011、真实 headless 外壳离线／联网恢复、并行 mobile bundle 独立快照、跨进程 build 锁、与 hosted Playwright 1.55 兼容的 URL predicate、故障注入与手动重试阶段隔离。保留失败记录，不降低并行数、timeout 或产品断言。
- 当前 82 项 hosted 交付已收口：`41946131514` 全过，原始 selection / summary / 15 份 receipt / 1210 文件与 QA release 身份独立核验一致。用户要求的本机 Linux 真实服务 + 模拟 Mobile Web E2E 已完成，12 个连贯流程检查全部通过、无页面异常；六个既有 native 边界场景也有本机通过证据。首轮取消 UI 失败及复验原件保留，详见 [本机真实服务手机 E2E](mobile-local-real-e2e-20261105.md)。下一步只请用户配合 Android 真机与真实飞书，不用 stub 代替。
- 待真实环境验证（不是未实现功能）：Android Chrome / iOS Safari 软键盘、IME、触摸、扫码、PWA 安装及后台恢复；用户提供的双实例 endpoint、HTTPS／反向代理／PNA；飞书 V-08 真实应用发布、通知、审批卡片回调与断线恢复。执行协作见 [真机与真实飞书验收清单](mobile-real-device-acceptance.md)，尚未填任何通过结论。
- 明确尚未开发的后续候选：Mobile Web 自己的独立 i18n（本轮只补桌面设置）；飞书群聊机器人 mention 入口、身份绑定引导／实例辨识；持久化 IM 发送队列与重启恢复；独立离线监测。后几项见 `mobile-feishu-p1-implementation.md` §P1 之后的建议任务，不自动纳入本轮。
- 需要先另行定范围：企业微信／服务号、headless 新建终端／新的 Agent 线程、内置中继、原生 App。手机文件编辑、SFTP、数据库、RDP/VNC 仍非当前控制面范围。
- 前轮已完成而非本 session 新增：紧凑／直接／草稿输入、一次性 SSH/OTP/私钥及跳板／代理认证、手机委托打开本地／保存会话、深链、飞书短命令／卡片。不要把历史实现重复算成本轮新增或继续列为未开发。
