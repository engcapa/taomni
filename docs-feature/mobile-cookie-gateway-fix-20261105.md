# Mobile Web：带鉴权 SLB 的配对与白屏修复

日期：2026-11-05。延续 [P0 设计](mobile-remote-p0-design.md) 的配对、安全与离线恢复契约；本次不扩展 Mobile Web i18n 或飞书能力。

## 用户复现与根因

用户通过需要浏览器登录 Cookie 的自备 SLB 打开 Mobile Web。允许准确 Host 后，静态首页与 health 可访问，但配对后路由出现 `:undefined`，随后页面空白。

1. HTTP API 固定 `credentials: "omit"`，连同源网关登录 Cookie 也不发送；网关可返回登录页、重定向或不完整 JSON。
2. JSON 解析失败原先降级为 `{}`，配对响应只有 TypeScript 静态类型、没有运行时检查。缺失的 `device_id`／`token` 被保存为坏实例，并导航到 `:undefined`。
3. 会话列表同样未校验，`{}.sessions.filter` 触发渲染异常。浏览器网络在线与网关页面返回 200 都不代表 Taomni 配对成功。

## 修复与安全边界

- 只有 endpoint 与当前页面 **完全同源** 的 HTTP API 请求使用 `same-origin`，浏览器自行携带既有网关登录 Cookie；不同源实例仍 `omit`，不启用 `include`，不读取、导出或持久化 Cookie。
- Taomni 业务权限仍由 Bearer token 授予；网关 Cookie 单独不能访问会话。Host allowlist、Origin 校验、CORS（不发送 `Allow-Credentials`）、WS 单次票据、吊销与终端写权均不放宽。浏览器 WS 自带的 Cookie 行为未改；WS 仍必须提交有效的一次性票据。
- API 使用 `redirect: "manual"`。登录跳转、HTML、非对象 JSON 显式失败；网关会话过期给出可操作的重新登录提示，不自动跟随到登录页。
- 配对必须返回非空字符串 `device_id` 和 `token` 才能保存与导航；失败保留表单和重试能力，不消费本地实例槽位。
- 会话列表先检查数组及条目契约，再交给渲染；无效响应显示错误、保留已有列表与配对，可手动恢复，不再 `.filter` 崩溃。
- WS ticket 必须为非空字符串；无效网关响应暂停重连并给出手动入口，不创建 `ticket=undefined` 的连接。
- 读取旧本地实例时过滤缺失凭据／无效 endpoint 的记录，保留有效设备；旧坏路由显示“实例不存在”与添加入口，而非再次加载坏实例。未清空整个浏览器站点数据。

## 回归设计

- Vitest：同源／跨源 Cookie 策略、Bearer 保留、302／opaque redirect、200／401／403 HTML、413 原映射、缺失／空／类型错误的配对凭据、旧坏实例与路由、畸形会话列表、无效 WS ticket 与手动恢复。
- Loopback cookie gateway：真正的 HTTP 反向代理与 WS upgrade/tunnel；fixture-only 登录发 HttpOnly Cookie。向真实后端转发时剥离 Cookie，保留 Origin 与 Bearer；receipt 仅记录脱敏 route、method、是否携带 Cookie／Bearer、upgrade 与 status，不记录凭据、票据、配对码、终端字节或文件内容。
- Browser TC-MOBILE-012：production Mobile Web + 确定性 peer，验证网关鉴权、坏响应不保存／不导航／不白屏、过期重新登录恢复及跨源不携带 Cookie。不能代替 Rust 原生证据。
- Native TC-MOBILE-013：匹配源码的 QA release 内嵌 Mobile Web + 真实 Settings listener，通过带 Cookie 的网关配对、会话、事件流、新建实际终端、接管、执行独立磁盘 marker、释放，检查真实桌面 pane 与清理。
- 两个 case 都标记 `crash-regression`。执行受影响 mobile 用例，并按要求保留完整 browser/native crash-regression；旧 82/82 仅属于前次源码，不能当作本修复验收。

