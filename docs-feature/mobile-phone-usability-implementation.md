# 手机远程操作增强

关联：[P0 设计](mobile-remote-p0-design.md)、[飞书 P1 实现](mobile-feishu-p1-implementation.md)。分支 `feat/mobile-feishu-p1`。

## 2026-11-01 范围变更与决定

用户要求手机浏览器操作远程 Taomni 更方便，重点是终端显示、文本输入、快捷键、终端内滚动及飞书入口；同时增加使用已保存会话和新建会话。经用户选择：

- **会话创建委托桌面**，不是在移动服务里再实现一套终端连接。允许新建本地终端和打开全部终端类已保存会话；不增加手机端编辑连接配置/凭据的表单。
- **独立安全开关**：桌面 Settings → 移动服务 → “允许已配对手机打开已保存会话和新建本地终端”，默认关闭、按实例持久化。开启移动服务本身不代表允许新建。
- 飞书同时增加私聊免前缀/中文别名、短 id、会话深链和卡片按钮。
- 验证顺序：本地 Linux unit/browser/native 后，用 `gh` 运行 `qa-ui-auto-platforms` 的 browser/native。访问外网使用用户提供的代理。

这是对 P0“手机不新建终端/SSH”的显式增量修订，不倒改历史 P0 验收：新增入口只在桌面在线且开关开启时出现；headless 仍不能创建终端。SFTP、数据库、RDP/VNC 和新的 Agent 线程创建仍不在本轮范围。

## 手机终端

### 输入

- 常用键两排：Esc、Tab、Shift-Tab、Ctrl-C/L、Home/End、PgUp/PgDn、四方向键；上下左右形成倒 T 布局。
- Ctrl/Alt 为下一键生效的一次性修饰键，有按下状态；对屏幕按键或 xterm 系统键盘字符生效，失去控制时复位。应用光标模式下，方向/Home/End 使用对应 SS3 序列；带修饰键时使用 xterm 参数形式。
- 可横向滑动的第三排提供退格、Ctrl-R/A/E/W/U/K/Z/D 和 `~ - / * > & $ \\` 等手机键盘深层符号。
- 方向键、翻页键和退格支持长按重复；释放、离开、取消、禁用及卸载停止重复。短按仅发送一次。
- 原生单行命令框支持手机 IME、系统粘贴和语音输入，发送时追加 Enter；空行只发送 Enter。中文输入法确认候选时不提交未完成命令。
- 命令框/多行框有焦点时，符号、左右、Home/End、退格和删除词/行的键编辑本地草稿；Esc、Tab、上下、Ctrl-C 等仍作用于远端。草稿文字未显式发送前不进入 PTY。
- 多行面板提供“发送到终端”（不额外回车）、“发送并回车”、显式剪贴板读取和最近 20 条历史。失败保留草稿。换行规范为 CR；程序启用 bracketed paste 时只包裹一次，并将嵌入 ESC/CSI 转成可见字符，防止提前结束粘贴边界。
- 只读、断线、退出、其他连接持有写权时禁止发送；服务端仍独立检查持有者，不能仅靠按钮禁用授权。

### 显示与滚动

- 终端容器使用与内容无关的像素高度，保留此前防止 fit 反馈增长的修复。
- 全屏是页面内的固定面板，不依赖浏览器 Fullscreen API；跟随 `visualViewport` 的高度和 offsetTop，键盘/方向变化触发 fit。全屏 flex 布局将剩余空间给输出，短视口收为横滑单排键条并隐藏符号排；可手动收起全部按键。
- A−/A+ 与双指缩放调整 9–20px 字号；字号、全屏和按键显隐仅作为本浏览器便利偏好保存，存储被禁用时仍可操作。
- 终端区域触摸拖动通过 xterm 公开 `scrollLines` API 滚动普通历史，不滚动整个页面；鼠标追踪和 alternate buffer 使用兼容的 wheel 输入。快速滑动有衰减惯性；新交互会停止惯性，“↓ 最新”回到尾部后不会被尚未结束的 fling 拉走。浏览器回归曾复现合成 wheel 的 Chromium legacy delta=0 无效、global textarea min-height 污染 xterm 隐藏输入区、惯性覆盖最新跳转，均保留 red→green 证据。
- 接管后自动采用手机尺寸；持有期间字号/横竖屏/键盘变化产生有界 debounce resize。只读不发送 resize，释放或桌面抢回继续由 broker 恢复桌面尺寸。
- 输入场域保持 16px，避免 iOS 聚焦时自动放大。常用键防止鼠标焦点从文本区域转移，连续轻点不触发双击缩放。

