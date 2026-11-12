# 工作区双向文件剪贴板设计

## 目标与基线

- 来源：用户在 #792 拖放导入验收完成后明确要求继续完成系统文件管理器 ↔ Taomni Workspace 的两种跨应用文件粘贴（2026-11-12）。
- 基线分支 `feat/workspace-file-tree-drop-import`，产品/QA `9430ee61`、说明 `8af88989`；新分支 `feat/workspace-system-file-clipboard`。
- Windows / macOS / Linux 桌面应用。保持用户要求：本地只做单元测试；GitHub `qa-ui-auto-platforms` 执行 browser/native 与完整 crash-regression。
- 设计可实施，不代表验证已完成。使用现有 Copy/Paste 上下文菜单及标准快捷键，不改变布局、不新增模式选择，无需图稿决策。

## 现状证据

- `useWorkspaceFileActions.ts` 的 `treeClipboardRef` 仅保存应用内部一个节点，Copy 通过文本读取/新建实现，不能保留二进制或递归目录；跨根被拒绝。
- `controller/treeActions.ts::createShowTreeContextMenu` 的 Paste 是否启用只检查内部 ref，因此系统复制无法激活菜单。
- `lib/clipboard.ts` 有 `readFiles/writeFiles`，尚未接入 Project 树；readFiles 吞掉错误，不能区分无文件与读取失败。
- `config/clipboard.rs` 文件写入失败会 fallback 成路径 URI 文本，这是旧行为，不能作为系统文件管理器粘贴成功的依据。
- Windows 已有 CF_HDROP；macOS 已有原生 file_list writer，reader 的逐行 trim 不适合精确文件名；Linux writer 尚未实现。共享消费者包含 terminal/RDP，需要保留公开 IPC/默认参数及文本行为。
- #792 的 `workspace_import_paths` 已通过三平台真实磁盘专项，复用它的批量预检、no-overwrite、二进制/递归、失败清理和结构化结果。

## 决策与范围

| DEC | 结论与依据 | 状态 |
|---|---|---|
| DEC-CB-01 | 系统→Taomni Paste 读取原生文件列表，复用同一导入动作；粘贴目标由当前选中目录/根或文件父目录决定，显式右键目标优先，不能偷偷用 active root | agent 自决：已有文件树操作惯例与用户“与拖拽一样” |
| DEC-CB-02 | Taomni Copy 发布原生文件引用，不复制文件字节到剪贴板；系统文件管理器实际 Paste 时执行自己的文件复制 | agent 自决：三端标准文件剪贴板语义 |
| DEC-CB-03 | 写原生文件格式失败就报错，不 fallback 文本并声称成功；不改变独立 Copy Path/文本 Copy | agent 自决：防止假成功 |
| DEC-CB-04 | 已有内部 Cut/移动仍是同根移动，不增加跨应用剪切、不删除系统中剪切的源（系统来件始终按 copy） | agent 自决：用户请求复制粘贴，避免扩展破坏性语义 |
| DEC-CB-05 | Project 树现有单选不变；支持系统剪贴板多文件粘入，以及复制当前选中单个文件/目录/根到系统 | agent 自决：不引入全套树多选 UI；多文件由系统入口承载 |
| DEC-CB-06 | 右键 Paste 是可尝试动作，不做后台高频系统剪贴板轮询；点击后读最新原生文件列表，空/失败给出明确反馈 | agent 自决：系统剪贴板可随时变化，旧 internal ref 不能决定可用性 |

## 验收

| AC | 用户动作 | 结果 |
|---|---|---|
| AC-CB-01 | 系统复制多个文件/含二进制及空目录的文件夹，右键 root2 目录 Paste | 复制到显式目标；源与 root1 不变，目标树及索引刷新 |
| AC-CB-02 | Project 树选中文件或目录 Copy，再到系统文件管理器 Paste | 系统拿到原生文件列表并能创建正确字节/递归结构的副本，不是路径文本 |
| AC-CB-03 | 先在树 Copy A，再在系统 Copy B，然后回树 Paste | 使用最新系统 B，不使用陈旧内部 A；文本/空剪贴板不恢复陈旧文件操作 |
| AC-CB-04 | 同名、根外、受保护目标、缺失源、剪贴板读写失败、复制 I/O 失败 | 不覆盖/不删除源，明确反馈；失败后重新复制/粘贴可恢复 |
| AC-CB-05 | Ctrl+C/V（Win/Linux）、Cmd+C/V（macOS）焦点在树，或真实 copy/paste DOM 事件 | 只执行一次；与右键菜单一致，输入框/编辑器/终端、IME不被抢占 |
| AC-CB-06 | 既有同根内部 Cut→Paste、文件打开、编辑器文本 Copy/Paste 与终端信号 | 保留原结果和失败语义，文件复制改为二进制递归不再走文本API |
| AC-CB-07 | Paste 中切换/卸载工作区、移除目标根、重复触发；Copy 完成迟到 | 原目标操作不变，迟到结果不污染新owner；同一请求去重；正常离开树不清空系统剪贴板 |
| AC-CB-08 | Linux X11/Wayland、Windows、macOS 的原生文件剪贴板 | 持续可读的有效原生格式；不依赖短命对象；原生失败不伪装文本成功 |