## 本机证据

- 修复前已复现坏配对及 `.sessions.filter` 渲染异常；修复后全部 Mobile Web Vitest **17 文件、77 项通过**，严格 mobile TypeScript 与 production bundle 构建通过。
- gateway 转发隔离单测及跨平台 PTY marker 命令合约共 **5 项通过**。
- 旧原生内嵌 bundle 反向复验：`qa-ui-auto-report/mobile-cookie-old-bundle-baseline-20261105/`。HTML 注入后旧配对表单消失并错误进入实例页，首个“显示有效 API 错误、不得导航”断言失败（exit 1）；保留失败 receipt 与遮蔽配对码的截图，不计为通过。
- 第一次真实服务连贯 probe **8 个检查通过**：`qa-ui-auto-report/mobile-cookie-split-probe-20261105-01/`。包含真实 PTY 写入独立 marker、Cookie 过期恢复及不同源请求不携带 Cookie。此轮用新 production assets 覆盖旧已验收 Rust 后端的静态页，**只证明新前端与真实服务的兼容，不冒充新原生二进制部署证据**。
- 首次本机新 QA release 已编译成功：`qa-ui-auto-report/_local/mobile-cookie-native-build-20261105.log`，Rust release 编译 52m57s，`com.taomni.app.qa` 身份记录生成，进程 exit 0；既有 Rust warnings 与 `imap-proto` future-incompat 提示未改。下一次机器重启后 `src-tauri/target`、Cargo registry、Node 临时工具链与旧 listener 均已消失，日志保留；因此不能凭这次成功日志声称已部署。重新构建将使用持久报告目录下的独立工具链／target／产物备份。
- 重启恢复时，`pnpm check:refactor` 因 `node_modules` 中 TypeScript 缺失报 `ERR_MODULE_NOT_FOUND`；正在用 pnpm 10 + frozen lockfile 恢复依赖。这是本次环境恢复失败，不能把前一轮通过记录当成重启后的新通过。
- 阶段性提交 `6ca69d600`（产品）与 `da4d0917d`（QA）已推送。新 hosted 尝试 `42051125929` 在 checkout 前因 dispatch 的 head 输入笔误失败；改为直接读取 `git rev-parse HEAD` 后，`42051558982` 到达 plan，但 mandatory crash contracts 发现新 case 未同步到固定 EXPECTED／smoke 集，4 项中 2 项失败，未执行产品用例。补齐 browser-only／native-only 集及 smoke 注册后，本地 `test_crash_regressions` **4/4 通过**，没有缩减完整 crash 选择；后续新 run 独立记录，不把 plan 失败或 aggregate 绿色当作验收。
- 本次提交为防重启丢失的阶段性源码产物，不是交付完成：无 assets override 的新二进制复验、8787 部署、新 browser/native 完整 crash-regression 与 hosted 结果仍待实际执行后补录。

## 部署约束与手工验收

- 使用 `com.taomni.app.qa`、独立 profile、本机 `127.0.0.1:8787`。用户自行管理 SLB／公网；仅保留用户指定的准确 Host，不修改防火墙，不使用真实账号／飞书／外网模型。
- 前端 bundle 嵌入 native 二进制；仅 `build:mobile` 或刷新页面不能替代重新编译／切换原生服务。新服务须通过 build identity 与当前源码指纹核验。
- 更新有版本化 Service Worker。旧标签首次刷新可能仍由旧 worker 提供；等待更新后再次刷新，或关闭并重新打开该站点。不要求清除全部浏览器数据或交出网关 Cookie。
- 配对码只放本机 mode-600 文件，5 分钟单次有效；部署后重新生成。实际 Android 软键盘／IME、PWA 安装与 SLB 真实登录仍由用户手工验收；iOS 和真实飞书仍未验证。
