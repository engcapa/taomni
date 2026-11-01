# Mobile P0 / 飞书 P1 评审核对与处置

日期：2026-11-01。分支：`feat/mobile-feishu-p1`。原始评审：[mobile-feishu-p1-review.md](mobile-feishu-p1-review.md)，评审对象为 `d813defe2641d910d4cc1e01f09831c6830f3bac`；本次从 `21dd74c4` 继续完善，保留原始意见以便追溯。

## 核对结论

F-01～F-48 已逐项核对。确认的逻辑缺陷按建议修复；允许二选一的建议记录实际选择。F-20 的“默认数据目录可能不同”未被证实：当前 Tauri 2.12 的 desktop PathResolver 同样使用 `dirs::data_dir()/identifier`，identifier 为 `com.taomni.app`；其迁移顺序和自定义配置隔离问题成立并已修复。F-37 的 webhook 取舍原本已回填 DEC-07，本次统一了仍残留的旧表述，并明确 IM 独立身份与停用方式。

M1 的历史证据需更正：GitHub API 已确认 [41262327253](https://github.com/engcapa/taomni/actions/runs/41262327253) 对 `d813defe…` 成功，[41260611701](https://github.com/engcapa/taomni/actions/runs/41260611701) 对 `10e73c6d…` 成功。因此评审中“仍执行中”的描述已经过时；这些运行不能证明本次修复提交。本次使用用户指定的 `qa-ui-auto-platforms.yml` 重新验证，见下文。

## 逐项处置

下表“修复”表示代码和回归已补充，执行结果按后面的验证记录核对，不能据此推定真实手机或飞书已经验收。

| 编号 | 核对与处置 | 主要证据 / 验证入口 |
| --- | --- | --- |
| F-01 | 修复：实例身份变化清空游标，resync 不受旧 seq 过滤，携带 last_seq | `mobile-web/src/live.ts`、`live.test.tsx`；Rust `events.rs` |
| F-02 | 修复：预检可传输，拒绝响应带可读的固定错误码；旧 token 不再自动重试 | `server.rs`；`review_tests::revoked_origin_errors_and_missing_terminal_are_readable_over_the_wire`；TC-MOBILE-002 |
| F-03 | 修复：status 限定 `-- .`，按仓库前缀换算为任务根相对路径 | `file_view.rs`；`subdirectory_root_paths_stay_local_and_diff_is_literal` |
| F-04 | 修复：轮次 owner 统一发终态，空闲 stop 不发终态；飞书按任务/轮次去重 | `preparation.rs`、`turn.rs`、`notifications.rs`；`task_tests` 恰好一次断言 |
| F-05 | 修复：缺失终端升级后发送 error + 4004；exit/4004 停止重连 | `streams.rs`、`live.test.tsx`；真实 WS 回归 |
| F-06 | 修复：单帧分片/编码/JSON 错误回失败 ACK 并计数，保持连接 | `im_adapter/worker.rs`、`network_tests.rs` 的坏 JSON ACK 与后续正常事件 |
| F-07 | 修复：采用建议中的粗粒度失效事件，每任务 500ms 合并，忽略高频生成目录；飞书独立订阅 task_status | `file_watch.rs`、`events.rs`、`worker.rs`；文件与独立订阅回归 |
| F-08 | 确认删除路径存在；修复：无新本地根时保留既有根，移动后续请求不清除目录授权 | `file_view::remember_root`；真实上下文重建后文件仍可读 |
| F-09 | 修复：拒绝家目录/文件系统根/profile/配置目录及常见凭据路径 | `file_policy.rs`、`review_tests.rs` 的 .env 与路径边界断言 |
| F-10 | 修复：headless stderr logger、周期失败计数与飞书状态 | `headless_ops.rs`、`headless.rs`；真实部署日志抽检仍另列 |
| F-11 | 修复：Windows headless AttachConsole/AllocConsole；跨平台每五分钟轮码，Ctrl-C 正常退出 | `headless_ops.rs`、`headless.rs`；Windows 实际操作者控制台交互未实测 |
| F-12 | 修复说明：直连 provider 允许纯文本，详情显式说明本轮没有桌面工具；依赖桌面的 provider 返回 desktop_required | `session_view.rs`、`TaskView.tsx`；`task_tests` |
| F-13 | 修复并确定契约：token 绝对 90 天/闲置 30 天，last_used 最多每 5 分钟及停止时落盘 | `auth.rs`、`auth_tests.rs` |
| F-14 | 修复真实暂停点：前端副作用等待用 RAII 投影 supported:false，解决/取消/超时清理。消息内 ActionCard/WebSearch 卡不暂停后端，详情提示在桌面处理 | `confirmation.rs`、两处 MCP wait；`desktop_only_gates_are_visible_and_drop_cleans_up` |
| F-15 | 修复：先构造请求再预留，桌面/移动共用 TurnGuard；abort/panic 清理并等待旧运行停止 | `turn.rs`；`aborted_or_panicking_turn_releases_the_reservation` |
| F-16 | 修复：成功配对不累计失败 | `auth_tests.rs` |
| F-17 | 修复：1024 来源上限淘汰最旧条目，不全局拒绝 | `auth_tests.rs` |
| F-18 | 采用建议的回环独立策略：错误码限流，正确高熵码不受共享回环桶封禁；不信任 forwarded IP | `auth.rs`、回环配对测试；P0 部署说明 |
| F-19 | 确认共享互斥改变桌面语义，设计明确即使未启用服务也禁止同线程重叠；前端中文提示，不回退 chat_send，不留下未落库消息 | `navigation1.cases.ts`；`concurrent_desktop_entry_rejects_before_persisting_and_tools_omit_details` |
| F-20 | 默认目录差异未成立；修复已确认的迁移顺序与自定义 data-dir 下 AI/代理配置隔离 | `headless.rs`、`migrate.rs`、`resolved_config_dir`；ModeLease 桌面共享/headless 独占测试 |
| F-21 | 采用建议的明确凭据边界：headless 仅接受环境变量，无值时给出包含锁定/无解锁提示的错误；文档说明同用户进程可见风险 | `headless_ops::secret` 及错误文案断言 |
| F-22 | 补 HeadlessSink，chat 移动路径统一经 emit_optional；桌面专用工具不在 headless 启动 | `events.rs`、`stream_events.rs`；P0 初始化/不启动项盘点 |
| F-23 | 修复：统一写 PTY Ctrl-C 到前台组；真实 sleep 100 被 REST stop 中断，随后单独命令可执行 | `agent_view.rs`、`service_tests::two_viewers_share_real_pty_with_readonly_resize_control_and_replay` |
| F-24 | 修复：退出保留回放，关闭/停服务再移除 | `pty_broker.rs`、退出后新订阅尾部断言 |
| F-25 | 确定生命周期：最多 64 个已退出条目；不存在或重复 exit 不再发 changed | `pty_broker.rs`、64 条上限与重复事件断言 |
| F-26 | 修复：订阅和 hello 游标快照在同一发布锁下取得 | `events::subscribe`、独立订阅快照回归 |
| F-27 | 采用评审允许的文案方案：UI 与实现记录明确 iOS/无 BarcodeDetector 以手动输入为主路径 | `PairForm.tsx`；iOS 相机专项仍未验证 |
| F-28 | 修复：180/192/512 PNG、独立 maskable、apple-touch-icon、预缓存与 PNG MIME | Mobile Web assets/manifest/vite、`server.rs`；真实安装另验 |
| F-29 | 修复：literal pathspec、禁外部 Git 扩展、特殊文件预检，Unix 非阻塞/不跟随打开，Windows 无控制台 Git 子进程 | `file_view.rs`；真实通配 pathspec/FIFO 回归 |
| F-30 | 确认资源缺失可静默；修复：release 缺外壳构建失败，debug 警告，health 给出 shell_available | `build.rs`、`server.rs` |
| F-31 | 修复：移动 broker/events/auth 的锁毒化恢复，桌面热路径不再 unwrap panic | `exited_replay_and_poisoned_mobile_locks_do_not_break_desktop_output` |
| F-32 | 修复：Host 限监听地址和显式 profile allowed_hosts，未知 Host 在 CORS 前拒绝 | `listener_policy.rs`、真实 HTTP rebind Host 拒绝测试 |
| F-33 | 采用建议的最近桌面活动时间方案，control 帧与手机接管处显示 | `pty_broker.rs`、`TerminalView.tsx` |
| F-34 | 修复：本地可取得时发送真实退出码，SSH/不可取得仍 null；无桌面尺寸时日志+错误帧 | `io_commands.rs`、`pty_broker.rs`、退出码回放断言 |
| F-35 | 修复：投影当前轮工具名与状态，不含参数；手机展示 | `stream_events.rs`、`session_view.rs`；PRIVATE_ARGUMENT 不外发断言 |
| F-36 | 确认退出路径缺少 stop；修复：RunEvent::Exit 有界 5 秒停止服务，flush/取消 WS/飞书停止通知共用正常 stop | `lib.rs`；服务停止/飞书停止 fixture 已有回归，桌面进程退出通知的端到端专项未执行 |
| F-37 | 决策澄清：IM 以 TLS+app/open/chat 白名单独立鉴权，Web token 吊销不影响 IM；设置可一键停用，删绑定重启可单独吊销；本期无 webhook | DEC-07/§4.4 与 P1 实现记录已统一 |
| F-38 | 修复：增加 Mobile Web live/api/TaskView Vitest，并纳入 workflow 原生契约 job | `ci_rust_contracts.sh`；客户端回归 |
| F-39 | 修复：停止与 load 清除未用配对码和票据 | `stopping_and_restarting_the_service_invalidates_unused_pairing_codes` |
| F-40 | 更正：设备哈希清单落盘，WS 票据仅内存 | P0 契约与安全参数 |
| F-41 | 更正：成功不计失败、来源淘汰与共享回环策略写明 | P0 契约与安全参数 |
| F-42 | 更正：headless 无 vault 解锁入口，仅环境变量 | P0/P1 实现记录 |
| F-43 | 更正：V-01～V-08 按设计重新映射，列实际文件/测试名及证据边界 | P0 验证记录 |
| F-44 | 修复潜在单位风险：按数量级同时支持毫秒与微秒 | `im_adapter/actions.rs`、时间单位测试；真实卡片仍需 V-08 |
| F-45 | 修复：file 默认关闭、显式持久化开启；show/file 仅私聊，敏感路径继承拒绝；设置说明发送至飞书服务器 | `actions.rs`、`FeishuAdapterSettings.tsx`；TC-MOBILE-004 默认/警示/开启/重开持久化 |
| F-46 | 修复：命令并发上限 4，独立消费任务事件；Lagged 按任务快照/确认点对账并去重补发 | `worker.rs`、`notifications.rs`、网络 fixture |
| F-47 | 修复：32768 UTF-8 字节提示/限制，413/非 JSON HTTP 错误分类，飞书超 8192 字节明确回复 | `TaskView.test.tsx`、`api.test.ts`、`im_adapter/tests.rs` |
| F-48 | 修复：REST terminal stop 校验当前设备写权，read-only 返回 403 not_holder | Rust 真实 PTY 与 TC-MOBILE-002 原生断言 |

评审清单外两项模块建议也已处理：移动设置每 3 秒刷新配对设备列表；增加局域网 HTTP 明文传输提示。未增加运行中的端口切换，仍需停止服务后变更再开启。

## 验证与证据

- 旧代码隔离探针：在临时目录恢复初始 `live.ts/api.ts`，新增测试复现 3 项失败（重启事件丢失、已移除终端重连、413 误报网络错误）；修复后对应测试通过。日志：`qa-ui-auto-report/mobile-review/baseline-frontend.log`。
- Rust 真实网络/磁盘/PTY：`cargo test --manifest-path src-tauri/Cargo.toml --lib mobile::`，34/34 通过（0 failed/ignored），日志 `qa-ui-auto-report/mobile-review/rust-complete.log`。
- 前端：`pnpm exec vitest run mobile-web/src src/components/settings/FeishuAdapterSettings.test.tsx src/stores/chatStore.test.ts`，最终 5 文件 50/50 通过，包括桌面 turn_in_progress 无回退/无多余消息回归（chatStore 39 项）。日志 `qa-ui-auto-report/mobile-review/frontend-complete.log`；移动设置的真实入口由 TC-MOBILE-002 覆盖。
- QA audit --gate 通过，678 个用例无 schema 错误、catalog 一致、覆盖无倒退；CI selection 规划通过。`pnpm build`（含 TypeScript、check:refactor、Mobile Web、桌面 bundle）及 `cargo fmt --check` 均通过。构建日志 `qa-ui-auto-report/mobile-review/build-complete.log`；边界/文件大小检查无例外新增。测试断言类型导入导致的前次构建失败已修正并完整重跑。
- 自动化选择：TC-MOBILE-001～004，加完整 crash-regression；Linux/Windows/macOS，browser/native，`native_release=true`。001 是手机尺寸 fixture UI，002 是真实桌面 HTTP/WS/PTY（Linux），003 是无 Display headless+真实内嵌外壳（Linux），004 是三平台设置与真实 native vault/配置持久化。其余 native 平台运行设置和完整 crash 集合，不假称已运行 Linux 专属用例。
- GitHub 新运行及原始报告核验：待执行/回填，绿色 job 不代替 passed/report_ok 与 receipt/source/build 一致性。

### 尚不能由本轮自动化证明的验收

Android/iOS 真手机、相机/PWA 安装、用户自备的两个真实 endpoint、公网 TLS→私网 PNA、真实部署日志抽检、Windows headless 操作者控制台交互、桌面退出时飞书通知专项，以及 V-08 真实飞书应用发布/消息送达/卡片按钮/仅出站环境均未取得真实证据。loopback 协议 fixture 与三平台 browser/native 通过不能替代这些验收；AC-17 真实应用验收仍为部分完成。
