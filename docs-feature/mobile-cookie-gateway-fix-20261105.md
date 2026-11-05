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
- 依赖恢复后，Node 22.23.4 + pnpm 10.33.0 的 `check:refactor` 与全部 mobile Vitest **17 文件／77 项重新通过**，没有更改依赖锁文件。Playwright 1.55 + Chromium 140 的新 browser case **1/1**、完整 browser crash-regression **9/9**、受影响 mobile **6/6** 均实际执行并通过（0 failed／0 skipped，receipt exit 0、签名 valid、identity_stable=true）：
  - `qa-ui-auto-report/mobile-cookie-browser-focused/run-20261105-231735-842418600/`
  - `qa-ui-auto-report/mobile-cookie-browser-crash/run-20261105-231755-046359713/`
  - `qa-ui-auto-report/mobile-cookie-browser-retained/run-20261105-232020-170084153/`
- 当前源码指纹 `931ed079924ed4d5770e3c349d10150b4e216551daf2388e1c0e4a960721de2e`，runner `6158bf1275e5e8017a270a9dc381a9f1f0185c5d651e5f1277297fad2de1a6d5`。新 hosted [42053151261](https://github.com/engcapa/taomni/actions/runs/42053151261) 测试 `edeba3942a191df0f902ae529f99119d8747ce15`：selection 已下载核对同一身份、无 gaps/unreviewed；Linux browser 15 + native 17、Windows/macOS 各 browser 15 + native 13，合计 **88 项**，保留完整 crash 选择。当前仍在执行，不能提前记为通过。
- `42053151261` Linux browser 原始 artifact 已独立读取：**15/15 passed**、稳定来源、receipt exit 0／valid。Linux build 的 Python gate 随后发现另一处固定 smoke 预期未包含 TC-MOBILE-013（`test_ci_selection` 多 Linux profile 的 4 个 subtest 失败，149 项 suite 停止），没有生成 Linux 新原生执行证据；补齐预期，不移除 case，`test_ci_selection + test_crash_regressions` **25/25 通过**。该次最终结论仍不能宣称全绿，旧 runner 证据不混入新 run。
- 本机持久目录编译中，sherpa-onnx 1.13.8 上游归档下载被截断而失败（`response body closed before all bytes were read`）；保存失败日志。经已有本地代理完整下载并对照上游 GitHub asset digest 验证 SHA-256 `e1fdc5b67530e15741ef897fa5ffff297056f3bf0c6d829a27af9225a4c4b5a6` 后，通过上游提供的 `SHERPA_ONNX_ARCHIVE_DIR` 离线输入重试，保留增量编译缓存，不修改产品依赖或 Rust 代码。
- 离线归档重试的本机 QA release **编译成功**（增量 Rust release 7m37s，exit 0），identity 当前源码匹配。二进制 SHA-256 `8c1390056fb57ea8c9ebc2d99110a7d9304951f972b2ff4565ac99696a67a1a6`，`com.taomni.app.qa`；已将二进制与真实 identity record 一并备份到 `qa-ui-auto-report/mobile-cookie-built-release/`，构建缓存和 registry 在 `_local/` 下保留。
- 新原生 TC-MOBILE-013 实际执行 **1/1 passed、0 skipped、exit 0、稳定来源且 receipt valid**：`qa-ui-auto-report/mobile-cookie-native-focused/run-20261105-234933-382337191/`。没有 assets override，真实加载新内嵌 bundle，通过 8 项网关检查、真实 PTY 磁盘 marker、只一个桌面 terminal tab/pane、关闭服务后 pane 保留及 runtime errors 检查；手机／桌面截图已打开检查。当前 runner 因补齐 smoke 契约更新为 `38edbc52d9801d836d959a36290e7ffc11ca917cc050dff2fd90f617b7e0687a`，源码指纹不变。
- 与 hosted Linux build 完全相同的 Python gate 本机成功结束：149 项中 **148 passed／1 existing skipped**，exit 0；`qa-ui-auto-report/_local/mobile-cookie-hosted-build-contracts-20261105.log`。这不是 149 个产品 UI 场景通过。
- 后续统一 hosted [42058970983](https://github.com/engcapa/taomni/actions/runs/42058970983) 已触发，head `3488be2bc6f9480be9fc796b9abf6f315eb0e2a2`，仍保留相同 88 项全部 mobile 与完整 crash 选择。前次失败 run 不删除、不混合为统一通过。
- 本机完整 native crash 首轮 **1 passed／9 failed／0 skipped**，来源稳定，失败原件：`qa-ui-auto-report/mobile-cookie-native-crash/run-20261105-235004-037781239/`。独立 native case 通过不替代整组。多数编辑器 exact-byte 失败实际输入 `QA-...` 而非要求的 `QA_...`；诊断 trace 显示 keydown `_`、beforeinput/input `-`。同一二进制的独立真实 WebView 探针进一步复现 `_→-`、`+→=`、`:→;`。QA W3C 输入在 Linux 对这些字符显式持有 Shift 后，7 个相同输入值逐字节全部一致（baseline/candidate 证据分别在 `mobile-cookie-native-input-baseline/`、`mobile-cookie-native-input-candidate/`）；不修改 editor 内容、不放宽 exact 断言，非 Linux 动作保持不变。首轮另有 screenshot timeout，复验仍须观察。
- 新 case 的 open-sessions `click` 后即时 `assert_count` 偶发读到异步回落值；失败截图后续已 checked。改用现有 `set_check` 真实指针操作及读取状态的完成确认，保留原 checked 数量断言与后续实际 PTY 检查，不增加硬编码 sleep，不改产品设置行为。
- 修正输入后再次整组 native 实跑为 **6 passed／4 failed／0 skipped**：`qa-ui-auto-report/mobile-cookie-native-crash/run-20261106-000649-720091417/`。underscore 导致的编辑器／磁盘 exact-byte 失败已消失；余下三项在 screenshot 阶段 timeout，一项冷重启因环境缺少 `wmctrl` 失败，未删截图或冷启动断言。发现手动 Xvfb 启动遗漏 hosted 桌面既有的 `xcompmgr`；用发行版包 SHA-256 核验后只解包到忽略的本机工具目录，补齐 compositor、wmctrl 与 xset，不改系统/用户桌面。后续使用同一二进制与 runner 重跑完整集合；这仍不是预先认定环境为唯一根因或通过。
- 最终冻结 runner `270df842b8092ebe990a3576302caf1e2c1708d8241d2c38d384b067686c7f4b` 的 browser 完整 crash **9/9**、稳定来源、exit 0：`qa-ui-auto-report/mobile-cookie-final-browser-crash/run-20261106-001141-909121221/`。配套原生 keyboard/contenteditable/transport/fill 合约 **77/77**，macOS paced-input JS **2/2**；既有产品及设置 Vitest **20 文件／92 项**。
- 最终统一 hosted [42061539325](https://github.com/engcapa/taomni/actions/runs/42061539325) 测试 `f6937302c8b252bf7aca055be3bb911fb835b28d`，selection 已下载核对同一 source／最终 runner，仍为 **88 项**、无 gaps／unreviewed。后续 docs-only 提交不改变被测产品或 runner；前次来源报告不混入此 run。
- 补 compositor 后完整 native 第三轮 **5 passed／5 failed／0 skipped**：`qa-ui-auto-report/mobile-cookie-native-crash/run-20261106-002047-165358838/`，身份稳定；5 项失败都在 screenshot（TC-WS-039／045／051／053／054），没有删除截图、缩减选择或改写失败为成功。补环境依赖并未解决本机 WebKit 截图问题，完整 native crash 验收仍阻塞，须继续诊断或核对 matching hosted 结果。
- 与本功能直接相关的 retained native **7/7 passed、0 failed／0 skipped、exit 0、稳定来源、receipt valid**：`qa-ui-auto-report/mobile-cookie-native-retained/run-20261106-003641-949732233/`。包含 TC-MOBILE-002／003／004／005／007／008／010，真实 listener／PTY、无 Display headless、飞书设置存储边界（非真实飞书）、委托打开／一次性连接认证／实际 OpenSSH 子进程取消、设置多语言均执行。
- **2026-11-06 本机 8787 已部署并独立复验通过**。运行备份的匹配 release、独立 QA profile `qa-ui-auto-report/mobile-cookie-android-manual-20261105/`，监听仅 `127.0.0.1:8787`。准确公网 Host health=200、未持 Bearer 的业务 API=401、不批准 Host=403。部署中的 index／JS／CSS／版本化 SW 字节哈希均与当前 production bundle 相同；不是旧二进制加 assets override。证据 `deployment-verification.json` 只记录文件路径与哈希，不含配对码。
- 在实际 **8787 新内嵌 bundle** 上，带 cookie 鉴权回环网关的连贯 probe **8/8 检查通过、page_errors=[]、assets_override=false**：`qa-ui-auto-report/mobile-cookie-embedded-real-e2e-20261105/`，含真实 PTY 执行独立磁盘 marker、Cookie 过期重新登录、无效响应不导航／不白屏、跨源 Cookie 隔离。手机页面和终端截图已打开检查；不将模拟网关等同用户真实 SLB 登录或 Android 硬件证据。
- Hosted `42061539325` 已结束，独立下载全部原始报告并重新聚合：**86 passed／2 failed／0 skipped（88 项）**，不是通过。15 份 receipt 与 1261 个关联文件的大小／SHA-256 核验一致、artifact_errors／comparison_errors 为空；证据 `qa-ui-auto-report/hosted-evidence-qo1gz0s9/verification-result.json`。三平台 browser 各 **15/15**；Linux native **16/17**、Windows native **13/13**、macOS native **12/13**。完整 hosted crash tag **57/57**、0 failed／0 skipped；TC-MOBILE-012／013 六个平台模式组合全过，含三平台真实 native gateway／PTY。
- 两个失败都为 TC-MOBILE-010 的第一项 QR aria-label：用例等待配对 code 元素后立即读取尚未完成动态 import 的 QR，native `assert_attribute` 没有 Playwright 式等待。失败后采集的 Linux／macOS HTML 已有正确英文 QR 标签、无设置错误；不凭事后截图把失败记通过。把原 step13 的 `wait_for(code)` 改为 `wait_for(qr)`，仍检查同一英文／中文精确 aria-label、草稿保留与真实启停，无固定 sleep、无放宽期望、不改产品或重建 binary。更正后的本机 browser／native 各 **1/1**、0 skipped、稳定来源、exit 0／receipt valid，证据 `mobile-settings-qr-browser/`、`mobile-settings-qr-native/`。
- 手工验收环境持续可用，不代表全部开发验收完成：本机 native screenshot failures 保留，统一 88 项须在 QR 用例修正后重新执行；真实 Android、SLB 公网登录与真实飞书仍分别由用户协作验证。

## 部署约束与手工验收

- 使用 `com.taomni.app.qa`、独立 profile、本机 `127.0.0.1:8787`。用户自行管理 SLB／公网；仅保留用户指定的准确 Host，不修改防火墙，不使用真实账号／飞书／外网模型。
- 前端 bundle 嵌入 native 二进制；仅 `build:mobile` 或刷新页面不能替代重新编译／切换原生服务。新服务须通过 build identity 与当前源码指纹核验。
- 更新有版本化 Service Worker。旧标签首次刷新可能仍由旧 worker 提供；等待更新后再次刷新，或关闭并重新打开该站点。不要求清除全部浏览器数据或交出网关 Cookie。
- 配对码只放本机 mode-600 文件，5 分钟单次有效；部署后重新生成。实际 Android 软键盘／IME、PWA 安装与 SLB 真实登录仍由用户手工验收；iOS 和真实飞书仍未验证。