## 会话打开协议与桌面所有权

新增 v1 端点均复用现有 Bearer/Origin 校验，不使用长 token URL：

| 端点 | 数据 | 行为 |
| --- | --- | --- |
| `GET /api/v1/sessions` | 新增 `capabilities.open_sessions` | 开关与桌面能力同时满足时为 true；原字段不删除 |
| `POST /api/v1/open-requests` | `{kind:"local"}` 或 `{kind:"saved",saved_session_id}` | 服务端验证终端类型与已保存 id；返回 `{request_id,status:"pending"}` |
| `GET /api/v1/open-requests/{id}` | 仅创建它的设备可查询 | `pending`、`opened`（含 `session_id:"term:<后端键>"`）、`failed`（固定错误码） |

- 开关保存在实例数据目录 `mobile-open-sessions.json`，不包含凭据；缺失/格式错误按关闭处理，写失败不改变运行态。
- 服务端将事件 `mobile-open-session` 只发往桌面 main 窗口。桌面在 dispatch 前调用 `mobile_claim_open_session`：再次检查开关、设备吊销、请求年龄，单次领取，重复事件不创建重复标签。
- 桌面移动请求串行，遇到已有桌面认证流程先等它完成，避免覆盖本地认证对话框。继续复用 `openQueuedSession` / `openLocalTab` 的 vault、代理、跳板机、指纹/键盘交互认证流程；这些交互仍需在桌面完成。
- desktop bridge 等待真实 `terminalRuntimeByTab.backendSessionId`，不根据展示 tab id 推算终端 id。终端关闭/连接失败/主壳卸载时取消自己的 waiter；dispatch+ready 共用一个 170s 截止时间。服务端 pending 最长 180s、记录保留 10min、每设备最多 4 pending、全局最多 256 个记录；迟到答案不能复活过期请求。
- 开关关闭撤销**尚未领取**的请求，已经被桌面受理的连接像正常桌面连接一样继续；关闭页面“不再等待”只停止手机轮询，不销毁已打开终端。重开后可从列表接入。
- 运行列表显示桌面报告的可读标题；终端键仍为不透明唯一标识。相同已保存会话多次打开是独立实例，不按配置 id 合并。

## 深链、导航与飞书

- Feishu / 通知的入口格式：`<endpoint>/#/session/<encodeURIComponent(完整会话id)>`，不含 token。按页面来源匹配已配对实例，或仅有一个实例时使用它；多个实例时明确由用户选择。
- 普通路由 `#/i/<实例id>/s/<会话id>` 支持刷新和浏览器返回。UI 返回按实际路由 ancestry 找父页面，而不是假设每次都走过固定层数；从深链直接进入和从配对完成后都可返回列表。
- 未配对深链会把目标 id 带入配对路径，配对成功后直接恢复目标任务，不丢链接。
- Agent 后续输入增加“继续”草稿按钮、Ctrl/⌘+Enter；仍走 Agent `/message`，与 PTY 输入隔离。
- 飞书短命令、短 id、卡片范围和真实飞书未验证边界见 [P1 实现补充](mobile-feishu-p1-implementation.md)。机器人不新增 PTY 输入，不从 IM 创建会话。

## 模块边界

- `mobile-web/src/TerminalView.tsx` 只组合终端生命周期、控制态和视图；键模型、触摸生命周期、布局偏好、草稿编辑、输入与键条分别在 `terminalKeys` / `terminalTouch` / `terminalDisplay` / `terminalDraft` / `TerminalComposer` / `TerminalKeybar`。
- `InstanceView` 拥有列表刷新与打开请求；`openSession` 拥有轮询/abort，`route` 拥有 URL/历史，`App` 负责实例/配对路由。
- 后端 `session_open` 拥有 opt-in、request registry、授权领取和 IPC 结果；不导入桌面实现。桌面 `useMobileBridge` 只调用现有连接入口，不复制认证逻辑。
- 飞书 grammar/id resolution 与 cards 从 actions 中独立；无反向 facade 依赖。全部新手写源码及测试小于 800 行。

