# 2026-11-05 本机 Linux：真实服务 + 模拟手机 E2E

用户要求在配合 Android 真机前，先在当前本机验证实际 Mobile Web 端到端；不连接真实飞书。本记录与 [当前 82 项 hosted 验收](mobile-recovery-i18n-implementation.md) 分开，不将浏览器 stub 结果当作真实移动服务证据。

## 被测对象与隔离

- 从已全过的 GitHub run `41946131514` 下载 Linux runtime，使用仓库 `ci_native_artifact.install` 校验整份 archive／selection／原始 identity 后安装；未重新编译或手写 provenance。
- QA identifier `com.taomni.app.qa`，release binary SHA-256：`06f5c58cbfe36a7572e5e68f81afc19d46de0603e67504f48ba672e4d5f522da`，source：`7a8d9a9b0d9fb192d3b30c69d882ecc6c521a3e4ad7f3a144b2256f81e6b8101`。
- 本机 Linux glibc 2.35，可运行 Ubuntu 22.04 baseline 产物；使用已有 PipeWire 1.0.9 用户缓存的运行库。NativeHarness 保持 QA data/config/cache 隔离，在新建 Xvfb + D-Bus + Openbox 会话运行，不触碰当前 `/usr/bin/taomni` 生产进程。
- 模拟手机为 Playwright **1.55.0 + Chromium 140**，390×844、mobile/touch context；页面由真实 Rust 服务提供内嵌 production bundle，不使用 Vite stub 或改写 `/api/v1` 业务响应。
- Agent 的上游只用独立 loopback HTTP 模型 peer，无个人 API key、云请求、模型费用或真实飞书外联。它返回确定性文本；不声称验证实际云模型质量、真实 Agent 工具决策或飞书送达。

## 原有真实边界用例

本地执行 TC-MOBILE-002/003/005/007/008/010，原件：`qa-ui-auto-report/mobile-real-native/run-20261105-121602-191661644/`。

- 002、003、005、007、010：**5 passed**，实际 PTY、配对鉴权/吊销、无 Display headless、手机委托本地/保存会话、真实 SSH 密码/OTP/加密私钥/跳板/代理、真实设置多语言均通过。
- TC-MOBILE-008 初次在 1440×1000 桌面遇到撤销按钮尚未找到的原生 UI 时序失败，保留 receipt（未完成检查，不算通过）。未改产品、脚本或断言，按 hosted 的 1920×1080 隔离桌面单独复验：`qa-ui-auto-report/mobile-real-native-cancel/run-20261105-122243-744251334/`，**1 passed / 0 failed / 0 skipped，identity_stable=true，exit 0**。三个真实子进程的 cancel/revoke/stop 均终止，无迟到 PTY/broker 注册。

六个用例均已有本机实际通过证据，但首轮 5/6 失败记录保留，不改写为首次全过。

## 连贯的真实服务手机流程

本地验证脚本保留于 ignored `qa-ui-auto-report/_local/mobile-real-phone-e2e.py`；产物 `qa-ui-auto-report/mobile-real-phone-e2e/`。

真实桌面 IPC 仅用于准备独立的本地模型配置、桌面创建测试线程并授予真实项目根（与桌面发起轮次相同契约）；配对、打开终端、终端输入、Agent 后续指令、停止、文件/diff 和重连均通过公开 Mobile Web UI 执行。项目为新建可丢弃 Git 仓库；文件越界另以实际 HTTP 请求验证。

`local-real-phone-receipt.json`：**passed=true，12 项全部通过，page_errors=[]，runner exit 0**。

1. 通过真实 Settings 启动固定 `127.0.0.1:8787` listener。
2. 手机 UI 配对，连接实际实例事件流。
3. 手机创建真实本地 PTY 并输入命令；独立 host 文件与桌面 terminal buffer 双重确认执行结果，不以命令回显充数。
4. 手机释放，再接管；真实桌面按键抢回，手机回只读。
5. 网络离线/恢复，真实终端流重连，生命周期与已有输出保留。
6. 实际任务根的 Git changes、文件全文、unified diff 从服务读取并显示。
7. host 新建第二文件后，真实 notify 监听自动更新手机改动列表，不依赖终端 WS。
8. 真实服务拒绝任务根路径上跳。
9. 手机后续指令经过实际 Agent 轮次和 loopback provider，数据库持久化 user/assistant 历史。
10. 手机停止真实在途 Agent 请求。
11. 缓存实际内嵌 PWA，断网 reload 可见离线提示和实例；恢复联网连接成功。
12. 桌面吊销设备，真实手机收到吊销、停止授权重试。

截图已读取检查：`phone-real-pty.png`、`phone-real-agent-files.png`、`phone-real-offline-shell.png`。没有空白页面；终端真实输出、只读 diff、离线提示及注册实例可见。桌面 runtime snapshot 无 uncaught/unhandled/app-crash。

准备脚本曾因 `python -I` 不读取用户 site-packages 而缺 pyee，在创建任何 app/服务前退出；已只向专用 venv 安装该依赖后完成正式流程，不把依赖加载失败当业务通过。

## Android 后续

用户确认仅 Android 为本轮真机目标；iOS 不推定通过。用户自行完成网络，实例仍在本机 Linux。完成上述模拟后再准备新的隔离手工 profile（`qa-ui-auto-report/mobile-android-ready/`），拟固定 loopback **8787**。实际 ready/health 与监听检查成功后才交付端口；不改系统防火墙或公网入口。若用户反向代理保留外部 Host，仅把明确的 host[:port] 加到该 QA profile 的 `mobile-listener.json`，不关闭 Origin/Bearer 检查。

手工实例已实际启动并健康核对：**`127.0.0.1:8787`** 真实由 QA taomni 监听，`GET /api/v1/health` 返回 `service=taomni-mobile`、`run_mode=desktop`、`shell_available=true`。该 profile 准备了真实本地终端及带 Git 改动的测试任务，Agent 仅连接本地模拟模型，飞书未连接；生产 `/usr/bin/taomni` 进程保持不变。启动 job 状态在 `qa-ui-auto-report/_local/mobile-android-ready.log.job.json`，手工 profile 与只允许同用户访问的 Unix 控制 socket 在 `qa-ui-auto-report/mobile-android-ready/`。

手工配对码只写本机 mode-600 文件 `qa-ui-auto-report/mobile-android-ready/pairing-code.txt`，不进入日志、文档或公开 URL；使用前生成新的 5 分钟一次性码。用户网络转发指向 `127.0.0.1:8787`，若保留外部 Host，必须提供真实访问 authority 并只配置到该 QA profile 的 allowlist。公网访问应 HTTPS；HTTP 仅可用可丢弃测试数据。真实飞书仍待用户准备企业自建测试应用并明确测试目标后执行。
