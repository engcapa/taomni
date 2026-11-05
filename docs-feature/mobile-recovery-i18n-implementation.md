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
- `41937465958` 的 Linux browser 原始报告仍为 13/14：TC-MOBILE-011 探针在 stop 之后先注入 GET 状态失败，迟到的 stop 事件刷新可能先命中，导致下一条消息还没提交，Send 已因状态未知正确禁用。修复仅测试探针：实际 message POST 才开启后续 GET 失败；保留禁发／手动重读／draft 断言，并加网络路由单测。路由必须用 `thread**` 包含 `/message`（单 `*` 不匹配斜杠）；修复后 TC-MOBILE-011 本地稳定来源 **1/1、exit 0**：`qa-ui-auto-report/mobile-ordered-post/run-20261105-080827-222112800/`，专门 fixture/probe 单测 6 项通过。产品源码不变，当前 native 构建继续，不浪费已在运行的构建；最终 runner 修复后必须新 run 验证，不能混合不同 runner 指纹的报告。
- 最终逐例报告、receipt、三平台结果在实际执行后补录；不能以已触发或 job 绿色冒充 hosted 验收通过。

仍未验证且不得宣称完成：Android/iOS 真机 IME／相机／安装、用户自备公网 TLS／双 endpoint／PNA、真实飞书应用通知。既有 headless 能力限制不变。
