# 工作区 Git 克隆导入设计（Workspace Git Clone Import）

- 状态：可实施（本轮实现与验证进行中）
- 分支：`feat/workspace-git-clone`
- 日期：2026-11-21
- 线框图：[git-clone-wireframe.png](git-clone-wireframe.png)（[生成脚本](make_wireframe.py)）
- 适用范围：Windows / macOS / Linux 三端 Tauri 桌面应用；浏览器预览用于界面与 IPC stub 验证，不能替代真实 Git/磁盘证据。

## 1. 目标与非目标

### 1.1 目标

1. 在 Workspaces 模式中，用 Git 克隆地址创建新的平台工作区，支持 GitHub 以及任意 HTTP(S)、SSH、scp-like、`file://` 或本地绝对路径 Git 仓库。
2. 导入界面一次填写并可修改：仓库地址、工作区名、父目录、分支、`user.name`、`user.email`、`http.proxy`、`https.proxy`、token 与 token 用户名。
3. 默认值先带入：`user.name`/`user.email`/`init.defaultBranch` 来自本机 Git 全局配置；代理来自 Taomni「设置 → Application Proxy」；token 默认复用 vault 中已保存的克隆 token（不把明文回填到输入框）。
4. 克隆过程可观察：阶段、百分比、对象计数、当前 Git 输出；可取消；关闭对话框不取消任务，重新打开可恢复进度；失败可重试。
5. 成功后：
   - 建立新的工作区，根目录指向克隆目录，并切换为活动工作区；
   - 在 Home 最近工作区中登记；
   - 仓库本地配置写入本次填写的 Git 身份与代理；
   - token 按用户选择写入 vault，并配置 `origin` 的 Taomni 远程认证引用，后续 fetch/pull/push 复用；
   - 刷新项目树并展开新根目录。
6. 失败不发布半成品：本次创建的目标目录在失败/取消时删除；已存在的空目录保留并明确提示残留位置。重试从干净目录开始。

### 1.2 非目标

- 不做 GitHub OAuth/设备码登录；token 由用户输入或 vault 复用。
- 不做 Git LFS 专门安装、子模块递归初始化（沿用 `git clone` 默认行为，子模块不初始化）。
- 不做克隆断点续传。Git 的 clone 协议没有可恢复的断点语义；保留半成品 `.git` 会被误认为可用仓库。策略是取消/失败即清理（见 DEC-02）。
- 不改变现有 Git 面板的设置保存、远程认证与工作区存储格式。
- 不在本轮验证真实 GitHub 私有仓库的账号体系；使用本机 Git 凭据、token 与本地 fixture 验证行为边界。

## 2. 现状证据（代码事实）

| 能力 | 现状 | 证据 |
| --- | --- | --- |
| 工作区创建 | 仅能从文件夹路径创建；`+` 菜单只有 New File/Folder/Add Root Folder | `src/components/workspace/WorkspaceTabStrip.tsx:95-149`、`WorkspaceSwitcher.tsx:141-155`、`WorkspaceMainPanel.tsx:83-94` |
| 工作区模型 | `createWorkspace({name, rootPath, codeWorkspace})` 会写根目录并持久化 | `src/stores/workspacePlatformStore.ts:366-396` |
| Git 进程层 | 已有统一 `new_git_command`、稳定 locale、无控制台窗口、askpass、远程认证与 vault token | `src-tauri/src/git/process.rs:52-89,186-209,236-260`、`remote_commands.rs:143-187` |
| Git 设置 | `git_save_settings` 已支持 `user.name`、`user.email`、`http.proxy`、`https.proxy` 等仓库本地配置 | `src-tauri/src/git/remote_commands.rs:125-141`、`queries.rs:161-177` |
| 应用代理 | 单一全局代理，支持 session/manual 与 vault 密码；`get_app_proxy_url` 返回解析后的 URL | `src-tauri/src/proxy/mod.rs:33-126,187-224,344-365` |
| 代理设置界面 | Settings 的 `AppProxyPanel` 负责持久化，不应被本次功能改写 | `src/components/settings/AppProxyPanel.tsx:40-120` |
| Vault | 支持固定 entry 的 put/get，可用于克隆 token 默认复用 | `src-tauri/src/vault/mod.rs:321-369` |
| 文件树/工作区 UI 测试钩子 | 项目树根/目录/文件已有稳定 testid，可复用断言 | `TC-WS-060`、`TC-WS-037` 等 |