## 模块与生命周期

### 前端

- 从 `useWorkspaceFileActions.ts` 提取整个树剪贴板 state/async/failure owner 到 `useWorkspaceTreeClipboard`，原 facade 名称和 Cut 默认语义保留，减少大文件职责。
- Copy 计算源绝对路径并写原生文件列表。写入成功才反馈“已复制文件”，Copy Path 仍单独写文本。原生 Clipboard 写入发生在用户操作中，不落盘持久化旧文件列表。
- Paste 开始快照目录/根，读取最新文件列表。无文件返回明确消息，不因之前内部 Copy 回落到旧路径。读取错误返回可行动错误，不静默当空。
- 内部 Cut 用带代次和 owner 的 ref 保留；窗口失焦、收到另一 copy/cut DOM 事件，或共享clipboard helper成功写入文本/文件/多格式/图片时立即失效，不通过路径相等来猜测系统剪切授权。离开应用后回来只能走系统复制粘贴，避免外部Copy同一路径意外删除源。此条是为跨应用复制新增的安全限制，应用内同根Cut→Paste保留；不拓展系统cut。
- 复制导入复用 `useWorkspaceDropImport`（将其作为 shared import action），不 duplicating filesystem pipeline；成功后 refresh target/flat/Git，不自动改编辑内容。
- 新树键盘/DOM copy/paste owner 仅处理非编辑字段的 tree 上下文，平台精确修饰符和 composing guard；需要防止一次 keydown 和默认 paste event重复执行。
- browser 使用 VFS 与内存 file clipboard stub，明确不能访问系统文件管理器，也不能证明原生格式。

### 原生

- 保留 `clipboard_read_files` / `clipboard_write_files` 的 IPC 名和 `{paths}`。补严格结果读取，旧 `readFiles()` 可以继续 best-effort，不改变终端缺剪贴板时的处理。
- 按平台使用真正文件列表（Windows CF_HDROP、macOS file URLs、Linux MIME URI/desktop copied-files）。Linux owner 必须长生命周期，Wayland 不得悄悄写到无效 X11 owner。
- 路径数量/类型/存在性预检，不裁剪系统提供的合法名字；写失败返回错误而不是 URI 文本 fallback。
- 不增加网络/下载，不改代理配置或普通文本剪贴板行为。

## 快捷键与菜单契约

| 动作 | Windows/Linux | macOS | 焦点 | 菜单/可见结果 |
|---|---|---|---|---|
| 文件 Copy | Ctrl+C | Cmd+C | Project tree 非编辑字段 | Copy 菜单同一路径；系统原生file clipboard更新一次，源不变 |
| 文件 Paste | Ctrl+V | Cmd+V | Project tree 已选目录/根，文件选中取父目录 | Paste 菜单显式右键目录优先；创建副本+刷新/错误 |
| 内部 Cut | Ctrl+X | Cmd+X | Project tree 文件/目录 | Cut 保留内部移动，不发布系统move效果 |

macOS AppKit predefined Edit copy/paste 的 WebView responder 路径与新增树处理不能重复；保留编辑器、输入框与Control终端信号。自动化应区分 WebView key/DOM event 与实际 OS键/菜单栏点击。

## 任务与测试

- TASK-CB-01：后端严格文件剪贴板、Linux owner、Win/mac精确路径，纯Rust format/validation单测；本地不得覆盖真实用户clipboard。
- TASK-CB-02：前端树剪贴板职责提取、菜单/键盘/DOM事件、shared import、browser stub；Vitest覆盖最新系统列表、错误、cut保留、迟到/重复/焦点门控。
- TASK-CB-03：新增browser/native入口case与host文件clipboard oracle；同步schema/catalog/policy。复用#792 fixture/byte snapshots，不用直接调用产品复制IPC替代UI。
- TASK-CB-04：本地tsc/format/check:refactor、相关单测；GitHub三端专项+保留TC-WS-036/037、TC-WS-087/088与完整crash-regression，失败看原件修复再跑。

