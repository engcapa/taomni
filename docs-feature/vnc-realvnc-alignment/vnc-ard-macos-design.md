# VNC：macOS 屏幕共享 Apple Remote Desktop 认证（ARD，RFB 安全类型 30）

状态：已实现并通过 GitHub macOS runner 真机验证（实现 `0634bc38`，TC-152 通过于 run 36816249372、36823635412、36830413420、36830421897）；任务板卡片 VNC-AUTH-001。来源：用户要求“补充对 macOS 的 ARD 协议的支持，并在 GitHub runner 上做 native 真机测试”（2026-10-01）。

## 1. 目标与范围

macOS 自带的屏幕共享（`screensharingd`）默认只提供 ARD 认证：用 macOS 账户名和密码登录，不要求另设“VNC 密码”。此前 Taomni 只支持 None / VNCAuth / RA2 / RA2ne / RFB 18，连接未勾选“VNC 用户可以使用密码控制屏幕”的 Mac 时报“无受支持的安全类型”。

本次范围：

- 原生（Tauri）VNC 客户端支持安全类型 30，三端同一套 Rust 实现。
- 会话已填用户名时优先 ARD；缺用户名时连接面板的认证浮层要求填写账户名。
- hosted CI 在 macOS runner 上打开真实屏幕共享，用 TC-152 走完整 UI 登录。

不在范围：浏览器开发预览桥（`vite-plugins/vncBridge.ts`）仍只支持 VNCAuth/None；Apple 私有扩展（3.889 的会话选择、加密会话、剪贴板扩展）不实现。

## 2. 协议事实（与 noVNC、libvncclient 一致）

1. 服务器宣告 `RFB 003.889`；客户端回 `RFB 003.008`，之后按 3.8 语义（安全结果带失败原因）。代码：`src-tauri/src/vnc/rfb.rs` 版本协商。
2. 选择类型 30 后服务器发送：`u16 generator`、`u16 keyLen`、`prime[keyLen]`、`serverPublic[keyLen]`（macOS 为 128 字节，即 1024 位 MODP）。
3. 客户端生成私钥 `x ∈ [1, p-2]`，`clientPublic = g^x mod p`，`shared = serverPublic^x mod p`；两者都左补零到 `keyLen` 字节。
4. AES-128 密钥 = `MD5(shared)`；明文 128 字节：`username[64]` + `password[64]`，各自 UTF-8 后跟 NUL，其余为随机字节；AES-128-ECB 加密。
5. 客户端依次发送 128 字节密文和 `clientPublic`，然后读标准 SecurityResult。

只有凭据被加密，帧和输入仍是明文，所以 ARD 计为“未加密会话”。

## 3. 决策

| ID | 问题 | 结论 | 理由 | 状态 | 关联 |
|---|---|---|---|---|---|
| DEC-ARD-1 | Mac 同时提供 ARD 与 VNCAuth（开启了 VNC 密码）时选哪个 | 顺序：RA2 > RA2ne > ARD（会话有用户名）> VNCAuth > ARD（无用户名）> None（仅 allow-none）。`PreferOff` 有用户名时先 ARD | 用户名表明用户要用 macOS 账户登录；只配了 VNC 密码的旧会话行为不变；只有 ARD 时仍选 ARD，由认证浮层补账户名，而不是报“无受支持类型” | agent 自决 | AC-ARD-1、AC-ARD-3 |
| DEC-ARD-2 | ARD 是否算加密 | 算未加密：`RequireEncryption` 拒绝，其他策略先弹未加密警告（DEC-VNC-19 流程） | 仅凭据加密，会话明文，与 RA2ne 处理一致 | agent 自决 | AC-ARD-4 |
| DEC-ARD-3 | 用户名/密码超过 63 字节或含 NUL | 报认证错误，不截断 | noVNC 静默截断会让用户以为密码错误；明确报错更可诊断 | agent 自决 | AC-ARD-2 |
| DEC-ARD-4 | hosted runner 用哪个 macOS 账户登录 | 每个 job 新建一次性管理员账户 `qaard`，不改 `runner` | `runner` 持有 SecureToken，root 也无法不提供旧密码就改密（CI 实测 `dscl -passwd` 返回 eDSAuthFailed -14090）；改 console 账户还会让登录钥匙串与密码不一致 | agent 自决（CI 证据） | TASK-ARD-4、V-ARD-4 |
| DEC-ARD-5 | 屏幕共享开不起来时 | 记录原因与诊断，只让 `ard_required` 用例失败，同 job 的其他 macOS 用例照常执行 | runner 上的屏幕共享是新依赖，不能拖垮约 150 条 macOS native 用例；失败仍以用例失败呈现，不是 skip | agent 自决 | TASK-ARD-4 |
| DEC-ARD-6 | runner 上 TC-152 断言什么 | 断言 ARD 登录后进入已连接状态，会话信息显示 ARD 与 Mac 宣告的桌面尺寸；不断言帧绘制。探测登录后和每条 ARD 用例后注销 `qaard` | 第二个账户的 ARD 登录会让 macOS 把控制台切给该账户（实测 `stat -f %Su /dev/console` 由 `runner` 变为 `qaard`），被测应用所在会话转入后台、不再绘制（已连接但 `data-vnc-frames-painted=0`）；注销后控制台回到 `runner`，后续用例正常。帧像素已由 TC-151 在三端覆盖。备选：用 `kickstart` 开远程管理并给 `qaard` 观察/控制权限，使其共享当前控制台会话；macOS 12.1 起该途径受限，未验证，留作后续 | agent 自决（CI 证据） | AC-ARD-7、V-ARD-4 |

