# 工作区文件树拖放导入设计（#792）

## 范围与现状

- 来源：[issue #792](https://github.com/engcapa/taomni/issues/792)，2026-11-12。
- 基线：`d6f67502`；开发分支：`feat/workspace-file-tree-drop-import`。
- 设计状态：可实施；实现与验证状态以末尾证据表为准。
- Windows / macOS / Linux 均为 Tauri 桌面目标。browser 是 renderer/VFS 辅助验证，不等于真实磁盘或 OS 拖放验证。
- 用户要求本地只做单元测试，browser/native 全部通过 `qa-ui-auto-platforms.yml` 执行。
- 当前生产入口是 `ProjectTree` / `projectTreeRendering.tsx` / `ProjectTreeEntryRows.tsx`，由 `createWorkspaceSideContents.tsx` 组合挂载。
- `src/components/workspace/WorkspaceFileTree.tsx` 没有生产调用方，本次不修改它。
- `App.tsx` 已通过 Tauri `onDragDropEvent` 将 drop 转发给 `taomni:native-file-drop`；terminal/chat/MFA 等消费者依赖其 drop-only 语义。
- 工作区新建和重命名遇到同名路径返回 `Path already exists`，不覆盖。现有剪贴板复制只走文本文件，不适合外部二进制/目录导入。

本次只实现系统文件/目录落到现有目录或根节点的复制导入。不增加独立导入对话框、根外落点、自动添加工作区根、编辑区打开文件、树内移动或覆盖策略选项。不修改快捷键、应用菜单、持久化格式或网络访问。

## 验收

| ID | 动作 / 前置状态 | 可观察结果 |
|---|---|---|
| AC-01 | 拖多个系统文件到目录或根节点，悬停后松手 | 当前目录节点高亮；松手后创建独立副本；结束/离开清除高亮 |
| AC-02 | 拖包含嵌套文件、二进制和空目录的文件夹 | 递归导入，二进制字节与目录结构保留，源数据不变 |
| AC-03 | 多根工作区选择 root2 的目录或根节点，active file 属 root1 | 只写入命中 root2，不依赖 selected/active/default root |
| AC-04 | 目标存在同名文件、目录或悬空链接 | 批量预检拒绝；不覆盖、不合并、不自动重命名，不修改源或已有目标 |
| AC-05 | 越界目标、`.git`、自拷贝、缺失源、特殊源类型或 I/O 失败 | 显示错误；当前失败项的部分副本清理；其他成功项如实报告；可再次导入 |
| AC-06 | 落在文件、Loose Files、空白、工具栏、遮挡弹层或隐藏工作区 | 不执行导入，不误选父目录或默认根；非文件内部拖拽不被消费 |
| AC-07 | 导入成功后继续操作 | 目标目录展开并刷新，索引/Git 收到变更；可以正常打开导入文本；已有打开/选择/键盘导航/剪贴板行为保持 |
| AC-08 | 开始复制后切换工作区、移除根或关闭树 | 已发出的原生复制继续完成原目标；迟到结果不污染新 owner 的选择/树状态；监听器释放且无重复导入 |

## 决策

| ID | 结论 | 状态与依据 |
|---|---|---|
| DEC-01 | 沿用同名即报错且不覆盖，不增加覆盖确认 | agent 自决：issue 明确复用现有策略；`workspace_create_file` / `workspace_rename_path` 的契约 |
| DEC-02 | 只接受实际目录/根行命中，不把文件行映射为父目录 | agent 自决：issue 的目标是目录节点，多根要求精确落点 |
| DEC-03 | 新增原生 byte-copy IPC，不复用编辑器文本复制 | agent 自决：二进制无损、递归目录、三端可行性；不引入依赖 |
| DEC-04 | 预检整批常规冲突；复制期间逐项报告成功与失败 | agent 自决：原子覆盖不是本需求；禁止静默半成功，失败清理只针对本次拥有的新目标 |
| DEC-05 | 保留原 drop-only 事件，另发 native hover/leave 事件 | agent 自决：已有 terminal/chat/MFA 消费者不能收到 hover 当作 drop |
| DEC-06 | 保留符号链接本身、不跟随递归链接；保护递归 `.git` | agent 自决：复用已有跨平台 symlink helper，避免目录循环和隐式复制链接目标 |

交互只增加既有目录行高亮和复用状态栏反馈，不改变布局或主要信息结构，无需新图稿或人工选型。没有待用户决策项。

## 契约与职责

### 原生文件系统

`workspace_import_paths({ repoRoot: string, directory: string, sourcePaths: string[] })`

成功的结构化响应：

```ts
interface WorkspaceImportResult {
  imported: WorkspaceEntry[];
  failures: { sourcePath: string; message: string }[];
}
```

- `directory` 是工作区内相对路径，空串表示根；`sourcePaths` 是来自系统拖放的绝对路径（不是 URL）。
- 根目录 canonicalize；对原始目标和解析后的目标应用 `.git` 保护、相对路径校验和根内检查；拒绝落到文件。
- 批量预检来源存在性、目标同名（包含悬空链接）、批内同名及把目录复制进自身。预检失败返回错误，尚无写入。
- 使用异步命令 + `spawn_blocking`，不阻塞 WebView。文件用 `create_new` 后逐字节复制，不解码；目录创建后递归，失败清理自己新建的节点。精确树路径使用不裁剪空白的 `sanitize_relative_path_exact`；既有手输路径 helper 的默认 trim 语义不变。
- 失败清理先恢复本次新节点的 owner 可写/可访问权限，再删除，避免只读子目录遗留；`symlink_metadata` 明确不跟随链接，不改变源或链接目标权限。
- 不跟随源符号链接；Windows 由现有 `copy_resource_symlink` 选择 file/dir API，权限失败照实反馈。
- 复制中的独立错误记录 `failures`，其他成功项保留在 `imported`；不宣称跨多个顶层项事务回滚。
- Rust 新模块 `workspace/import_paths.rs` 持有递归与清理；测试独立在 `workspace/tests/imports.rs`。
- 既有超 800 行 `commands/mod.rs` 中的工作区命令匹配责任提到 `commands/workspace.rs::handles`，既有命令名及分发对象保持。

### 前端

- `nativeFileDrag.ts` 统一转换 Tauri physical position 为 client CSS position（除以 DPR），既有 `taomni:native-file-drop` payload 不变；hover/leave 使用独立事件。
- `useProjectTreeFileDrop` 持有 DOM 命中、高亮和监听器生命周期。HTML5 按 `Files` / `text/uri-list` 识别；native 通过 `elementFromPoint` 命中当前可见行。
- 目录行 `data-tree-kind=dir` 的 `data-root-id + data-path`；根行 `data-tree-kind=root` 的 `data-root-id + path=''`。文件行/空白/工具栏不回退到祖先目录。
- 高亮是 `data-drop-target=true`，CSS 使用既有主题变量，list 固定名称列同样高亮；不修改选择/焦点，不自动打开文件。
- 独立导入动作 hook 持有请求 in-flight 与 owner 检查。复制开始快照 root/path，完成后只刷新仍属于该 owner 的目标目录/索引，通知 Git，不偷换活动根。
- IPC 客户端验证结构化响应后才通知文件变更。browser stub 使用 VFS 二进制复制和独立临时节点；stub 不证明 native 行为。导入命令同时登记到 `tauri-core.ts` 的总注册表，并用穿过总 invoke 的单测保护。
- 每批成功导入强制刷新一次命中根的 flat index，不依赖当前树模式；保证从 Project 返回 All Files、Packages 或 Go to File 时不会复用导入前索引。

## 任务

| TASK | 文件职责 | AC / 完成条件 |
|---|---|---|
| TASK-01 | `workspace/import_paths.rs`、独立 Rust tests、IPC 注册 | AC-02/04/05，原生文件测试绿 |
| TASK-02 | `nativeFileDrag.ts`、`App.tsx`、`useProjectTreeFileDrop`、ProjectTree CSS、独立导入动作 hook 与调用方 | AC-01/03/06/07/08，mounted/逻辑测试绿 |
| TASK-03 | typed importing client + VFS stub + 各层单元测试 | 结构化成功/失败/变更通知、无文本损坏、重试 |
| TASK-04 | QA verb/fixture、browser/native case、catalog/policy/dependencies | 每个新增 case 注册且 verification 对齐；只在 GitHub 执行 UI 用例 |
| TASK-05 | 集成与证据回填 | 相关回归 + 完整 crash-regression、三端兼容检查；本次新增失败修复再跑 |

## 验证选择

| V | AC / 目标与保留行为 | 执行与核心断言 | 初始状态 |
|---|---|---|---|
| V-01 | AC-02/03/04/05 | `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace::tests::imports`：真实临时磁盘、字节/源保留/空目录/冲突/越界/符号链接/失败清理 | 待执行 |
| V-02 | AC-01/03/06/08 | Vitest 专项：native hover/drop CSS坐标、HTML5 payload、目录/root2 命中、遮挡/文件/空白拒绝、清理和重复事件 | 待执行 |
| V-03 | AC-04/05/07/08 | 导入动作 hook：精确 root、展开刷新、错误重试、成功失败混合、移除根/卸载迟到结果；typed IPC 与 VFS bytes 单测 | 待执行 |
| V-04 | AC-07 保留行为 | ProjectTree navigation/rendering/virtualization、现有文件动作/剪贴板、shared native drop unit tests | 待执行 |
| V-05 | AC-01..07 | 新增 QA 专项；browser 真实 DOM 事件 + VFS，native Tauri event入口 + Rust +真实磁盘断言 | 待 GitHub |
| V-06 | 生命周期回归 | workflow 选完整 `crash-regression`，native matching release QA binary；另选 TC-WS-008/036/037 等受影响用例 | 待 GitHub |

本地不启动浏览器、应用或 native UI runner。允许单元测试、类型/格式/边界和 case 静态检查；不执行额外本地应用构建。

## 三端真机与证据边界

- Linux：GitHub Ubuntu 24.04 Xvfb / WebKitGTK，使用 workflow 验证 source-bound release QA binary（producer Ubuntu 22.04）。
- Windows：GitHub Windows 2025 x64 / WebView2，绝对盘符路径、多根落点、实际磁盘内容。
- macOS：GitHub macOS 15 ARM64 / WKWebView，同一生产事件/磁盘路径，不要求 Windows/Linux 自定义 chrome，不修改 Command 快捷键。
- 三端 native 专项注入 `tauri://drag-enter/over/drop/leave` 并穿过生产 `App.tsx`；这不是文件管理器的实际 OS 手势。OS 到 Tauri 的路径枚举与物理手势仍需按下述手册补测。
- 手工步骤（三端一致）：准备工作区外文件/含二进制及空目录的文件夹，文件管理器选中拖至 root2 的目录，观察仅该行高亮，移出清除，松手后目录出现；用系统文件工具比对源/目标 hash；重复同名拖入应报错且原目标 hash 不变；新文件重试成功。再拖到文件/空白/弹层，均无导入。
- 手工测试不得删除用户配置；只清理本轮临时工作区。GitHub fixture 位于报告根、原始报告保留供失败分析。

## 实施与验证记录

本地实际验证（2026-11-12，Node 22.18.0 / pnpm 10.30.0，Rust 1.98，Linux）：

- V-01：导入 Rust 单测最终 9 passed（增加精确首尾空格目录名与只读副本回滚）；既有 resources 单测 9 passed。
- V-02..04：集中前端 11 files / 78 passed；树 compact / 索引 / 外部变化刷新 3 files / 27 passed。
- 终端/SFTP 共享 drop-only 事件回归：8 passed，123 tests 因 `-t 'drop|drag'` 未选中，不计通过。
- `pnpm exec tsc -b`、`pnpm check:refactor`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 均通过。
- 未启动本地 Vite、browser 或 native UI；没有本地应用构建。Rust 编译输出含既有大量 warnings，未据此声称无 warning。
- 原始日志：`/tmp/taomni-792-final-frontend-unit.log`、`/tmp/taomni-792-final-rust-unit.log`、`/tmp/taomni-792-rust-retained.log`、`/tmp/taomni-792-tree-refresh-unit.log`、`/tmp/taomni-792-shared-drop-unit.log`、`/tmp/taomni-792-typecheck.log`、`/tmp/taomni-792-boundaries.log`、`/tmp/taomni-792-format.log`（本机临时日志，不随仓库分发）。

- 独立审阅确认的 4 项问题均已修正并复查：精确目录路径、browser 总注册表、flat index 强制刷新、只读复制项回滚。
- 额外前端审阅回归：`tauri-core.importPaths.test.ts`、`tauri-core.test.ts`、`useWorkspaceDropImport.test.tsx` 共 14 passed（其中新增总入口测试 2 个，既有测试重跑不重复累计）。
- QA 工具最终组合 `python -m unittest test_native_drag test_control_coverage_window test_ci_selection`：47 passed；该集合包含新拖放 transport/fixture/oracle 单测与 Node VM 脚本契约，不启动浏览器。
- `audit --gate`：717 cases、0 schema errors、catalog 一致、coverage ratchet 通过；全仓既有 coverage gaps 仍明确存在，不等于全 App 覆盖完成。
- TC-WS-087（browser，82 steps）和 TC-WS-088（native，89 steps）reviewed 行为映射校验通过。TC-WS-088 增加 7 项独立磁盘 SHA256 断言。
- 静态规划已确认三平台每个 browser 组合 12 cases、native 组合 13 cases，包含新专项、TC-WS-008/036/037 保留行为及完整 crash-regression；共 75 次 case 执行计划，native 统一 release build。

GitHub V-05/V-06 尚待执行；提交 SHA、run URL、case/pass/fail/skip、构建 hash、逐平台结果待回填。真实 OS 手势仍未验证。

失败归因参考：主分支 `2d8bc8dc` 的完整 QA [run 43135286535](https://github.com/engcapa/taomni/actions/runs/43135286535) 聚合报告已保存到 `/tmp/taomni-792-baseline.Dw0Jeq/summary.md`（独立下载目录，未运行其中脚本）。该基线包含 Mobile/VNC/Notes/旧 Git tab selector 及少量时延失败；不把其失败结论外推为本次任意失败可忽略。候选出现失败须与原始 case/步骤/产物逐项比对，本次引入的回归必须修复。

指定 `10.1.0.80:3228` 代理两次 GitHub CONNECT 超时，后续 `gh` 直连成功；没有修改用户持久代理设置。
