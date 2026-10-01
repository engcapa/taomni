# MFA 验证器（TOTP / HOTP）详细设计

## 1. 设计摘要与范围

- 类型：新功能
- 文档位置：`docs-feature/mfa-authenticator-design.md`
- 设计状态：可实施（DEC-01～DEC-03 用户已定，其余 agent 自决并记录依据）
- 来源：2026-10-01 会话需求——MFA 放到 Tools 菜单；先本地存储到独立 SQLite 库，备份包含该库；支持密钥导入、截图二维码、摄像头扫码（有摄像头时）；验证码方便复制；多账户方便查找、排序；编写 browser/native 全部 qa-ui-auto 用例，在 GitHub 用 `.github/workflows/qa-ui-auto-platforms.yml` 执行，不在本地跑。同日追加：“在 MFA 管理列表中增加显示二维码的功能，将保存的 MFA 渲染为二维码，供其它 app 扫码”（AC-18、DEC-11、TASK-10）。
- 调研基线：`origin/main` `23882563`（2026-10-01），实现分支 `feat/mfa-authenticator`。
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行。
- 本轮真机执行端：GitHub hosted runners（ubuntu-24.04 x64 / windows-2025 x64 / macos-15 ARM64）上的 native 与 browser 矩阵；本地 Linux 只做编译、单元测试与静态检查（用户要求用例不在本地跑）。
- 推荐方案：新增 Rust `mfa` 模块（独立 `mfa.db`、保险库数据密钥加密、后端生成验证码、截屏与原生剪贴板图像），渲染层新增 MFA 标签页与导入流程（`qr`@0.7.2 统一解码截图/文件/摄像头/屏幕帧），接入 Tools 三处入口、备份/恢复与浏览器 stub，并补齐 qa-ui-auto 用例与所需 runner 动词。

用户问题：Taomni 用户登录云控制台、VPN、Git 托管等站点需要两步验证码，目前只能切到手机。完成后，用户从 Tools 打开“MFA 验证器”标签，用密钥/otpauth 链接、截图、屏幕扫描或摄像头添加账户，点击即可复制验证码，并能搜索、分组、置顶和多种排序；数据保存在加密的 `mfa.db`，随核心/完整备份一起备份恢复。单个账户可在重新输入主密码后显示为 `otpauth://` 二维码，供其他验证器扫码迁移。本次不做：云同步、批量导出（迁移码）/导出明文密钥文本、Steam Guard 等非 RFC 编码、剪贴板自动清除、SSH keyboard-interactive 自动填码（列为后续建议）。