## 4. 验收

- AC-ARD-1：`VncSecurityPolicy::choose_with_username` / `choose_outer_with_username` 按 DEC-ARD-1 选择；`RequireEncryption` 拒绝 30；`security_type_kind(30)` 为 `Ard`（未加密、已认证）。
- AC-ARD-2：`ard_response` 生成的密文用服务器私钥可解出原用户名和密码（含非 ASCII）；参数非法（g<2、p≤3、服务器公钥不在 (1, p-1)、keyLen 不在 64–1024）或字段超长时报错。
- AC-ARD-3：只提供 ARD、会话未填用户名时，错误归类为 `authentication-failed`，连接面板显示带用户名输入框（`vnc-auth-username`）的认证浮层；填写后重连成功。
- AC-ARD-4：选择 ARD 且未确认未加密时，先返回“unencrypted connection requires confirmation”，确认后才发送凭据。
- AC-ARD-5：会话信息对话框的安全项显示 `ARD (Apple Remote Desktop)`。
- AC-ARD-6：`RFB 003.889` 按 3.8 协商。
- AC-ARD-7：GitHub macOS runner 上开启真实屏幕共享，TC-152 通过会话编辑器用 macOS 账户登录并进入已连接状态，会话信息显示 `ARD (Apple Remote Desktop)` 和 Mac 宣告的桌面尺寸（DEC-ARD-6：不断言帧绘制）。

## 5. 实现

| 任务 | 文件 | 内容 |
|---|---|---|
| TASK-ARD-1 | `src-tauri/src/vnc/policy.rs` | `VncSecurityType::Ard`、带用户名的选择函数、类型 30 映射与测试 |
| TASK-ARD-2 | `src-tauri/src/vnc/rfb.rs`、`Cargo.toml`（`md-5`） | `vnc_auth_ard` 读取 DH 参数并发送应答；`ard_response` 纯函数；伪 macOS 服务器测试 |
| TASK-ARD-3 | `src-tauri/src/vnc/tls.rs`、`ws.rs`、`mod.rs` | 外层协商带 `has_username`；类型 30 计入未加密确认；relay 与“测试连接”传入用户名是否存在 |
| TASK-ARD-4 | `.agents/skills/qa-ui-auto/scripts/ci_services.py`、`qa_ui_auto/fixtures/ard_required.py`、`qa_ui_auto/ci.py`、`ci_execute.py`、`report_secrets.py`、schema | `ard` hosted 能力：建 `qaard`、`launchctl` 启用屏幕共享、用独立 Python 实现（openssl CLI 做 AES）完成一次 ARD 登录作为就绪探测；密码只在 `QA_ARD_PASSWORD` 并从报告脱敏；失败按 DEC-ARD-5 处理 |
| TASK-ARD-5 | `qa-ui-auto-tests/cases/TC-152-vnc-macos-screen-sharing-ard-login.testcase.yaml`、`ci/policy.yaml`、`feature-list.md`（F9.2、F9.6 `menu-info`） | 仅 macOS native 的 UI 用例 |
| TASK-ARD-6 | `src-tauri/src/qa_driver.rs` | macOS WKWebView QA 桥的元素点击补发 pointerdown/pointerup（带坐标），否则只认 pointer 事件的 VNC 画布收不到点击（TC-151 macOS native 曾因此失败） |

后续（未排期）：浏览器预览桥支持 ARD；会话编辑器对 macOS 目标提示“填写 macOS 账户名”。

## 6. 验证

