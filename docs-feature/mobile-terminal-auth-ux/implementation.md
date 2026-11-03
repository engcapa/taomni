# 手机终端与连接认证

确认范围：三项一起交付；默认紧凑内置键盘，可切换系统键盘输入中文。

## 行为与边界

- 终端默认占满视口，保留旧的显式全屏偏好。顶栏只保留返回、标题、连接/控制状态、接管/释放、更多。
- 常用终端键横向单行；紧凑四行键盘直接发送 PTY 输入，支持 Shift、符号、空格、退格、回车及一次性 Ctrl/Alt。点击输出不主动打开系统键盘。
- 系统输入模式支持中文草稿；切换紧凑/系统/收起保留未发送草稿。字体、尺寸、历史、多行粘贴等操作保留在更多菜单。
- 手机打开 SSH 时可以填写本次用户名/密码，随后接收原生 SSH 的 OTP 或加密私钥口令。保险库锁定时允许填写本次密码，不向手机索取保险库主密码。
- 每轮认证只属于发起的已配对设备和打开请求；桌面与手机共享同一个 SSH 一次性响应器。先完成者生效，迟到、重复、跨设备答案被拒绝。
- 手机答案不写会话配置或 localStorage；请求失败、超时、取消、撤销设备或停止服务释放等待者。已成功打开的终端不随请求清理而关闭。
- 保留从手机新建桌面本地终端、发送命令及返回列表的路径。

原有 SSH 代理解析、保存的认证引用和重连路径保留。手机打开请求标识只在首次连接传递；重连不复用已结束的请求。

## 验收映射

| 范围 | 浏览器 | 原生/单元边界 |
| --- | --- | --- |
| 控制权、尺寸、字体、历史、复制/粘贴、快捷键、触摸滚动 | TC-MOBILE-001 | TC-MOBILE-002 |
| 紧凑键盘、Shift/符号/退格、Ctrl-C、切换系统草稿、横竖屏/矮屏、收起 | TC-MOBILE-006 | TC-MOBILE-007 实际 SSH 输入；94 项相关前端测试 |
| 用户名密码、逐轮 OTP、掩码、不持久化、取消后本地打开 | TC-MOBILE-006 HTTP/WS 独立测试端 | TC-MOBILE-007 实际 Tauri 服务、russh、加密私钥及原生 PTY |
| 隔离、迟到答案、取消原生 OTP、错误密码恢复 | 表单与草稿单元测试 | TC-MOBILE-007；66 项 mobile Rust 测试 |
| 原有无显示器服务、配对安全、保存会话/本地入口 | TC-MOBILE-001 | TC-MOBILE-003、005 |
| 设置与认证相关旧流程 | TC-MOBILE-004、122、139、143、150 | TC-MOBILE-004、139、143、150 的原生模式（122 的 open_session 仅浏览器支持） |
| 崩溃回归 | 工作流自动加入全部 crash-regression | 同标签全部原生用例及匹配 QA release |

TC-MOBILE-007 使用临时 loopback ssh2 服务、实际 SSH 加密和认证，独立记录输入并回传确定性的 shell 输出；本地终端则执行实际平台 shell。测试不依赖外部 SSH 账号，不代表真实远程 shell 环境的完整兼容性验证。

## 验证记录

开发前相关终端输入测试 20 项通过。开发后相关前端测试 21 文件/94 项通过；Rust mobile 66 项通过。浏览器 TC-MOBILE-001 与扩展后的 TC-MOBILE-006 实际执行通过。Linux QA release 下 TC-MOBILE-007 完整通过（native-auth-11/run-20261103-102755-548194255，身份稳定，1 passed / 0 failed / 0 skipped）。独立 SSH 测试端同时实现真实桌面的 shell 初始化完成协议，避免把初始化阶段隐藏的输出误判为认证失败。静态 audit --gate、类型检查、cargo check 与重构边界检查已通过。