## 2. 当前实现与功能缺口

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/tabbar/ControlBar.tsx` `openMainMenu` Tools 子菜单 | Windows/Linux 应用菜单 Tools 含 servers/tunneling/sockscap/git/code-workspace/mail-unified/lan-chat/network-tools | 新增 `context-menu-item-mfa` | 源码 |
| `src/lib/nativeAppMenu.ts` `buildAppMenuSpec` | macOS 原生 Tools 菜单（纯数据 spec，有单测） | 新增 `mfa` 项 | 源码 |
| `src/components/sidebar/Sidebar.tsx` `ToolsPanel` | 侧栏工具面板镜像 Tools 菜单 | 新增 `sidebar-tool-mfa` | 源码注释 “mirror the main menu Tools items” |
| `src/layouts/MainLayout.tsx` `handleCommand` / 标签渲染 | 工具类标签单实例打开（如 `sockscap`），非已知类型落到 `UnavailablePanel` | 新增 `mfa` 命令、`openMfaTab`、渲染与排除 | 源码 |
| `src-tauri/src/notes/`、`lib.rs` setup | Notes 使用独立 `notes.db`，启动时打开 | MFA 仿照独立库，但改为懒打开以免损坏库阻断启动 | 源码 |
| `src-tauri/src/lanchat/mod.rs` `ensure_unlocked` | 随机消息密钥存保险库固定条目 `lanchat.message-key-v1`，消息落库加密 | MFA 采用同一模式：`mfa.data-key-v1` | 源码 |
| `src/components/vault/VaultGate.tsx` | 保险库为空→设置对话框；锁定→解锁对话框；取消→占位 | MFA 标签复用；占位补 `vault-gate-placeholder` testid | 源码 |
| `src-tauri/src/vault/mod.rs` `vault_delete` | 任意条目可删 | 拒绝删除 MFA 数据密钥 | 源码；删除即永久丢失全部 MFA 密钥 |
| `src-tauri/src/backup/engine.rs` `create_backup` | core/full 打包 taomni/notes/vault 等，无 MFA | 新增 `databases/mfa.db`，`includeMfa` 自定义选项强制带 vault | 源码 |
| `src-tauri/src/backup/restore.rs` `apply_pending_restore` | 启动前替换已知数据库并做安全副本 | 增加 `mfa.db` | 源码 |
| `src/components/settings/BackupSettingsPanel.tsx` | 仅恢复对话框有 testid | 增加立即备份、历史行、恢复动作、清单文件列表等 testid；范围文案提及 MFA | 源码 |
| `src-tauri/src/config/mod.rs` `read_file_bytes`、`chat_read_clipboard_image_attachment` | 已有二进制 IPC (`tauri::ipc::Response`) 与 arboard 读取剪贴板图像先例 | MFA 剪贴板/截屏帧沿用二进制响应 | 源码 |
| `src-tauri/Cargo.toml` | `xcap` 在三端 target 依赖中非可选；`hmac`/`sha1`/`sha2`/`aes-gcm`/`arboard` 已是直接依赖 | 不新增 Rust 依赖 | Cargo.toml / Cargo.lock |
| `src-tauri/Info.plist`、`Entitlements.plist`、`lib.rs` Linux `with_webview` | 已为 LanChat 声明摄像头用途、开启 WebKitGTK media-stream | 摄像头扫码直接复用；用途文案补 MFA | 源码 |
| `tauri.conf.json` CSP | `script-src 'self'`（无 `wasm-unsafe-eval`），`img-src`/`media-src` 允许 `blob:` | 解码器必须是纯 JS；图片与视频预览可用 blob | 源码 |
| qa-ui-auto | 无 MFA/备份用例；native 不支持 `upload_file`；无图像剪贴板、摄像头、屏幕窗口动词 | 新增用例与 5 个 runner 动词 | `native_steps.py`、`verb-catalog.md` |

调用链（目标）：Tools 入口 → `handleCommand("mfa")` → `openMfaTab` → `MfaTab`（`VaultGate`）→ `useMfaStore.load()` → `mfa_list`（Rust：懒开 `mfa.db`、确保数据密钥）→ `mfa_codes`（Rust 解密密钥、生成验证码）→ 列表渲染与倒计时。

## 3. 验收条件

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | 主界面 | Windows/Linux 应用菜单 Tools → “MFA authenticator”；macOS 原生菜单 Tools；侧栏工具面板 | 打开唯一 `mfa` 标签；再次打开只聚焦已有标签 | 三端；macOS 原生菜单由 spec 单测覆盖 |
| AC-02 | 保险库为空 / 锁定 / 使用中被锁 | 打开 MFA；取消；设置或解锁；在设置中锁定 | 空→设置主密码对话框，锁定→解锁对话框；取消显示锁定占位且不显示任何账户；解锁后显示列表；使用中锁定立即隐藏验证码并弹出解锁 | 三端；browser 为 stub 保险库 |
| AC-03 | 添加对话框“密钥”方式 | 输入发行方、账户、Base32 密钥（允许空格/小写/无填充），可选高级参数：TOTP/HOTP、SHA1/SHA256/SHA512、6/7/8 位、周期 15–300 秒、HOTP 初始计数 | 合法输入保存后出现在列表；非法密钥或参数显示字段错误且不保存；相同密钥与参数重复添加提示已存在 | 三端 |
| AC-04 | “密钥”方式中的 otpauth 链接框 | 粘贴 `otpauth://totp|hotp/...` | 自动解析并预填发行方/账户/密钥/参数；非法链接给出错误 | 三端 |
| AC-05 | “截图/图片”方式 | Ctrl/Cmd+V 粘贴截图；点“粘贴截图”；选择图片文件；把图片文件拖入 | 识别 otpauth 或 Google Authenticator 迁移二维码后进入导入预览；“未识别到二维码”与“不是 MFA 二维码”分别提示 | 三端；Linux WebKitGTK 粘贴事件缺图时走原生剪贴板 |
| AC-06 | “扫描屏幕”方式 | 点“扫描屏幕” | Taomni 窗口暂时隐藏→截取全部显示器→恢复并聚焦窗口→识别屏幕上全部二维码→预览；无码提示；macOS 无屏幕录制权限时提示授权路径并请求权限；浏览器预览提示仅桌面版 | Windows/Linux X11 可自动化；macOS、Wayland 需人工授权 |
| AC-07 | “摄像头”方式 | 进入摄像头方式；选择设备；对准二维码 | 有摄像头时实时预览并扫码，识别后自动停止摄像头进入预览；无摄像头显示“未检测到摄像头”和重试；权限拒绝有提示；关闭对话框或切换方式释放摄像头 | 三端 WebView；CI 无摄像头，native 为人工项 |
| AC-08 | 导入预览 | 修改单个账户的发行方/账户/分组；多账户勾选；确认 | 单账户可编辑；迁移码列出全部账户可勾选；已存在项标“已存在”且默认不勾选；确认后写入 `mfa.db` 并显示导入数量 | 三端 |
| AC-09 | 列表中 TOTP / HOTP 账户 | 观察；跨周期等待；点 HOTP“下一个” | TOTP 显示按位分组的当前码（如 `755 224`）、倒计时环与剩余秒数；≤5 秒警示色；≤10 秒显示下一个码；周期切换自动刷新；HOTP 显示当前计数的码，“下一个”递增计数并持久化 | 三端 |
| AC-10 | 列表 | 点验证码或复制按钮；搜索框按 Enter | 纯数字写入系统剪贴板；显示“Copied … code”状态（aria-live）与行高亮；Enter 复制第一条可见账户；记录使用次数与最近使用时间 | 三端；系统剪贴板 native Linux 自动化 |
| AC-11 | 多账户 | 搜索；分组筛选 | 搜索匹配发行方/账户/分组/备注（不区分大小写）；分组含“全部”“未分组”；无结果显示空状态 | 三端 |
| AC-12 | 多账户 | 切换排序：自定义、发行方、账户、最近使用、最常使用、最近添加；置顶；自定义下拖拽或菜单上移/下移；重启/重载 | 置顶账户始终在前；各排序结果正确；自定义顺序可拖拽与键盘调整；排序方式、分组筛选、置顶、顺序持久化 | 三端 |
| AC-13 | 已有账户 | 编辑发行方/账户/分组/备注；删除→取消/确认 | 编辑即时生效并持久化；删除需确认，取消不删 | 三端 |
| AC-14 | 存储 | 添加账户后检查 `mfa.db`；修改主密码 | `mfa.db` 独立于 `taomni.db`；密钥 AES-256-GCM 密文（AAD 绑定账户 id），无明文；数据密钥在保险库 `mfa.data-key-v1`；除 AC-18 经主密码确认的单账户导出外，渲染层拿不到已保存密钥；改主密码后仍可解密；保险库管理中不能删除该条目 | 三端 |
| AC-15 | 备份 | 立即备份 core/full；查看恢复清单；恢复 | 备份含 `databases/mfa.db` 与 `databases/vault.db`；自定义 `includeMfa` 强制包含 vault；恢复替换 `mfa.db` 并在安全副本保留旧库；范围文案提及 MFA | 三端 |
| AC-16 | `mfa.db` 有密文但保险库缺数据密钥或密钥不匹配 | 打开 MFA | 显示明确错误，不改动数据；“清空 MFA 数据”需二次确认后重建 | 三端 |
| AC-17 | 可访问性与语言 | 键盘操作、读屏、切换语言 | 控件有可访问名称；搜索框 ↓ 进入列表、↑/↓ 在验证码间移动；状态 aria-live；中英文文案完整 | 三端 |
| AC-18 | 已有账户 | 行菜单“显示二维码…”；输入主密码（空/错误/正确）；关闭后再次打开 | 显示风险提示；空或错误密码给出错误且不渲染任何码；正确密码后显示 `otpauth://` 二维码（标签 `issuer:account`，含 secret、issuer、algorithm、digits，TOTP 带 period、HOTP 带当前 counter），其他验证器可扫码添加同一账户；关闭即清除，再次打开需重新输入密码；Esc 关闭 | 三端；第三方 App 扫码为人工项 |

失败与恢复：截屏失败也必须恢复窗口；摄像头异常必须停止全部 track；导入失败保留预览；IPC 返回 `VAULT_LOCKED` 时刷新保险库状态回到门禁。性能：单次截屏解码（两块 4K 显示器）目标 < 3 秒，摄像头帧解码循环 ≥ 5 fps（默认 120 ms 间隔）；无既有基线，本轮只记录观测值，不作通过门禁。