| ID | 覆盖 | 方法 | 结果 |
|---|---|---|---|
| V-ARD-1 | AC-ARD-1、AC-ARD-2、AC-ARD-4、AC-ARD-6 | `cargo test --lib vnc::`（`policy::tests::ard_is_chosen_for_mac_servers_by_username`、`rfb::tests` 的 `ard_*` 与伪 macOS 服务器 `RFB 003.889` 用例、`tls` 未加密确认用例） | Windows 11 本机：104 passed，4 ignored（2026-10-01，含 V-ARD-2） |
| V-ARD-2 | AC-ARD-3（后端归类） | `cargo test --lib vnc::error`（`ard_failures_reopen_the_credential_prompt`） | Windows 11 本机通过；前端浮层沿用既有 `authentication-failed` 路径，未单独做 ARD UI 用例 |
| V-ARD-3 | TASK-ARD-4 | 工作流同款 `python -m unittest test_ci_selection … test_dev_contract`（仓库根目录，`PYTHONPATH=.agents/skills/qa-ui-auto/scripts`）；`ArdProbeTest` 让探测脚本对接独立的伪 ARD 服务器 | 50 tests OK |
| V-ARD-4 | AC-ARD-5、AC-ARD-7 | `qa-ui-auto-platforms.yml`：`scope=selected`、`case_ids=TC-151,TC-152`、`platforms=macos`、`modes=native` | 通过（run 36816249372，见第 7 节） |
| V-ARD-5 | 回归 | TC-151 六种组合；macOS native 全量（QA 桥点击改动） | TC-151 六种组合均通过（36812486776 五种 + 36816249372 macOS native）；macOS native 全量无本分支引入的失败（36816259855） |

三端：ARD 是平台无关的 Rust 代码，Windows/Linux 客户端连 Mac 走同一路径；真实 Mac 服务器只在 hosted macOS runner 上验证，Windows/Linux 客户端到真实 Mac 的连接未验证（需要局域网内的 Mac：会话填 macOS 账户名和密码，确认未加密警告后应看到桌面，会话信息显示 ARD）。

## 7. 证据

hosted 运行（`qa-ui-auto-platforms.yml`，分支 `feat/vnc-realvnc-alignment`，macOS 为 `macos-15` ARM64）：

| 运行 | 提交 | 范围 | 结果 |
|---|---|---|---|
| 36812486776 | `3176012f` | TC-151、TC-152，三端 × browser/native | TC-151 在 Linux/Windows 的 browser 与 native、macOS browser 通过；macOS native 在准备阶段失败：`dscl . -passwd /Users/runner` 返回 eDSAuthFailed（-14090）→ DEC-ARD-4 |
| 36813401754 | `084fb8fc` | 同上，仅 macOS native | ARD 就绪探测成功：`RFB 003.889`，安全类型 [30, 33, 36, 35]，`qaard` 登录后 ServerInit 1024×768；随后桌面探测脚本 90 s 超时 |
| 36814472534 | `d2b5138a` | 同上 | TC-151 通过（QA 桥点击修复生效）；TC-152 失败：已连接（会话工具栏出现）但 0 帧绘制；`services/screensharing-sessions.txt` 显示登录后控制台归属 `qaard` → DEC-ARD-6 |
| 36816249372 | `872d61f9` | 同上 | **TC-151、TC-152 均通过**（TC-152 58 s：ARD 登录、已连接、会话信息显示 `ARD (Apple Remote Desktop)` 与桌面尺寸） |
| 36816259855 | `872d61f9` | macOS native 全量（79 条） | 77 通过；2 条失败均非本分支引入：TC-IDE-C0-03 在 main 夜间运行三端同样失败，TC-REPRO-SAVE-01 的修复（`2b6f072c`）在 main 上、尚未进入本分支 |
| 36823635412 | `0c7746b9` | TC-151、TC-152，三端 × browser/native | 全部通过（TC-152 30.7 s） |
| 36828540657 | `37b83c09` | TC-151、TC-152、TC-153，三端 × browser/native | TC-151、TC-153 全部通过；TC-152 在等已连接工具栏时 45 s 超时（等待本身用了 52.8 s），失败快照里工具栏已出现。控制台切到 `qaard` 后，转入后台的应用响应 WebDriver 桥很慢：此前两次通过时“等工具栏 + 下一次点击”分别为 49.7 s（6.9 + 42.8）与 25.9 s（15.4 + 10.5）。断言不变，登录后的两次等待放宽到 120 s（`a209dfa6`） |
| 36830413420 | `a209dfa6` | TC-151、TC-152、TC-153，仅 macOS native | 全部通过；TC-152 等已连接工具栏 49.7 s（旧的 45 s 上限会失败） |
| 36830421897 | `a209dfa6` | 同上（与上一行并行的第二次） | 全部通过；TC-152 等已连接工具栏 71.2 s，之后点击 1.0 s |

TC-152 登录后的等待在当前用例形态的 5 次运行里为 6.9–71.2 s（一次在 45 s 上限超时），波动来自控制台切换期间应用转入后台；120 s 上限约为观测最大值的 1.7 倍，再超时就需要先查控制台切换耗时，而不是继续放宽。

原始产物在本地 `qa-ui-auto-report/hosted-<run>/`（不提交）。