## 3. 用户流程与界面

### 3.1 入口

1. **Workspaces 标签条 `+` 菜单**：新增 `Clone Git Repository…`（`workspace-plus-clone-git`）。这是主入口。
2. **工作区切换器菜单**：新增 `Clone Git Repository…`（`workspace-switcher-clone-git`），与 `Add Folder` 并列。
3. **Home 的 WorkSpaces 卡片**：新增独立次按钮 `Clone`（`home-clone-workspace`），只切换 Workspaces 模式并打开同一对话框；原 `New Workspace` 行为不变。

对话框由 `WorkspaceMainPanel` 常驻挂载，打开状态与进行中任务都在 store 中，所以从 Home 打开也不会丢失。

### 3.2 对话框布局（线框图 A）

宽度 640px，最大高度 `min(88vh, 880px)`，body 可滚动，footer 固定：

- 标题：`Clone Git Repository`；副标题说明从 GitHub 或其它 Git 远程创建工作区。
- **Repository**：URL（自动聚焦）、名称、父目录 + Browse、只读 Destination 预览、分支 + `Detect` 按钮。
- **Git identity**：`user.name`、`user.email`，提示“写入克隆仓库的本地配置；留空沿用全局配置”。
- **Proxy**：三选一 radio（Application / Custom / No proxy）+ `http.proxy`、`https.proxy`。Application 模式输入只读并显示 Settings 解析值；Custom 可编辑；None 清空并禁用。下方显示来源/不可用原因。
- **Authentication**：token（password 输入 + Show/Hide）、token 用户名（默认 `x-access-token`）、`Use the saved token`（vault 已有 token 时可见）与 `Remember in the vault`。vault 未解锁时仅提示，不阻塞无 token 的公开仓库克隆。
- footer：`Cancel`（空闲时关闭）与 `Clone`（校验失败时禁用并显示原因）。

### 3.3 进行中与后台（线框图 B）

- 表单字段禁用；显示阶段标题、百分比、进度条、对象计数、最近 Git 行；footer 变为 `Close` + `Cancel clone`。
- 关闭对话框不取消：标签条 `+` 菜单项和切换器菜单项显示 `Cloning… 46%`，点击恢复同一对话框与实时进度。
- 取消：先显示 `Cancelling…`，后台 kill Git 进程并清理本次目录，随后显示 `Clone cancelled`（保留已填表单，允许再次 Clone）。
- 失败：显示错误详情（Git stderr 摘要）、`Retry`（使用当前表单）和 `Close`；本次创建目录已清理，若目录原本存在则提示残留路径。
- 成功：对话框显示成功摘要与 `Create another` / `Close`；工作区已切换并展开根目录。成功状态在用户关闭或再次打开前保留。

### 3.4 默认值语义

| 字段 | 默认值 | 来源 | 备注 |
| --- | --- | --- | --- |
| URL | 空 | — | 必填；不读取剪贴板（避免隐式外发） |
| 工作区名 | 从 URL 推导 | URL 最后一段，去掉 `.git` | 一旦用户编辑则 probe 不覆盖 |
| 父目录 | `home_dir()/taomni-workspaces` | `dirs::home_dir()` + 固定子目录 | 用户仍可在 Location 中改成任意目录；QA 用例通过 fixture 覆盖 |
| 分支 | `init.defaultBranch`，无则 `main` | `git config --global --get init.defaultBranch` | probe 成功且字段未被用户编辑时改为远端默认分支 |
| `user.name` / `user.email` | 全局 Git 配置 | `git config --global` | 可为空 |
| 代理模式 | 应用代理已启用且可解析 → Application；否则 No proxy | Taomni `proxy.json` + vault | 解析失败显示 `appProxyError`，不禁用整个对话框 |
| `http.proxy` / `https.proxy` | 解析后的应用代理 URL（去除 userinfo） | `ResolveDefault` 去敏 | 永远不把代理密码回传 renderer；克隆时后端重新解析完整 URL |
| token | 空输入 + 若 vault 有固定 entry 则 `Use saved token` 勾选 | `vault:git-clone-token-v1` | 明文 token 永不回填、不写 Git config |
| token 用户名 | `x-access-token` | 常量 | GitHub PAT 常用；GitLab 可改 `oauth2` |
| Remember token | vault 已解锁时勾选，否则禁用 | `vault_status` | 只在克隆成功后写入 |