## 4. 方案与关键决策

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 密钥保护 | A 保险库主密码加密：安全，需主密码；B 明文：零摩擦，可被直接读取；C MFA 独立密码：多记一个密码 | A：数据密钥存保险库，`mfa.db` 只存密文；MFA 标签受 `VaultGate` 保护 | 用户已定 | 2026-10-01 AskUserQuestion 选择“保险库主密码加密（推荐）” | AC-02/14/15/16；TASK-01/02/03；V-01/03/05/22/24 |
| DEC-02 主界面形态 | A 独立标签页：完整管理；B 右侧抽屉：边看终端边复制但窄 | A，按已确认线框（工具栏：搜索/分组/排序/添加；行：置顶、发行方、账户、验证码、倒计时、复制、菜单；底部状态） | 用户已定 | 同上，选择“独立标签页（推荐）”及其预览 | AC-01/09～13；TASK-05/06；V-10～V-19 |
| DEC-03 截图识别范围 | A 粘贴/选择/拖入截图；B 另加应用内“扫描屏幕”（需屏幕录制/门户授权） | A+B | 用户已定 | 同上，选择“另加‘扫描屏幕’” | AC-05/06；TASK-02/05/08；V-13/14/21/23 |
| DEC-04 二维码解码组件 | `qr`@0.7.2（MIT/Apache-2.0、零依赖、2026-09 发布、编码+解码 11.5 KB gz、可直接解 luma）；jsQR（2021 停更）；Rust rqrr（浏览器无法复用、摄像头帧需 IPC）；zxing-wasm（CSP 需 `wasm-unsafe-eval`、~1 MB） | `qr`，渲染层统一解码；按需动态 import；测试用其编码器生成夹具 | agent 自决 | CSP 与 browser 可测性；`node_modules/qr/decode.d.ts` 支持 `I420` luma 与批量多码 | AC-05/06/07；TASK-04/08 |
| DEC-05 验证码生成位置 | 后端生成（密钥不出后端）vs 前端 WebCrypto | 后端 Rust 生成；浏览器 stub 用 WebCrypto 模拟 | agent 自决 | DEC-01 安全目标 | AC-09/14；TASK-01/07 |
| DEC-06 导入解析位置 | 渲染层解析 vs 后端解析 | 渲染层 TS 解析 otpauth 与迁移 protobuf，后端对结构化输入二次校验 | agent 自决 | 一份解析逻辑在两种模式下都运行，可被 browser 用例证明 | AC-04/05/08；TASK-04 |
| DEC-07 组织能力范围 | 用户要求“方便查找、排序等等” | 搜索、分组筛选、置顶、6 种排序、拖拽与键盘调整顺序 | 授权代决 | 用户补充消息 | AC-11/12；TASK-05 |
| DEC-08 HOTP 语义 | 显示当前计数码 + “下一个”递增；或点击才生成 | 前者（与 Aegis 一致），计数立即持久化 | agent 自决 | RFC 4226 计数语义 | AC-09 |
| DEC-09 剪贴板自动清除 | 默认清除 / 不做 | 不做，列为后续设置项 | agent 自决 | 需求未提，自动清除会覆盖用户之后复制的内容 | — |
| DEC-10 测试设施 | 只写 Vitest；或补 runner 动词让 browser/native 用例观察真实路径 | 新增 `seed_clipboard_image`（夹具或元素截图）、`browser_fake_camera`、`native_clipboard_image`、`native_show_image_window`、`assert_totp_code` | agent 自决 | 用户要求 browser/native 全部用例；native 不支持 `upload_file` | TASK-08；V-10～V-29 |
| DEC-11 二维码导出的保护与渲染 | A 保险库已解锁即可显示；B 每次显示前重新输入主密码；渲染：后端出图 vs 渲染层用 `qr` 编码器出 SVG | B：唯一把已存密钥交给渲染层的命令 `mfa_export_uri` 先 `verify_master_password`，防止已解锁机器被他人导出；`qr` 编码器（已依赖、按需加载）在本地生成内联 SVG（不用 innerHTML），关闭即丢弃；HOTP 导出当前计数 | agent 自决（可按用户意见改为 A） | 导出的是长期凭据，风险高于查看一次性验证码；与备份恢复需主密码一致 | AC-18；TASK-10；V-28/V-29/V-30 |

### 用户流程与交互

入口：Tools → “MFA authenticator / MFA 验证器”（`KeyRound` 图标），标签 id `mfa`、类型 `mfa`、可关闭；仅在激活时挂载（与 SocksCap 一致，状态在 store 中保留）。

MFA 标签布局（DEC-02 已确认线框）：

```
[🔍 Search issuer, account, group, note] [Group ▾] [Sort ▾] [+ Add]
★ GitHub        alice@example.com   123 456  ◔18s  [⧉] [⋯]
⠿ AWS · Work    admin               908 112  ◔18s  [⧉] [⋯]
⠿ QA Bank(HOTP) qa.hotp@example.com 755 224  [Next] [⧉] [⋯]
✓ Copied QA Bank code
```

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| 门禁 | 打开标签 | 保险库 empty/locked | 设置/解锁对话框 | 取消→锁定占位 `vault-gate-placeholder`，可重试 |
| 加载 | 解锁完成 | — | `mfa_list` + `mfa_codes` → 列表或空状态 `mfa-empty` | `MFA_KEY_MISSING/MISMATCH`→`mfa-key-error`，提供清空（二次确认） |
| 列表 | 点验证码/复制 | 有码 | 写剪贴板，`mfa-status` “Copied {name} code”，行 `data-copied` 1.5 秒 | 写失败显示错误状态 |
| 列表 | 倒计时到期 | TOTP | 自动 `mfa_codes`，码更新 | 失败保留旧码并在状态栏提示，下一秒重试 |
| 列表 | HOTP 下一个 | HOTP | `mfa_hotp_next`，计数+1，显示新码 | 失败不改显示 |
| 添加·密钥 | 提交 | 字段有效 | `mfa_add` → 关闭对话框 → 状态 “Added 1 account” | 字段错误 `mfa-add-error`；重复→“already exists” |
| 添加·图片/粘贴/拖入 | 得到图片 | — | 解码→预览 `mfa-import-preview` | 无码→“No QR code found”；非 OTP→“not an MFA QR code” |
| 添加·屏幕 | 扫描 | 桌面版 | 窗口隐藏→截屏→恢复→解码→预览 | 权限/无显示器/无码各有提示；窗口必恢复 |
| 添加·摄像头 | 进入 | 枚举到 videoinput | 预览 + 每 120 ms 解码；识别→停止 track→预览 | 无设备 `data-state=no-camera`；拒绝 `denied`；异常 `error`；离开即停止 |
| 预览 | 确认 | 至少勾选一项 | `mfa_add(skipDuplicates)` → 列表 | 全部重复时确认禁用并提示 |
| 列表 | 菜单“显示二维码…” | 任意账户 | `mfa-qr-dialog`（`data-state=locked`）→ 输入主密码 → `mfa_export_uri` → SVG `mfa-qr-image`（`data-state=shown`） | 空密码/`VAULT_BAD_PASSWORD` 在 `mfa-qr-error` 提示，不渲染；关闭/Esc 丢弃，再开需重新验证 |

键盘：搜索框 Enter 复制首条、↓ 聚焦首条验证码；验证码按钮间 ↑/↓；Esc 关闭对话框；对话框内 Ctrl/Cmd+V 粘贴截图；标签内（非输入框）Ctrl/Cmd+V 有图片时直接进入图片导入。

### 数据流、状态与生命周期