V-CB-01：前端mounted/logic单测；V-CB-02：Rust纯单元；V-CB-03：browser UI/VFS；V-CB-04：三端native实际文件clipboard读写及独立host字节；V-CB-05：系统文件管理器真正Paste互操作（能自动化则执行，否则保留明确gap，不能用读回URI文字冒充系统Paste）；V-CB-06：焦点/快捷键/共享消费者/崩溃回归。

原生验收必须独立读取系统clipboard格式与目标文件hash，验证双向而非产品写→产品读的自证；fixture只用run-owned目录，不清理个人配置或文件。三端真实文件管理器步骤：外部复制fixture→树Paste→hash，树Copy→文件管理器目标目录Paste→hash，切回原工作区保留源，重名拒绝后用新名字恢复；操作前后保留OS剪贴板格式与进程/文件证据，及时清理测试拥有的资源。

## 实施与本地验证记录

- V-CB-01/V-CB-06：前端最终聚焦组合 10 files / **84 passed**，含独立树剪贴板 owner、真实ActionHost平台按键仲裁、DOM clipboard events、原有file actions、共享文本clipboard/native menu、VFS总registry，以及#792 drop/import保留测试。
- 完整 CodeWorkspaceTab 挂载筛选 `-t 'tree|clipboard|context menu'`：**18 passed / 243 未选中**，不是完整261个测试通过。
- V-CB-02：Rust `--lib file_clipboard` **17 passed**（含既有RDP file tests）；`--lib config::` **79 passed**（含格式/路径/文本回归）；格式调整后精确 `config::clipboard::file_clipboard::tests` **11 passed**。macOS-only NSURL纯对象测试本机未执行。
- 独立审阅发现的X11外部owner误判空与CopyPath后陈旧Cut两项均修复并复查。X11始终请求TARGETS，仅失败后raw QuerySelectionOwner==0精确判空；新增3项纯回归，7项ownership filter通过。所有成功shared helper写入使内部Cut失效；前端修正组合5 files/43 passed，含helper通知与不发DOM copy的回归。
- 共享消费者筛选单测：终端16 passed；85个未选中（RdpPanel文件无匹配测试，明确不算RDP执行通过），后端已有RDPfile unit包含在17个Rust filter内。
- `pnpm exec tsc -b`、`pnpm check:refactor`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`git diff --check` 通过；Node 22.18.0、pnpm 10.30.0、Rust 1.98，本地Linux。
- 新QA工具及保留契约单元 58 passed，精确CI选择单测通过；719 cases、0 schema errors、catalog一致，audit ratchet通过。TC-WS-087/088原件不改。
- 新专项 **TC-WS-089（browser，74 steps）**、**TC-WS-090（native，86 steps）** 的 reviewed mappings/schema/template校验通过。
- CI静态选择已核对三平台各 browser 13、native 14，合计 **81** 次case执行计划；包含TC-WS-089/090、新增前已验收的087/088、旧008/036/037以及完整crash-regression，native统一release，无capabilitygaps。
- 未运行任何本地browser/native UI，未读取或覆盖用户真实系统clipboard。V-CB-03/04/05/06 的托管执行仍待开始，以上单元/静态结果不等于真实OS互操作通过。

## 原生兼容与待验证边界

- Windows：CF_HDROP immediate data + message-only owner窗口，真实Explorer/Shell Paste在native case验证。
- macOS：原生NSURL对象，不trim/canonicalize；原有AppKit predefined Edit仍保留，新增tree actions不创建竞争的全局accelerator。Finder真正Paste需要System Events辅助功能授权，缺少权限会失败，不能当作通过。
- Linux：GTK X11/Wayland retained MIME offer，提供标准URI+GNOME copied-files，异步读取不阻塞主线程；Wayland预检聚焦native窗口与keyboard seat。无法区分无offer与权限拒绝时保守报错，不写入无效X11 owner。
- 默认托管Linux使用X11真实PCManFM-Qt Paste；Wayland真实file-manager Paste、物理Cmd/Ctrl键投递、AppKit menu-bar/responder/IME仍需专门OS验证，不从WebView按键结果推导。
- 原生文件列表限制256项、单路径32KiB、总4MiB，失败无text fallback。符号链接本身及合法空格/Unicode路径保持；普通Copy Path/文本复制API不变。