## 当前验证记录

下列是本轮实际结果，旧运行不冒充本轮证据；本地 Linux 验证完成，GitHub 结果待补。产品提交 `341a4885`，飞书增量提交 `50b94ae5`；远程 main 已于 `de186f95` 合并（包含 `6ddd5beb`），冲突处保留了双方 QA case 注册。

| 层 | 命令 / 用例 | 当前结果 |
| --- | --- | --- |
| 前端 unit | `pnpm exec vitest run mobile-web/src src/layouts/main/useMobileBridge.test.ts` | 43 passed；含 IME 不误提交、草稿键处理、应用光标/修饰序列、粘贴边界、touch、poll abort、路由往返、mounted write/resize ownership |
| Rust unit/loopback | `cargo test --lib mobile::` | 60 passed，0 failed/ignored；合并飞书卡片/短命令与新 session registry/claim 边界 |
| TypeScript | `pnpm exec tsc -b --pretty false`、mobile-web tsconfig | 通过（Node 22.23.4） |
| 边界 | `pnpm check:refactor`、`git diff --check` | 通过；781 native commands / 328 facade exports / 39 literal events；新模块大小合规 |
| Rust 格式 | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 与受影响模块 rustfmt | 仓库规定命令通过。额外 `--all` 检查被既存 `src-tauri/vendor/ironrdp-*` 格式差异阻塞，本轮不改 vendor |
| QA 静态 | `qa_ui_auto.audit --gate`、catalog `--check`、三平台 selected plan | 通过；无 catalog/覆盖退化，不以此代替实际运行 |
| QA harness unit | `python -m unittest qa_ui_auto.test_mobile_open_session -v` | 9 passed；只证明 oracle 自身，不是 native 接受证据 |
| 保留消费者 unit | `FeishuAdapterSettings.test.tsx`、`chatStore.test.ts` | 44 passed；QA observation/development-contract Python 另外 10 项通过 |
| browser | TC-MOBILE-001 扩展 129 步 | passed，0 failed/skipped，source stable=true；`qa-ui-auto-report/mobile-final/browser/run-20261101-224015-133505601`，含 touch/最新、草稿/修饰键、短视口和深链配对 |
| browser | TC-MOBILE-004 飞书设置 | 最终稳定源码 1 passed，0 failed/skipped；`qa-ui-auto-report/mobile-final/browser-settings/run-20261101-224823-825353599` |
| browser crash | 完整 crash-regression | 最终 8 passed，0 failed/skipped，source stable=true；`qa-ui-auto-report/mobile-final/browser-crash/run-20261101-224225-528666688`。初轮 source stable=false 不作为证据 |
| QA release build | `native_build.py --release` | 最终构建通过，独立 ID `com.taomni.app.qa` / release，源码 SHA `cd8f8cbf93c690959dadbbc247a1e5f422199e7c2f3a1efc7ff338c28b82597e`，binary SHA `2b27a241ec57233338788530a5e036be9a425359a53b3e66d26f7f923dbc98ed`；日志 `qa-ui-auto-report/mobile-final/mobile-native-build.log` |
| native mobile | TC-MOBILE-002/003/004/005 | 4 passed，0 failed/skipped，source stable=true，54.1s；`qa-ui-auto-report/mobile-final/native-mobile/run-20261101-225134-727421420`；实际 PTY、吊销/headless、默认关闭→开关启用→local/saved 创建、跨设备 poll 拒绝、可读标题和独立磁盘 marker 通过 |
| native crash | 完整 crash-regression 9 例 | 9 passed，0 failed/skipped，source stable=true，298.84s；`qa-ui-auto-report/mobile-final/native-crash/run-20261101-225252-957141462`；038/039/045/051/052/053/054/056/057 全通过，含真实 pane/dirty/PT​Y/save/hash/cold-restart 断言 |
| GitHub | `qa-ui-auto-platforms` selected mobile + crash | 未执行，按要求先完成本地验证 |

未验证：真 iOS/Android 软键盘、IME/触摸硬件，真实飞书客户端卡片渲染和回调投递，公网 HTTPS/私网权限、真实 SSH 认证交互。Chromium 手机视口及标准 Touch DOM oracle 不等于这些真机能力已验收。