- 权威数据：`<app_data>/mfa.db`（Rust `MfaStore`，懒打开、`Mutex<Option<Connection>>`）。前端 `useMfaStore` 只缓存元数据、当前码与偏好，不保存密钥。
- 表结构（`PRAGMA user_version=1`）：`mfa_accounts(id TEXT PK, issuer, account_name, group_name, note, kind 'totp'|'hotp', algorithm 'SHA1'|'SHA256'|'SHA512', digits, period, counter, secret_ct BLOB, secret_nonce BLOB, fingerprint TEXT, pinned, sort_order, use_count, last_used_at, created_at, updated_at)`；`mfa_meta(key PK, value BLOB)` 存 `key_check`（数据密钥校验密文）；`mfa_prefs(key PK, value TEXT)` 存 `sort_mode`、`group_filter`。时间戳统一为 Unix 毫秒。
- 数据密钥：32 字节随机，Base64 存保险库固定条目 `mfa.data-key-v1`（kind `mfa_secret`，label `MFA Data Key`），首次在保险库解锁且 `mfa.db` 无密文时创建；`key_check` 为 AES-GCM 加密的常量串。每条密钥 `AES-256-GCM(key, nonce, secret, aad="taomni-mfa:"+id)`；`fingerprint=HMAC-SHA256(key, kind|alg|digits|period|secret)` 用于去重。每次命令从保险库取密钥，保险库锁定即返回 `VAULT_LOCKED`，解密后 `Zeroizing` 清理。锁顺序固定为“MFA 连接 → 保险库”，保险库从不回调 MFA。
- 验证码：后端 `SystemTime::now()` 计算 `step=floor(unix/period)`，返回当前码、下一码与 `validFromMs/validUntilMs`；前端 1 秒节拍刷新倒计时，任一码到期触发一次 `mfa_codes`（至少间隔 1 秒，防抖）。
- 截屏：`mfa_capture_screens` 在 `spawn_blocking` 内隐藏调用窗口→等待 350 ms→`xcap::Monitor::all()` 逐屏 `capture_image`→转 luma（按 alpha 叠白）→`scopeguard` 保证 `show()+set_focus()`→二进制返回。
- 帧格式（剪贴板与截屏共用）：`"TQF1"` + `u32 count` + 每帧 `u32 width, u32 height, width*height luma`，小端；前端 `decodeQRBatch(frames, {format:"I420"})`。
- 摄像头：`getUserMedia` → `<video>` → 画到 ≤1280 宽画布 → `decodeQR`；组件卸载、切换方式、关闭对话框、识别成功都停止全部 track 并清定时器。

### 接口与共享契约

| 类型 / 名称（拟新增） | 调用方 → 实现方 | 输入及序列化（camelCase） | 输出 / 错误 | 兼容规则 |
|---|---|---|---|---|
| `mfa_list` | `mfaStore.load` → `mfa::commands` | — | `{accounts: MfaAccount[], prefs: {sortMode, groupFilter}}`；`VAULT_LOCKED`/`MFA_KEY_MISSING`/`MFA_KEY_MISMATCH` | 新增 |
| `mfa_codes` | store → Rust | `{ids?: string[]}` | `MfaCode[] {id, code, nextCode, period, counter, validFromMs, validUntilMs}`（HOTP 后两者为 null） | 新增 |
| `mfa_inspect` | 导入预览 → Rust | `{inputs: MfaAccountInput[]}` | `[{ok, error?, duplicateOf?}]` | 新增 |
| `mfa_add` | 添加/导入 → Rust | `{inputs, skipDuplicates}`；`MfaAccountInput {issuer, accountName, secret(Base32), kind, algorithm, digits, period, counter, group, note}` | `{added: MfaAccount[], duplicates: number[]}`；`MFA_INVALID_INPUT: <field>` | 新增 |
| `mfa_update` | 编辑/置顶 → Rust | `{id, patch: {issuer, accountName, group, note, pinned}}` | `MfaAccount`；`MFA_NOT_FOUND` | 新增 |
| `mfa_delete` / `mfa_reorder` | 列表 → Rust | `{id}` / `{ids}`（完整自定义顺序） | `()` | 新增 |
| `mfa_hotp_next` / `mfa_mark_used` | 行 → Rust | `{id}` | `MfaCode` / `MfaAccount` | 新增 |
| `mfa_set_prefs` / `mfa_reset_store` | 工具栏 / 错误面板 → Rust | `{prefs}` / — | `()` | 新增 |
| `mfa_read_clipboard_image` | 粘贴 → Rust (arboard) | — | 二进制帧；`MFA_CLIPBOARD_NO_IMAGE` | 新增；stub 抛 `MFA_DESKTOP_ONLY` |
| `mfa_capture_screens` | 屏幕扫描 → Rust (xcap) | — | 二进制帧；`MFA_SCREEN_PERMISSION`/`MFA_NO_DISPLAY` | 新增；stub 抛 `MFA_DESKTOP_ONLY` |
| `mfa_export_uri` | 二维码对话框 → Rust | `{id, masterPassword}` | `otpauth://…` 字符串（RFC 3986 百分号编码，secret 为无填充 Base32）；`VAULT_PASSWORD_REQUIRED`/`VAULT_BAD_PASSWORD`/`VAULT_LOCKED`/`MFA_NOT_FOUND` | 新增；唯一返回已存密钥的命令；stub 对照 stub 保险库密码 |
| `BackupCustomOptions.includeMfa` | 备份 API | `boolean`，默认 false（serde default） | — | 旧调用方不受影响；为 true 时强制 `includeVault` |
| `vault_delete` | 保险库管理 | `id = mfa.data-key-v1` | `VAULT_ENTRY_PROTECTED` | 其余条目行为不变 |
| `AppCommand`/`MenuActionId` | 菜单 → MainLayout | 新增 `"mfa"` | — | 新增 |
| `TabKind` | store/布局 | 新增 `"mfa"` | — | 新增 |

`MfaAccount {id, issuer, accountName, group, note, kind, algorithm, digits, period, counter, pinned, sortOrder, useCount, lastUsedAt|null, createdAt, updatedAt}`，不含密钥。

### 三端兼容与相关存储、故障边界

- Windows：WebView2 支持 `<input type=file>`、async clipboard、`getUserMedia`（WebView2 权限提示）；xcap GDI/WGC 截屏；arboard 读位图。hosted runner 有交互桌面，可自动化屏幕扫描。
- macOS：WKWebView 文件输入由 wry `runOpenPanelWithParameters` 支持；摄像头依赖已有 `NSCameraUsageDescription` 与 camera entitlement（文案补 MFA）；屏幕扫描先 `CGPreflightScreenCaptureAccess`，无权限时 `CGRequestScreenCaptureAccess` 并返回 `MFA_SCREEN_PERMISSION`（提示“系统设置 → 隐私与安全性 → 屏幕录制”）；hosted runner 无授权，屏幕扫描用例不选 macOS，记为未验证。
- Linux：WebKitGTK 粘贴事件常缺图片，“粘贴截图”优先走 arboard；X11 下 xcap 读根窗口（Xvfb 可用）；Wayland 由 xcap 走门户并弹授权；摄像头复用 `with_webview` 已开启的 media-stream。
- 浏览器 stub：`src/stubs/mfaStub.ts` 以 localStorage `taomni.stub.mfa.v1` 模拟存储、以 WebCrypto 生成码、校验 stub 保险库解锁；截屏/原生剪贴板返回 `MFA_DESKTOP_ONLY`。只证明渲染层编排，不证明 Rust/真实系统。
- 故障：`mfa.db` 打开失败只影响 MFA 命令（懒打开），不阻断启动；恢复时 `apply_pending_restore` 先于打开数据库运行；回退为删除 `mfa` 模块与入口，`mfa.db` 文件留在磁盘不影响其他功能。