GitHub 选择完整移动用例 001–007、SSH 回归 122/139/143/150，并自动合并全部 crash-regression，合计 90 次执行：三平台各 15 次 browser，Linux 17 次 native，Windows/macOS 各 14 次 native。平台不适用的用例由原有声明决定，不计为通过。修复 SSH 测试端后，[运行 41567717905](https://github.com/engcapa/taomni/actions/runs/41567717905)（8dc7e0b60e537d19c6d90f4f61e61549a3774f6c）90/90 全部通过，GitHub 汇总成功。独立重新聚合原始报告后，确认选中 ID、receipt、源码/runner/case 身份及三平台 QA release 二进制一致，0 失败、0 跳过、无缺失或重复。静态审核与 dry-run 不计为实际验收证据。

物理 Android/iOS 的软键盘、中文输入法和触摸手感未由桌面浏览器自动化验证。GitHub 原生覆盖 Windows WebView2、Linux WebKitGTK 与 macOS WKWebView；手机页面运行于 Playwright Chromium。

## 托管测试故障调查

运行 41564971986 的 Linux TC-MOBILE-002 保留了真实 pointer/focus 证据：滚动期间点击坐标落在 feishu-app-id 的 label，而不是 mobile-settings-toggle，服务未收到启动操作。原生输入器现在先移动同一个 W3C 鼠标，再复核目标位置与命中；仅重新准备悬停，绝不重放按钮输入。98 项 pointer/driver 合约通过，原设置/网络断言保持不变。设置页说明同步为手机可填写一次性连接凭据，保险库主密码仍只在本机输入。

点击加固与设置说明修正后，本地最终 QA release 的 TC-MOBILE-002/007 为 2/2 通过；完整原生 crash-regression 为 9/9 通过（native-final-crash/run-20261103-110915-975227120，身份稳定）。源码指纹 4facfc162f532783893d6874fb1498d519368c944f11243daf9e623f506b518e。最新全量[运行 41569156140](https://github.com/engcapa/taomni/actions/runs/41569156140)已成功结束，验证提交 dcfca476e8aea5db9879fc827219e69f99394527。GitHub 汇总与本地独立重新聚合均为 90/90 通过，0 失败、0 跳过；选中项无缺失、无重复，源码、runner、case、原始 receipt 与 QA release 二进制身份全部匹配。


| 平台 | Browser | Native QA release |
| --- | --- | --- |
| Linux | 15/15 | 17/17 |
| Windows | 15/15 | 14/14 |
| macOS | 15/15 | 14/14 |
| 合计 | 45/45 | 45/45 |

三平台构建、原生 Rust 合约和最终汇总均成功。下载的原始证据位于 `qa-ui-auto-report/mobile-terminal-auth/github-final/`；独立核验结果为 `local-verified-ci-summary.json`。此处验收记录为文档更新，执行证据绑定上述产品提交及内容指纹。

## Review 修正（本轮）

- 实时输入：紧凑键盘继续为默认；新增“直接输入”明确聚焦 xterm 并允许系统键盘，逐字符/IME 提交直接发送，不附加回车。原系统本地编辑入口标为“命令草稿”，保留中文草稿与多行面板。TC-MOBILE-006 断言 `git che` 在 Tab 前到达独立 PTY 收据；TerminalView 单元测试也验证中文提交、控制权与模式切换。
- 跳板认证：SSH transport 保留非交互公共入口，新增带 prompter 的内部入口。跳板 OTP/加密私钥和目标主机顺序使用同一请求、同一一次性响应器；挑战标题标出跳板地址。TC-MOBILE-007 验证两个真实 direct-tcpip 通道与目标终端输入。
- 锁库代理：在本次连接内展开 HTTP/SOCKS5 的手动、保存会话、应用及独立代理选择。锁定的密码引用由手机一次性补录，清除本次已展开配置中的保存会话 ID，避免后端覆盖；不修改应用代理或持久化会话。四种路由在 TC-MOBILE-007 的真实代理端点验证，保存代理选择另有单元测试。
- OpenSSH 取消：probe 和 route 准备受同一个取消令牌/截止时间约束；在 terminal registry 写锁取得后，使用请求锁原子检查有效性并执行 PTY 创建/注册。探测子进程由 kill-on-drop 释放，发布前错误显式杀死 PTY；russh 注册前也重新检查，端口转发仅在成功注册路径启动。TC-MOBILE-008 观察真实阻塞 probe PID，覆盖取消、撤销和停止服务后无晚到 PTY/注册；Rust 测试另覆盖截止时间与丢弃准备任务。
- 迟到取消：成功、失败、进度与完成回调都检查原 controller 的归属。TC-MOBILE-009 让服务器直到 B 开始轮询才返回 A 的取消响应，验证 B 继续逐轮认证；InstanceView 单元测试同时覆盖迟到失败。

新增模块均保持单一职责；保留 IPC 名称、保存格式和旧 transport 调用入口。最终本轮执行结果在验证结束后追加，前次 90/90 不视为新增场景的验收。