### 3.5 校验

- URL：非空、无控制字符、非 `-` 开头；接受 `http(s)://`、`ssh://`、`git://`、`file://`、`user@host:path`、绝对本地路径；HTTP(S) authority 内禁止 userinfo（含 token 的 URL 要求改用 Token 字段，避免明文写进 `.git/config`）。
- 名称：非空、不含 `/`、`\`、`..`、控制字符。
- 父目录：绝对路径。
- 分支：非空时禁止开头 `-`、空白、控制字符、`..`、`@{`；单段为空/`//` 拒绝。
- 代理：custom 模式至少一个 URL 且每个为 `http(s)://` 或 `socks5://`，含主机与端口。
- 目标目录：不存在或为空目录；否则后端返回明确错误，不覆盖。
- 重复任务：同一目标目录同时只允许一个克隆。

## 4. 后端契约

### 4.1 新增 Tauri 命令

```text
git_clone_defaults() -> GitCloneDefaults
git_clone_probe(request: GitCloneProbeRequest) -> GitCloneProbeResult
git_clone_repository(request: GitCloneRequest) -> GitCloneResult
git_clone_cancel(task_id: String) -> ()
```

事件：`git-clone-progress`，payload 为 `GitCloneProgress`。

```rust
struct GitCloneDefaults {
  git_available: bool, git_version: Option<String>,
  user_name: Option<String>, user_email: Option<String>,
  default_branch: String, clone_root: String,
  app_proxy_enabled: bool,
  app_proxy_url: Option<String>,   // 去 userinfo，可展示
  app_proxy_error: Option<String>,
  vault_state: String,             // empty | locked | unlocked
  saved_token_available: bool,
}

struct GitCloneProbeRequest {
  url: String,
  proxy_mode: String,              // app | custom | none
  http_proxy: Option<String>, https_proxy: Option<String>,
  token: Option<String>, token_username: Option<String>,
  use_saved_token: bool,
}

struct GitCloneProbeResult {
  default_branch: Option<String>,
  head_oid: Option<String>,
  branches: Vec<String>,           // 上限 200，用于 datalist
}

struct GitCloneRequest {
  task_id: String, url: String, destination: String, workspace_name: String,
  branch: Option<String>,
  user_name: Option<String>, user_email: Option<String>,
  proxy_mode: String, http_proxy: Option<String>, https_proxy: Option<String>,
  token: Option<String>, token_username: Option<String>,
  use_saved_token: bool, remember_token: bool,
}

struct GitCloneResult {
  task_id, destination, repo_root, branch: Option<String>,
  default_branch: Option<String>, head_oid: Option<String>,
  remote_url, duration_ms: u64, token_remembered: bool,
}

struct GitCloneProgress {
  task_id: String,
  phase: String,                   // preparing|connecting|counting|receiving|resolving|updating|finalizing|completed|failed|cancelled
  percent: Option<f64>,            // 0..100
  indeterminate: bool,
  message: String,
  objects_done: Option<u64>, objects_total: Option<u64>,
}
```

所有类型 `serde(rename_all = "camelCase")`，与前端 camelCase 对齐。

### 4.2 执行流程

1. 校验并规范化请求；登记 `task_id -> {cancel flag, destination}`，拒绝重复目标。
2. `proxy_mode == app`：读取 `proxy.json` 并 `resolve_default`。已启用但未配置/解析失败 → 明确错误，不静默直连。`custom` 校验 URL；`none` 强制空代理。
3. 目标目录：不存在则记录 `created=true`；存在且非空 → 错误；存在且为空 → 允许，`created=false`。
4. 写入 `preparing` 进度；创建父目录；spawn：
   ```
   git -c http.proxy=<v> -c https.proxy=<v> [-c credential.helper=] clone --progress [--branch <b>] -- <url> <destination>
   ```
   - 无代理时显式传空字符串，绕过 `http_proxy`/`https_proxy` 等隐式环境代理。
   - token 存在时：`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=<临时脚本>`、`TAOMNI_GIT_USERNAME`、`TAOMNI_GIT_PASSWORD`，并禁用 credential helper，确保使用本次 token。
   - 无 token 时：保留系统 credential helper 能力，设置 `GIT_TERMINAL_PROMPT=0` 防止 stdin 挂起。
5. 读取 stderr（按 `\r`/`\n` 拆行），解析阶段/百分比/对象计数，节流后 emit。stdout 丢弃。
6. 每 120ms 检查取消标记；取消时 kill 子进程、等待退出、清理本次创建的目录、emit `cancelled`、返回 `Err("Git clone cancelled")`。
7. 成功后在目标仓库执行：
   - `git config --local user.name/user.email`（非空时；空值不覆盖全局）；
   - `git config --local http.proxy/https.proxy`（包括空值，使 No proxy 对未来 fetch 仍生效）；
   - token 处理：`remember_token` 且 vault 解锁 → `put_fixed("git-clone-token-v1", ...)`；`use_saved_token` → 使用既有 entry。写 `taomni-auth.origin.username` 与 `taomni-auth.origin.tokenRef = vault:git-clone-token-v1`，未来 fetch/pull/push 复用（不把 token 写进 `.git/config`）。
   - 读取 `HEAD` 分支与 oid。
8. emit `completed`，返回结果；最后移除任务登记。
9. 失败（非取消）也清理本次创建目录，emit `failed`，返回 stderr 摘要。

### 4.3 进度解析与映射

- `Cloning into …` → connecting，不确定进度。
- `Enumerating/Counting objects` → counting，整体 0–5%。
- `Compressing objects` → counting，整体 5–10%。
- `Receiving objects: N% (done/total), size | speed` → receiving，整体 `10 + N*0.8`%。
- `Resolving deltas: N%` → resolving，整体 `90 + N*0.08`%。
- `Updating files: N%` / `Checking out files` → updating，整体 `98 + N*0.02`%。
- 无百分比的已知阶段行保留 message，indeterminate=true。
- 其他 stderr 行只在最近消息中展示，不改变阶段/百分比；单行截断 500 字符。

### 4.4 Probe

对 URL 执行 `git ls-remote --symref --heads -- <url> HEAD`（同样应用代理/token）：

- 解析 `ref: refs/heads/<default>\tHEAD` 与 `refs/heads/<name>`；
- 返回 `default_branch`、HEAD oid、branches（上限 200）；
- 失败返回 stderr 摘要；前端显示为非阻塞提示，不阻止用户直接 Clone。

### 4.5 安全与兼容

- token 只经 IPC 参数与进程环境传递；不写日志、不写 Git config、不回填明文。
- URL 中的 userinfo 被拒绝，避免 `.git/config` 持久化明文凭据。
- 目标目录只在“本次创建”时删除；已存在目录绝不递归删除。
- 使用现有 `new_git_command()`（Windows 无控制台窗口、稳定 locale、`GIT_OPTIONAL_LOCKS=0`）。
- 代理密码由后端从 vault 解析，不进入 renderer。
- 所有路径用 `PathBuf`；Windows 路径、macOS/Linux 路径都由后端处理，前端只拼接展示用的目标预览。

## 5. 前端契约与状态

### 5.1 `src/lib/gitClone.ts`

- 类型与 Rust 对齐。
- `gitCloneDefaults/probe/repository/cancel` invoke 包装。
- `listenGitCloneProgress(cb)` 包装 `@tauri-apps/api/event`，便于测试 mock。
- 纯函数：`deriveRepoNameFromUrl`、`validateCloneUrl`、`validateBranchName`、`validateWorkspaceName`、`joinDestination`、`normalizeCloneForm`（供 store/表单/单测共享）。

### 5.2 `src/stores/gitCloneStore.ts`

状态：

```ts
{
  open: boolean,
  defaults: GitCloneDefaults | null,
  defaultsStatus: "idle"|"loading"|"ready"|"error",
  defaultsError: string | null,
  task: {
    taskId, request, phase, percent, indeterminate, message,
    objectsDone, objectsTotal, startedAt, finishedAt,
    error, result, partialPath?
  } | null,
  openDialog(), closeDialog(),
  loadDefaults(force?), startClone(request), cancelClone(), resetTask(),
}
```

- 模块级 `listenGitCloneProgress` 只注册一次；按 `taskId` 过滤。
- `startClone`：若已有运行任务或相同目标 → 抛错；否则登记任务、await invoke；成功时 `applyGitCloneResult`，失败时记录 error。
- `applyGitCloneResult`：`createWorkspace` → `setActiveWorkspace` → `setActiveSideTab("workspaces")` → 展开根目录 → `upsertRecentWorkspace`（kind `git`）→ 状态栏消息。任务完成时即使对话框已关闭也执行。
- `closeDialog` 只改 `open=false`，不取消任务。
- `cancelClone` 调后端；期间 phase=`cancelling`。

### 5.3 UI 组件

| 文件 | 职责 | 上限 |
| --- | --- | --- |
| `WorkspaceGitCloneModal.tsx` | 对话框组合、焦点陷阱、Esc、渲染表单/进度/成功 | 550 行 |
| `gitClone/gitCloneForm.ts` | 表单模型、默认值应用、校验、URL→名称、分支 cleanliness | 250 行 |
| `gitClone/GitCloneFields.tsx` | Repository/Identity/Proxy/Auth 字段视图 | 400 行 |
| `gitClone/GitCloneProgressView.tsx` | 进度/错误/成功状态视图 | 200 行 |

交互细节：

- 打开时焦点在 URL；`Escape` 空闲时关闭，Clone 中不取消（避免误取消），`Close` 明确保留任务。
- `Tab` 循环限制在对话框内；`aria-modal`、`role=dialog`、`aria-labelledby`。
- URL blur 或 `Detect` 触发 probe；probe 期间按钮显示 spinner，不被过期响应覆盖（用请求序号/Abort 式 guard）。
- 代理模式切换：
  - app → 恢复 defaults 的只读值；
  - custom → 保留当前值并允许编辑；
  - none → 清空并禁用输入。
- 成功状态提供 `Create another`（清空表单、保留默认值）与 `Close`。

### 5.4 浏览器 stub

新增 `src/stubs/commands/gitClone.ts`，供 browser QA 与 `pnpm dev`：

- `git_clone_defaults`：可被 `localStorage["taomni.qa.gitClone"]` 覆盖；默认返回浏览器预览可用的预填值。
- `git_clone_probe`：返回配置的默认分支/分支列表；URL 含 `missing` 时抛错。
- `git_clone_repository`：按步骤 emit `git-clone-progress`，支持 `success|slow|fail` 场景与取消；成功时在 IndexedDB VFS 创建目标目录与文件，并返回结果；记录去敏请求到 `localStorage["taomni.qa.gitClone.lastRequest"]`（token 仅记录 `tokenProvided`，不记录明文）。
- `git_clone_cancel`：设置取消标记。

Native 模式不使用 stub，验证真实 Git 与磁盘。

## 6. 三端适配

- 所有命令/事件与平台无关；路径由 Rust `PathBuf` 与 `dirs` 处理。
- Windows：`new_git_command` 的 `CREATE_NO_WINDOW` 防止克隆时闪控制台；路径含空格由 Command 参数传递，不拼 shell 字符串。
- macOS：AppKit 菜单与浏览器预览差异不影响本对话框；`Escape`/焦点陷阱在 WebView 与浏览器一致；不新增全局快捷键。
- Linux：Wayland/X11 下仅使用 WebView 内交互；原生文件选择沿用平台对话框（Browse 使用现有 `selectFolderPath`）。

## 7. 验收标准（AC）

| ID | 验收结果 |
| --- | --- |
| AC-01 | Workspaces 的 `+` 菜单、工作区切换器菜单、Home 卡片都能打开同一个克隆导入对话框。 |
| AC-02 | 打开对话框后 `user.name`/`user.email` 来自全局 Git 配置（有值时）；分支预填全局 `init.defaultBranch` 或 `main`；父目录默认 `~/taomni-workspaces` 且可编辑/浏览选择；代理模式与两个代理字段预填 Taomni Settings 的应用代理；vault 有 token 时 `Use the saved token` 默认勾选。 |
| AC-03 | 代理三模式行为正确：Application 不可编辑并使用后端解析值；Custom 可编辑且校验 URL；None 清空、禁用并显式绕过环境代理。 |
| AC-04 | URL/名称/父目录/分支/代理校验在提交前给出可读错误；非法输入不调用后端。 |
| AC-05 | `Detect`/URL blur 能探测默认分支与分支列表；失败只提示，不阻止克隆；用户已编辑分支时不被覆盖。 |
| AC-06 | 克隆显示连接/计数/接收/解析/更新阶段与百分比、对象计数、最近输出；进度来自真实事件。 |
| AC-07 | 取消会停止 Git 网络活动、删除本次创建目录、显示 cancelled；已存在目标目录不会被删除。 |
| AC-08 | 关闭对话框不取消任务；菜单显示进行中百分比；重新打开恢复同一任务与进度。 |
| AC-09 | 成功后创建并切换工作区、登记 Home 最近工作区、展开项目树根目录；仓库本地 `user.name/user.email/http.proxy/https.proxy` 符合表单；分支正确检出。 |
| AC-10 | token 只在用户选择时写入 vault，并以 `taomni-auth.origin.tokenRef` 复用；`.git/config` 与日志不含 token 明文；URL userinfo 被拒绝。 |
| AC-11 | 失败显示 Git 错误摘要，不发布半成品；重试可用；相同目标不会并发克隆。 |
| AC-12 | 浏览器（stub）与 Windows native（真实 Git/磁盘）用例通过；Linux/macOS browser+native 在 GitHub hosted runner 通过；受影响既有用例与 crash-regression 通过。 |

## 8. 决策记录（DEC）

| ID | 问题 | 结论 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| DEC-01 | 入口放哪里 | `+` 菜单为主，切换器菜单与 Home 卡片为次入口 | 不改变现有 New Workspace/Add Folder 语义；三个入口共享同一对话框与任务状态 | agent 自决 |
| DEC-02 | 取消/失败后的半成品 | 删除本次创建的目录，不做续传 | Git clone 无可靠断点协议；保留半成品 `.git` 可能被当作有效仓库；删除是唯一“安全部分数据” | agent 自决 |
| DEC-03 | token 默认显示 | 不回填明文；用 `Use the saved token` 表达默认 | 避免明文进入 DOM/截图/测试产物；默认行为仍然“先带入” | agent 自决 |
| DEC-04 | 代理默认展示 | 只展示去 userinfo 的 URL；克隆时后端重新解析完整代理 | 代理密码不进入 renderer，且应用代理变更即时生效 | agent 自决 |
| DEC-05 | 分支默认 | `init.defaultBranch`/`main` 预填，URL probe 后若用户未编辑则替换为远端默认分支 | 兼顾“有默认值”和仓库默认分支不是 main 的现实 | agent 自决 |
| DEC-06 | 配置落点 | `user.*`/`http.proxy`/`https.proxy` 写入克隆仓库本地配置；token 只进 vault + `taomni-auth` | 不污染全局 Git 配置；后续 fetch/pull 保持本次代理与认证语义 | agent 自决 |
| DEC-07 | 本地 fixture URL | 支持本地绝对路径/`file://` 作为克隆源 | 让 native 用例真实执行 Git 与磁盘，不依赖外网和账号 | agent 自决 |

## 9. 任务拆分（TASK）

| ID | 任务 | 主要文件 | 依赖 |
| --- | --- | --- | --- |
| TASK-01 | 设计文档与线框图 | `docs-feature/git-clone-workspace/**` | — |
| TASK-02 | 后端 clone/probe/defaults/cancel、进度解析、配置与 vault 写入 + Rust 单测 | `src-tauri/src/git.rs`、`src-tauri/src/git/clone*.rs`、`src-tauri/src/commands/git.rs` | TASK-01 |
| TASK-03 | 前端类型/IPC/纯函数 + 单测 | `src/lib/gitClone.ts`、`src/lib/gitClone.test.ts` | TASK-02 |
| TASK-04 | 克隆任务 store（后台所有权、完成落库、取消、去重）+ 单测 | `src/stores/gitCloneStore.ts`、`src/stores/__tests__/gitCloneStore.test.ts` | TASK-03 |
| TASK-05 | 对话框与字段/进度组件、入口接入、i18n | `src/components/workspace/**`、`src/lib/i18n/locales/{en,zh-CN}.ts` | TASK-04 |
| TASK-06 | 浏览器 stub 与组件单测 | `src/stubs/commands/gitClone.ts`、`src/stubs/tauri-core.ts`、组件测试 | TASK-05 |
| TASK-07 | QA fixture、browser/native 用例、policy/dependencies/feature-list/controls | `qa-ui-auto-tests/**`、`.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/git_clone_source.py` | TASK-05 |
| TASK-08 | 本地 unit/typecheck/refactor/Rust 测试 | — | TASK-02..07 |
| TASK-09 | Windows browser/native 本机执行 | `qa-ui-auto-tests/**` | TASK-08 |
| TASK-10 | GitHub `qa-ui-auto-platforms` Linux/macOS browser+native 执行、分片下载、修复 | `.github/workflows/qa-ui-auto-platforms.yml`（dispatch） | TASK-09 |

## 10. 验证计划（V）

| ID | 检查 | 期望 | 状态 |
| --- | --- | --- | --- |
| V-01 | `pnpm exec vitest run` 相关前端单测 | 全绿；覆盖默认值、校验、进度、取消、后台完成、去重 | 待执行 |
| V-02 | `cargo test --lib git::clone` | 全绿；覆盖本地克隆、分支、身份/代理配置、失败清理、进度解析 | 待执行 |
| V-03 | `pnpm exec tsc -b` + `pnpm check:refactor` | 通过；新文件 <800 行、边界契约通过 | 待执行 |
| V-04 | `python -m qa_ui_auto.audit --gate` + `dev_contract.py` | 目录/策略/controls 一致 | 待执行 |
| V-05 | 本机 Windows browser `TC-WS-GIT-CLONE-01`/`02` | 通过，证据含默认值、模式、进度、取消、后台恢复、成功工作区 | 待执行 |
| V-06 | 本机 Windows native `TC-WS-GIT-CLONE-03` | 通过；真实 Git 克隆、分支/文件、仓库配置、工作区树 | 待执行 |
| V-07 | GitHub `qa-ui-auto-platforms` linux,macos browser+native | 目标用例通过；失败与本次无关的保留并说明 | 待执行 |
| V-08 | crash-regression 套件 | 本机 Windows 与托管对应平台通过 | 待执行 |

## 11. 风险与已知边界

1. 真实 GitHub 克隆依赖网络与账号；本轮 hosted 用例若访问外网，使用代理 `http://192.168.0.110:31028` 或本地 fixture。用例默认使用本地仓库保证确定性。
2. Git 版本差异（`--progress` 文案、`init.defaultBranch` 支持）通过解析容错与全局默认回退处理；极旧 Git 只保证本地 clone 基本路径。
3. 关闭对话框后应用重启会丢失任务状态；后端可能已完成但前端未落库。本轮不实现跨重启任务恢复，文档明确为未验证边界。
4. `file://`/本地路径克隆不验证网络代理；代理语义由 HTTP(S) 仓库用例和 Rust 配置断言覆盖。
5. 浏览器 stub 只证明 renderer 状态与交互，不证明真实 Git/磁盘/进程；native 用例负责该边界。