## 5. 改动清单

| 路径 / 模块（拟新增标注 *） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src-tauri/src/mfa/{mod,otp,crypto,store,capture,commands}.rs`* | Base32 编解码、HOTP/TOTP、`otpauth_uri`、数据密钥与 AES-GCM、`MfaStore` 与 SQL、截屏/剪贴板帧、命令（含 `mfa_export_uri` / `export_with_password`） | AC-03/06/09/10/12～16/18 | TASK-01/02/10 |
| `src-tauri/src/state.rs`、`lib.rs` | `AppState.mfa`；`mod mfa`；懒库路径；注册命令 | AC-14 | TASK-02 |
| `src-tauri/src/vault/mod.rs` | `MFA_DATA_KEY_ENTRY_ID`、`vault_delete` 保护 | AC-14 | TASK-02 |
| `src-tauri/src/backup/{engine,restore,tests}.rs` | 范围解析函数、`include_mfa`、`mfa.db` 打包/恢复/安全副本与测试 | AC-15 | TASK-03 |
| `src-tauri/Info.plist` | 摄像头用途文案补 MFA | AC-07 | TASK-06 |
| `src/lib/mfa/{types,ipc,base32,otpauth,migration,qrImage,frames,sort,format}.ts`* + 测试 | 类型、IPC、解析、解码、排序、格式化 | AC-03～12 | TASK-04 |
| `src/stores/mfaStore.ts`* + 测试 | 加载、码刷新、增删改、排序/分组/搜索、复制 | AC-09～13 | TASK-05 |
| `src/components/mfa/*`* + 测试 | `MfaTab`、`MfaPanel`、`MfaAccountRow`、`MfaCountdown`、`MfaAddDialog`、`MfaImagePane`、`MfaCameraPane`、`MfaScreenPane`、`MfaImportPreview`、`MfaEditDialog`、`MfaQrDialog` | AC-02～13/17/18 | TASK-05/10 |
| `src/lib/mfa/qrSvg.ts`*、`otpauth.ts` `buildOtpauthUri` + 测试 | otpauth 链接 → QR 模块 → SVG path；stub 导出与后端同格式 | AC-18 | TASK-10 |
| `src/types/index.ts`、`menubar/commands.ts`、`nativeAppMenu.ts`(+test)、`ControlBar.tsx`、`Sidebar.tsx`、`TabBar.tsx`、`MainLayout.tsx` | 入口、标签类型、图标、渲染 | AC-01 | TASK-06 |
| `src/components/vault/{VaultGate,VaultEntriesDialog}.tsx` | 占位 testid；MFA 密钥条目不可删 | AC-02/14 | TASK-06 |
| `src/components/settings/BackupSettingsPanel.tsx`、`src/lib/backup.ts` | testid、`includeMfa` 类型 | AC-15 | TASK-06 |
| `src/lib/i18n/locales/{en,zh-CN}.ts` | `menu.mfa`、`tabs.mfa`、`mfa.*`、备份范围文案 | AC-17 | TASK-06 |
| `src/stubs/mfaStub.ts`*、`src/stubs/tauri-core.ts` | stub 命令 | browser 用例 | TASK-07 |
| `package.json`/`pnpm-lock.yaml` | `qr` 精确版本 `0.7.2` | AC-05～07 | TASK-04 |
| `qa-ui-auto-tests/synthetic-fixtures/mfa/*`* | 二维码夹具 PNG、`manifest.json`（载荷与期望码）与生成脚本 `generate.mjs`；`src/lib/mfa/fixtures.test.ts` 防夹具漂移 | V-10～24 | TASK-08 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/{steps/__init__.py,steps/mfa.py*,otp.py*,mfa_support.py*,native_steps.py,verification.py}`、`schema/testcase.schema.json`、`references/verb-catalog.md`、`scripts/test_mfa_verbs.py`* | 5 个动词、Python RFC 6238 预言机、平台范围（`LINUX_VERBS`、`PLATFORM_VERBS`）及测试 | V-10～29 | TASK-08 |
| `qa-ui-auto-tests/cases/TC-MFA-*.testcase.yaml`*、`feature-list.md`、`ci/policy.yaml`、`references/testid-catalog.md` | 用例、F-MFA-1/2/3、登记、目录再生成 | 全部 | TASK-08 |

## 6. 实现任务与交接

### TASK-01 Rust 核心：OTP、加密与存储

- 职责与文件范围：`src-tauri/src/mfa/{mod,otp,crypto,store}.rs`。
- 输入与必读：§4 数据流；`vault/crypto.rs`、`lanchat/mod.rs` 数据密钥模式；`notes/db.rs` 风格。
- 依赖：DEC-01/05（已定）。无前置任务。
- 实施内容：Base32 解码（大小写、空格、`-`、可选 `=`），HOTP/TOTP（SHA1/256/512，6～8 位）；数据密钥确保/校验/创建，AES-GCM 带 AAD，指纹；`MfaStore` 懒打开、`init_db`、CRUD、排序、计数、使用记录、偏好、重置、`backup_to`。
- 对应验收：AC-03/09/12/13/14/16。
- 验证与完成条件：V-01、V-02、V-03 通过。
- 并行与集成：可与 TASK-04 并行；TASK-02 依赖其公共函数签名。

### TASK-02 Rust 命令、截屏与剪贴板、AppState 与保险库保护

- 职责与文件范围：`mfa/{capture,commands}.rs`、`state.rs`、`lib.rs`、`vault/mod.rs`。
- 依赖：TASK-01；DEC-03（已定）。
- 实施内容：§4 接口表所列命令；`spawn_blocking` 截屏；macOS 权限预检；`scopeguard` 恢复窗口；二进制帧；`vault_delete` 保护。
- 对应验收：AC-06/10/14。
- 验证与完成条件：V-04（帧编码/luma 单测）、V-05（保护单测）、`cargo test --lib mfa::`、三端编译由 GitHub native 构建证明。

### TASK-03 备份与恢复

- 职责与文件范围：`backup/{engine,restore,tests}.rs`。
- 依赖：TASK-01 的 `MfaStore::backup_to`。
- 实施内容：抽出 `resolve_scope(scope, options) -> BackupScopeFlags`；core/full 含 MFA；`include_mfa` 强制 vault；恢复与安全副本加 `mfa.db`。
- 对应验收：AC-15。
- 验证与完成条件：V-06、V-07 通过；V-22 native。

### TASK-04 前端 MFA 库

- 职责与文件范围：`src/lib/mfa/*` 与测试、`qr` 依赖。
- 依赖：DEC-04/06。
- 实施内容：otpauth 解析（label `Issuer:account`、`issuer` 参数优先、URL 解码、参数校验）；Google Authenticator `otpauth-migration://offline?data=` protobuf 解析（varint/length-delimited，算法/位数/类型枚举映射）；Base32 编码/校验；帧解析；图片/Blob/ImageData 解码（长边 ≤3840，`effort: Infinity`，`timeLimit` 2000 ms）；排序/筛选；码分组格式化。
- 对应验收：AC-03～08/11/12。
- 验证与完成条件：V-08 通过。

### TASK-05 前端 store 与组件

- 职责与文件范围：`src/stores/mfaStore.ts`、`src/components/mfa/*` 与测试。
- 依赖：TASK-04；接口表。
- 实施内容：§4 流程表全部状态；testid 见 §7；拖拽复用 `startCustomDrag`/`useCustomDropTarget`；Tauri 原生文件拖放复用 `NATIVE_FILE_DROP_EVENT` + `readFileBytes`；复制复用 `lib/clipboard.writeText`；删除确认复用 `confirmAppDialog`。
- 对应验收：AC-02～13/17。
- 验证与完成条件：V-09 通过。

### TASK-06 入口、文案与周边集成

- 职责与文件范围：§5 中入口、保险库组件、备份面板、i18n、Info.plist。
- 依赖：TASK-05 组件导出。
- 对应验收：AC-01/02/14/15/17。
- 验证与完成条件：V-08 中 `nativeAppMenu` 用例、`pnpm build` 通过。

### TASK-07 浏览器 stub

- 职责与文件范围：`src/stubs/mfaStub.ts`、`tauri-core.ts` 分派。
- 依赖：接口表。
- 实施内容：localStorage 持久化，stub 保险库未解锁时抛 `VAULT_LOCKED`，WebCrypto 生成码，与 Rust 一致的去重与校验，桌面专属命令抛 `MFA_DESKTOP_ONLY`。
- 验证与完成条件：V-09 中 stub 单测；browser 用例 V-10～V-18。

### TASK-08 QA 用例与 runner 设施

- 职责与文件范围：§5 中 qa-ui-auto 相关文件。
- 依赖：TASK-05/06 的 testid。
- 实施内容：夹具生成脚本（`qr` 编码 + zlib PNG）与 PNG；5 个动词（实现、schema、verb catalog、平台集合、单测）；15 个用例；`F-MFA-1/2/3` 与控件；policy 登记；`gen_testid_catalog`；`audit --gate`、`dev_contract`、`ci plan` 通过。
- 验证与完成条件：V-10～V-24 在 GitHub 运行并回填。

### TASK-10 单账户二维码导出

- 职责与文件范围：`mfa/{otp,commands,tests}.rs`、`lib.rs` 注册、`src/lib/mfa/{ipc,otpauth,qrSvg}.ts`、`MfaQrDialog.tsx`、`MfaPanel.tsx` 菜单项、stub 与 i18n。
- 依赖：TASK-01/02；DEC-11。
- 实施内容：`encode_base32`、`otpauth_uri`；`mfa_export_uri` 先验证主密码再解密导出；渲染层按需加载 `qr` 编码器生成 SVG path；对话框锁定/显示两态、错误提示、关闭清除；行菜单 `mfa-menu-qr`。
- 对应验收：AC-18。
- 验证与完成条件：V-28、V-29（自动部分）、V-30 通过；V-29 手机扫码人工待执行。

### TASK-09 集成、推送与 GitHub 执行

- 职责：本地 `cargo test --lib`（mfa/backup/vault 过滤）、`pnpm test` 相关文件、`pnpm build`、静态门禁；提交并推送 `feat/mfa-authenticator`；`gh workflow run qa-ui-auto-platforms.yml --ref feat/mfa-authenticator -f scope=selected -f case_ids=<全部 TC-MFA-*>`；按失败证据修复，结果写回 §9。

## 7. 自动化测试计划

| V ID | AC / 用途 | 层级与文件 / case（均为拟新增） | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-09 目标 | Rust `mfa::otp` 单测 | RFC 4226 附录 D、RFC 6238 附录 B 向量 | HOTP 0～9 码、TOTP SHA1/256/512 八位码全部一致；Base32 正反例 | `src-tauri/`: `cargo test --lib mfa::otp` | 本地 Linux 通过（2026-10-01，`cargo test --lib -- mfa:: backup:: vault::` 42 passed） |
| V-02 | AC-03/12/13 | Rust `mfa::store` 单测 | 临时 DB + 临时 Vault | 增删改、排序、计数、使用记录、偏好、去重、重置 | `cargo test --lib mfa::store` | 本地 Linux 通过（2026-10-01，`cargo test --lib -- mfa:: backup:: vault::` 42 passed） |
| V-03 | AC-14/16 | Rust `mfa::crypto`/store 单测 | 临时 Vault | 原始 DB 无明文；AAD 换行失败；改主密码后可解；缺密钥/错密钥返回对应错误 | `cargo test --lib mfa::` | 本地 Linux 通过（2026-10-01，`cargo test --lib -- mfa:: backup:: vault::` 42 passed） |
| V-04 | AC-06 | Rust `mfa::capture` 单测 | 合成 RGBA | luma 叠白、帧编码格式 | `cargo test --lib mfa::capture` | 本地 Linux 通过（2026-10-01，`cargo test --lib -- mfa:: backup:: vault::` 42 passed） |
| V-05 | AC-14 | Rust `vault` 单测 | — | 受保护 id 判定 | `cargo test --lib vault::` | 本地 Linux 通过（2026-10-01，`cargo test --lib -- mfa:: backup:: vault::` 42 passed） |
| V-06 | AC-15 | Rust `backup::tests` | 临时 app_data | 打包含 `databases/mfa.db`；恢复替换并有安全副本 | `cargo test --lib backup::` | 本地 Linux 通过（2026-10-01，`cargo test --lib -- mfa:: backup:: vault::` 42 passed） |
| V-07 | AC-15 | Rust `backup` 范围解析单测 | — | core/full 含 MFA；custom `includeMfa` 强制 vault | 同上 | 本地 Linux 通过（2026-10-01，`cargo test --lib -- mfa:: backup:: vault::` 42 passed） |
| V-08 | AC-01/03～08/11/12 | Vitest `src/lib/mfa/*.test.ts`、`nativeAppMenu.test.ts` | `qr` 编码生成测试图 | 解析、迁移、解码 luma/RGBA、排序筛选、格式化、菜单 spec 含 `mfa` | 根目录 `pnpm test src/lib/mfa src/lib/nativeAppMenu.test.ts` | 本地通过（2026-10-01，Vitest 10 files / 55 tests） |
| V-09 | AC-02/09～13/17 | Vitest `src/stores/mfaStore.test.ts`、`src/components/mfa/*.test.tsx`、`src/stubs/mfaStub.test.ts` | mock IPC / stub | 加载/刷新/复制/错误态、对话框与键盘、stub HOTP 755224 | `pnpm test src/stores/mfaStore.test.ts src/components/mfa src/stubs/mfaStub.test.ts` | 本地通过（2026-10-01，Vitest 10 files / 55 tests） |
| V-10 | AC-01/02 | browser `TC-MFA-001-tools-entry-vault-gate` | 新上下文 | 应用菜单 Tools 打开、门禁取消/设置、侧栏入口不重复开标签、空状态 | GitHub browser ×3 | 待执行 |
| V-11 | AC-03/09/10 | browser `TC-MFA-002-secret-key-hotp-copy` | RFC 4226 密钥 | `755 224`；复制→粘贴到搜索框为 `755224`；下一个 `287 082`；重载保持 | 同上 | 待执行 |
| V-12 | AC-03/04/09 | browser `TC-MFA-003-otpauth-uri-validation` | `JBSWY3DPEHPK3PXP` | 非法密钥报错；otpauth 预填；`assert_totp_code` 与 Python RFC 6238 一致；倒计时；重复提示 | 同上 | 待执行 |
| V-13 | AC-05/08 | browser `TC-MFA-004-image-file-qr-import` | 夹具 PNG | 导入预览→`755 224`；非 OTP 码、无码图片各自提示 | 同上 | 待执行 |
| V-14 | AC-05 | browser `TC-MFA-005-paste-screenshot` | `seed_clipboard_image` | 按钮粘贴与 Ctrl+V 粘贴各导入一个账户 | 同上 | 待执行 |
| V-15 | AC-05/08 | browser `TC-MFA-006-google-migration-batch` | 迁移码夹具 | 预览两项、导入两项、再次导入全部“已存在” | 同上 | 待执行 |
| V-16 | AC-06/07 | browser `TC-MFA-007-camera-and-screen-modes` | `browser_fake_camera` | 无摄像头状态；合成摄像头识别→导入→视频移除；屏幕扫描提示仅桌面版 | 同上 | 待执行 |
| V-17a | AC-10/11/17 | browser `TC-MFA-008-search-group-keyboard` | 四账户迁移码，编辑一个到 Personal | 大小写不敏感搜索、Enter 复制首条、无结果、分组/未分组筛选、↓/↑ 在验证码间移动、Enter 复制焦点码 | 同上 | 待执行 |
| V-17b | AC-12 | browser `TC-MFA-010-sort-pin-reorder` | 四账户迁移码，按固定模式复制 | 六种排序各自 `assert_items`、非自定义下无拖拽且上移禁用、置顶、菜单上/下移、拖拽、重载后排序/置顶/顺序保持、取消置顶回位 | 同上 | 待执行 |
| V-18 | AC-13 | browser `TC-MFA-009-edit-delete` | — | 编辑后行更新；删除取消保留、确认删除 | 同上 | 待执行 |
| V-19 | AC-02/03/09/14 | native `TC-MFA-101-native-hotp-totp-persist` | 隔离 profile | Rust 码 `755 224`→`287 082`；重载后计数保持；TOTP 与 Python 一致 | GitHub native ×3 | 待执行 |
| V-20 | AC-02/14 | native `TC-MFA-102-native-vault-lock-gate` | — | 设置中锁定→MFA 解锁对话框→解锁后码恢复 | GitHub native ×3 | 待执行 |
| V-21 | AC-15 | native `TC-MFA-103-native-backup-includes-mfa` | — | 立即备份→历史行→恢复清单含 `databases/mfa.db`、`databases/vault.db` | GitHub native ×3 | 待执行 |
| V-22 | AC-10 | native `TC-MFA-104-native-copy-system-clipboard` | Linux/X11 | `assert_system_clipboard equals 755224` | GitHub native Linux | 待执行 |
| V-23 | AC-05 | native `TC-MFA-105-native-paste-screenshot-clipboard` | `native_clipboard_image`（xclip） | arboard 读图→导入→`755 224` | GitHub native Linux | 待执行 |
| V-24 | AC-06 | native `TC-MFA-106-native-screen-scan` | `native_show_image_window` | 隐藏窗口截屏识别→导入→`755 224`；窗口恢复 | GitHub native Linux、Windows | 待执行 |
| V-28 | AC-18 | browser `TC-MFA-011-show-qr-export` | HOTP 账户计数推进到 1 | 空/错密码拒绝且无图；Enter 提交正确密码出图；`seed_clipboard_image {selector}` 截取 QR 再经应用自身导入解码→同一账户“已添加”、`counter 1`、账户名一致；再开需重新输入；Esc 关闭 | GitHub browser ×3 | 待执行 |
| V-29 | AC-18 | native `TC-MFA-107-native-qr-export` + 人工手机扫码 | 隔离 profile | Rust `VAULT_BAD_PASSWORD` 拒绝错密码且无图；正确密码渲染 QR（模块数合理）；人工：用 Google Authenticator/Aegis 扫截图，码与 Taomni 一致 | GitHub native ×3；人工待执行 | 待执行 |
| V-30 | AC-18 | Rust `mfa::tests::{base32_encoding_*, export_uri_*}`；Vitest `src/lib/mfa/qrSvg.test.ts`、`MfaQrDialog.test.tsx`、`mfaStub.test.ts` | 临时 Vault / stub | RFC 4648 编码向量；错/空密码错误码；导出 URI 精确字符串（含 `&`、空格、`@` 编码与 HOTP 计数）；TS 与 Rust 同格式；SVG path 栅格化后 `qr` 解码回原 URI 且解析出同参数 | `cargo test --lib mfa::`；`pnpm test src/lib/mfa src/components/mfa src/stubs/mfaStub.test.ts` | 本地通过（2026-10-01） |

用例与控件映射：`F-MFA-1`（标签、门禁、列表、复制、搜索/分组/排序/置顶、编辑/删除、二维码导出 `mfa-menu-qr`、`mfa-qr-{dialog,password,reveal,image,error,close}`）、`F-MFA-2`（添加对话框与四种导入、预览）、`F-MFA-3`（备份面板 testid 与 MFA 备份）。主要 testid：`context-menu-item-mfa`、`sidebar-tool-mfa`、`mfa-tab`、`mfa-search`、`mfa-group-filter`、`mfa-sort-mode`、`mfa-add`、`mfa-list`、`mfa-empty`、`mfa-status`、`mfa-account-row`（`data-issuer`、`data-account`、`data-pinned`、`data-kind`）、`mfa-account-code`、`mfa-account-countdown`、`mfa-account-next-code`、`mfa-account-copy`、`mfa-account-hotp-next`、`mfa-account-pin`、`mfa-account-menu`、`mfa-account-drag`、`mfa-add-dialog`、`mfa-add-mode-{secret,image,screen,camera}`、`mfa-add-{issuer,account,secret,group,advanced,kind,algorithm,digits,period,counter,uri,error,submit,cancel}`、`mfa-image-{dropzone,file,choose,paste,status}`、`mfa-camera-{state,video,device,retry}`、`mfa-screen-{scan,status}`、`mfa-import-{preview,item,item-check,issuer,account,group,duplicate,confirm,back}`、`mfa-edit-{dialog,issuer,account,group,note,save,cancel}`、`mfa-key-error`、`mfa-reset-store`、`vault-gate-placeholder`、`backup-create-now`、`backup-history-row`、`backup-history-restore`、`backup-restore-files`、`backup-restore-cancel`、`backup-action-success`。

证明边界：browser 用例使用 stub 存储与 WebCrypto，只证明渲染层与解码器；`seed_clipboard_image` 走 Chromium async clipboard；`browser_fake_camera` 用画布 `captureStream` 替代设备，证明扫码循环而非真实摄像头/权限；native 用例证明 Rust 生成码、`mfa.db`、保险库、备份引擎、arboard、xcap 与 WebView 集成。不适用层：Rust integration 套件（无跨模块网络/进程协作，单测已覆盖）。

回归：入口改动影响 Tools 菜单与侧栏既有项（V-10 同时断言既有 Tools 项可见）；`VaultGate` 只增加 testid（LanChat 消费者行为不变，由既有 LanChat 用例保护）；备份范围变化以 V-06/V-07 与 V-21 保护既有 taomni/notes/vault 打包。

## 8. 真机验证手册

### 环境与准备

- 三端均由 GitHub `qa-ui-auto-platforms.yml` 构建隔离的 `com.taomni.app.qa` debug 二进制（`native_build.py`），数据目录由 harness 重定向到 run 报告目录；`reset_db` 每例清空。无需外部服务或凭据；保险库主密码使用用例内一次性值。
- 触发：`gh workflow run qa-ui-auto-platforms.yml --ref feat/mfa-authenticator -f scope=selected -f platforms=linux,windows,macos -f modes=browser,native -f case_ids=TC-MFA-001,…,TC-MFA-011,TC-MFA-101,…,TC-MFA-107`（共 18 例：browser 11、native 7）。
- Linux native：Xvfb + Openbox + xclip + Python Tk；Windows native：交互桌面 + Python Tk；macOS native：WKWebView 桥，无屏幕录制授权。

### V-25 摄像头扫码人工验证（三端，hosted 不可执行）

- 对应验收：AC-07。
- 执行前状态：带摄像头的真机，打包或 `pnpm tauri dev` 运行；手机显示测试二维码 `otpauth://hotp/QA%20Bank:qa.hotp%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=QA%20Bank&counter=0`。
- 操作与逐步预期：MFA → Add → Camera → 系统权限提示（macOS TCC / WebView2 提示）→ 允许 → 预览出现 → 对准二维码 → 1～2 秒内进入预览 → 确认 → 列表显示 `755 224`；摄像头指示灯熄灭。
- 故障与恢复：拒绝权限→显示 denied 提示；拔掉摄像头→重试显示 no-camera。
- 证据：屏幕录像、`qa-ui-auto-report/mfa-manual/<platform>/` 截图。
- 状态：待执行（三端未验证）。

### V-26 macOS 屏幕扫描人工验证

- 对应验收：AC-06。操作：首次扫描→收到屏幕录制权限请求与 `MFA_SCREEN_PERMISSION` 提示→在系统设置授权并重启→再次扫描→识别屏幕上的二维码。状态：待执行（hosted macOS 无授权，自动化不覆盖）。

### V-27 Linux Wayland 屏幕扫描人工验证

- 对应验收：AC-06。操作：GNOME/KDE Wayland 会话扫描→门户授权对话框→允许→识别。状态：待执行。

### V-29 二维码导出的第三方 App 扫码（人工部分）

- 对应验收：AC-18。执行前状态：任一桌面端已添加 RFC 4226 HOTP 账户（码 `755 224`）与 `JBSWY3DPEHPK3PXP` TOTP 账户。
- 操作与预期：行菜单“显示二维码…”→输入主密码→用手机 Google Authenticator、Microsoft Authenticator 或 Aegis 扫码→App 中出现同名账户；TOTP 码与 Taomni 同步变化；HOTP 首个码为 Taomni 当前计数对应的码；关闭对话框后二维码消失，再次打开需重新输入主密码。
- 证据：手机录屏或截图与 Taomni 截图，存 `qa-ui-auto-report/mfa-manual/<platform>/`。状态：待执行。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4 流程 | TASK-06 | V-08、V-10（browser×3）、V-19（native×3 侧栏入口） | GitHub run 报告 | 待执行 |
| AC-02 | §4 门禁 | TASK-05/06 | V-09、V-10、V-20 | 同上 | 待执行 |
| AC-03/04 | §4 添加 | TASK-04/05 | V-08、V-11、V-12、V-19 | 同上 | 待执行 |
| AC-05 | §4 图片 | TASK-04/05 | V-08、V-13、V-14、V-15、V-23 | 同上 | 待执行 |
| AC-06 | §4 屏幕 | TASK-02/05 | V-04、V-16、V-24；V-26/V-27 人工 | 同上 | macOS/Wayland 人工待执行 |
| AC-07 | §4 摄像头 | TASK-05 | V-09、V-16；V-25 人工 | 同上 | 真实摄像头人工待执行 |
| AC-08 | §4 预览 | TASK-04/05 | V-13、V-15 | 同上 | 待执行 |
| AC-09/10 | §4 列表 | TASK-01/05 | V-01、V-11、V-12、V-19、V-22 | 同上 | 待执行 |
| AC-11/12/13 | §4 组织 | TASK-05 | V-08、V-09、V-17a、V-17b、V-18 | 同上 | 待执行 |
| AC-14/16 | §4 数据 | TASK-01/02 | V-02、V-03、V-05、V-19、V-20 | 同上 | 待执行 |
| AC-15 | §4 备份 | TASK-03 | V-06、V-07、V-21 | 同上 | 待执行 |
| AC-17 | §4 键盘 | TASK-05/06 | V-09、V-17a | 同上 | 屏幕阅读器人工未验证 |
| AC-18 | §4 二维码导出、DEC-11 | TASK-10 | V-28（browser×3）、V-29（native×3 + 人工手机扫码）、V-30（本地已通过） | 同上 | GitHub 执行与手机扫码待执行 |

三端代码兼容检查：本地 Linux 编译与单测；Windows/macOS 编译由 GitHub native 构建证明。只有三端 native 均有通过证据才可报告“三端真机通过”。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| Xvfb 下 xcap 枚举显示器 | xcap X11 依赖 RandR 监视器信息，Xvfb 支持有限 | `Monitor::all()` 为空时回退为截取根窗口失败即报 `MFA_NO_DISPLAY`；以 V-24 证据确认 | 不阻塞 | V-24 Linux 结果 |
| 隐藏窗口期间 WebDriver 会话 | hide/show 对驱动影响未验证 | 等待 350 ms 后恢复并 `set_focus`；V-24 观察 | 不阻塞 | V-24 Windows/Linux 结果 |
| 迁移码协议变化 | Google 迁移格式非公开标准 | 只读取已知字段，未知字段跳过；不支持的算法/位数逐项报错 | 不阻塞 | — |
| 丢失保险库主密码 | MFA 密钥无法解密（DEC-01 固有代价） | 文案提示；备份恢复需同期 vault；清空重建入口 | 不阻塞 | — |

回退：代码回退为移除 `mfa` 模块、入口与备份项；数据回退不需要迁移，`mfa.db` 与保险库条目 `mfa.data-key-v1` 可保留或手动删除。现在可开始全部任务；无待用户决策项。
