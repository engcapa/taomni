# Taomni Notepad 实施进展与验证记录

日期：2026-11-21
分支：`feat/notepad-2plus-impl`（基于 `main` e4700a8c3 `feat/notepad-2plus` 合并点）
依据：[taomni-notepad-detailed-design.md](taomni-notepad-detailed-design.md)、[taomni-notepad-development-tasks.md](taomni-notepad-development-tasks.md)、[taomni-notepad-prototype.html](taomni-notepad-prototype.html)（v3）

本文件记录本轮接续实施的**实际状态、证据与相对设计的偏差**；任务板仍是任务状态的权威来源，设计 §3/§9 仍是验收与追踪的权威来源。未在本文件出现的 V-* 仍未执行。

## 1. 本轮完成范围

| 任务 | 状态 | 说明 |
|---|---|---|
| TASK-NP-00 | 已实现待验证 | `spikes/spikes-s1-s6.md`（S-1～S-6 结论 + 对设计的影响） |
| TASK-NP-01 | 已实现待验证 | `notepadStore` 按 `docId` 分区、未命名命名规则、`documentStore` 未命名/`rekey` 支持；V-01/V-02 单测通过 |
| TASK-NP-02 | 已验证（单测） | `src/lib/notepad/transforms/*`：7 口径×升降序排序、8 种大小写、空白、行列变换、列编辑序列、MIME/转义；V-03～V-06 覆盖 |
| TASK-NP-03 | 已实现待验证 | 命令注册表 192 条命令、`Mod` 键位、冲突检测、宏白名单；V-07 单测通过 |
| TASK-NP-04 | 已实现待验证 | 新建/打开/保存/另存/保存副本/全部保存/重命名/关闭系列/回收站；Rust `viewer_save_as/viewer_rename/viewer_trash` 已接入；V-09 部分单测 |
| TASK-NP-05 | 已实现待验证 | `recentFiles` store、最近文件子菜单（打开全部/清空）、恢复最近关闭 |
| TASK-NP-06 | 已实现待验证 | 编码检测/重新解释/转换、EOL 转换与编码损失提示（Rust `notepad_list_encodings`/`check_encoding_loss`） |
| TASK-NP-07 | 已实现待验证 | 外部变更横幅、重载、编辑器/属性只读、远程只读副本 |
| TASK-NP-08 | 已实现待验证 | 会话 JSON（`version`）、启动恢复、运行快照扩展 |
| TASK-NP-09 | 已实现待验证 | 周期磁盘备份、保存时备份、崩溃恢复扫描、`viewerDrafts` 一次性迁移 |
| TASK-NP-10 | 部分实现 | 剪贴板历史/多光标/选择下一个相同词/拖动文本（CM6 默认）；特殊粘贴为“粘贴源码文本” |
| TASK-NP-11 | 部分实现 | 插入日期（短/长/自定义）、INS/OVR、虚拟空格、矩形选择、列编辑器 |
| TASK-NP-12 | 已实现待验证 | 查找/替换/增量/正则/扩展模式/历史/转到行/列/偏移；正则超时保护 |
| TASK-NP-13 | 已实现待验证 | 全部查找（当前/所有打开）、所有打开文档替换、在文件中查找/替换、结果面板、Mark、令牌样式 |
| TASK-NP-14 | 已实现待验证 | 书签（切换/导航/批量）、变更历史导航与清除（DEC-04：与工作区书签保持两套） |
| TASK-NP-15 | 已实现待验证 | `NotepadHost`/`viewerTabHost`、同路径去重、标签标题/脏标记回写、窗口菜单与文档列表、标签内分屏/克隆/旋转/同步滚动 |
| TASK-NP-16 | 已实现待验证 | 全屏/Post-It/专注、行号/标尺、换行/缩放、显示符号、主题/栏显隐、文件摘要 |
| TASK-NP-17 | 已实现待验证 | 文档地图、文档列表、字符面板、搜索结果；右/底/浮动三态停靠 + `⋯` 菜单 |
| TASK-NP-18 | 已实现待验证 | 可点击链接（CM6 默认）、选区动作、复制路径、字符面板、脱敏、哈希、Base64/URL 编解码、JSON 转义 |
| TASK-NP-19 | 已实现待验证 | 宏录制/回放/多次运行/运行到文件末尾/保存/管理/SHA-256 校验；移除占位文案 |
| TASK-NP-20 | 已实现待验证 | 与磁盘版本/剪贴板/其他文档对比（`@codemirror/merge`，5 MB 上限待真机确认） |
| TASK-NP-21 | 已实现待验证 | 打印/立即打印/打印设置/打印到 PDF（隐藏 iframe）；三端行为待真机确认 |
| TASK-NP-22 | 已实现待验证 | 首选项分页、快捷键映射器、新建默认值（默认编码/EOL/命名规则） |
| TASK-NP-23 | 部分实现 | 拖放（文件/文件夹 20 个上限）、外部打开、提权保存（S-5 方案）、大文件降级 |
| TASK-NP-24 | 进行中 | 单元测试通过；browser/native 用例、三端构建与真机验证进行中 |
| TASK-NP-25 | 已实现待验证 | `ViewerShell` 文本分支（text/source/large）改挂 `NotepadEditor`，删除旧 `TextEditor`；外壳横幅与轮询保留；V-47 单测 |
| TASK-NP-26 | 已实现待验证 | `FileHandler` 增加 `notepad`/`taoffice`、注册表、Explorer 打开方式与设置、TaOffice 禁用占位 |

## 2. 代码位置（相对设计 §5 的落实）

- 共享库：`src/lib/notepad/{transforms,commands,search,cm6,macro,persistence,print,host}/`
- store：`src/stores/notepadStore.ts`（Notepad 专有状态）、`src/stores/notepadPreferences.ts`、`src/stores/app/recentFiles.ts`
- 组件：`src/components/notepad/`（`NotepadEditor`、菜单/工具栏/查找条/分屏/状态栏、`panels/`、`dialogs/`、`actions/`）
- 集成：`src/components/viewer/ViewerShell.tsx`、`src/components/explorer/{ExplorerTabStrip,fileOpenMenu}.tsx`、`src/components/settings/{panel/SettingsPanelView,settingsSearch,NotepadSettingsPanel}.tsx`、`src/lib/openFile/{index,preferences,handlers,useViewerRecovery}.ts`、`src/stores/{documentStore,explorerStore}.ts`
- 后端：`src-tauri/src/commands/notepad.rs`、`src-tauri/src/viewer/*`、`workspace/viewer_io.rs`；浏览器 stub `src/stubs/commands/notepad.ts`
- 文档：`docs-feature/notepad-2plus/spikes/spikes-s1-s6.md`

## 3. 与高保真原型的一致性处理

原型（v3）作为 UI/交互目标，逐项落地过程中的**有意偏差**：

| 原型 | 实现 | 原因 |
|---|---|---|
| 顶层菜单 9 个（无“帮助”） | 一致：文件/编辑/搜索/视图/编码/工具/宏/对比/窗口；`help.about` 命令保留但不出现在菜单 | DEC-16 与原型一致；关于对话框通过 F1 命令可用 |
| `另存为` Ctrl+Alt+S、`全部保存` Ctrl+Shift+S | 一致（沿 Notepad++ 约定） | 交互一致性 |
| macOS `重做` 显示 ⌘Y | 保留 ⌘⇧Z | 仓库 AGENTS.md 的 macOS 快捷约定优先于原型 |
| 查找条 Esc 不关闭（原型缺陷） | Esc 关闭并把焦点还给编辑器；所有对话框 Esc 取消 | 设计 §4.2 要求 |
| 原型“紧凑模式”仅隐藏部分区域 | 紧凑模式隐藏页签行与选项/按钮区，保留查询行 | 保持可用性 |
| 字符面板 32–255 + 扩展符号（原型 224 格） | 32–255 去控制字符 + 扩展 Unicode 符号（去重） | 原型重复行/键缺陷 |
| 文档列表面板原型崩溃 | 正常渲染并可排序/激活 | 以设计 AC-32 为准，不复制原型缺陷 |
| 宿主标签固定/排序/MRU 由宿主提供 | Notepad 菜单不出现宿主不提供的能力（`capabilities`），Explorer 标签栏实现固定与批量关闭 | DEC-22 |
| 原型无 Notepad 设置页（只有原型顶部抽屉） | 设置面板新增 Notepad 页 + 首选项对话框（同源组件） | 设计 AC-45 |

## 4. 验证记录

### 4.1 单元测试（本机，Linux）

命令：`pnpm exec vitest run src/lib/notepad src/components/notepad src/lib/openFile src/components/viewer`
结果：63 个测试文件、402 个测试通过（2026-11-21）。覆盖 V-01～V-08、V-13～V-16、V-22～V-29、V-34～V-39、V-46～V-49 等单测层。

新增/更新的关键测试：
- `src/lib/notepad/transforms/transforms.test.ts`（21 项：排序 7 口径×升降、大小写 8 种、空白、行操作、列序列）
- `src/lib/notepad/commands/menus.test.ts`（菜单树 9 项顺序、命令引用完整、子菜单 key 唯一、动态节点、zhLabel、快捷键唯一性）
- `src/components/notepad/__tests__/NotepadEditor.test.tsx`、`dec16Exclusions.test.ts`
- `src/components/notepad/actions/extraCommands.test.ts`、`dialogs/PickerDialogs.test.tsx`
- `src/components/viewer/ViewerShell.test.tsx`（V-47：文本/源码/大文件挂载 Notepad，横幅与关闭守卫保留）
- `src/lib/notepad/host/viewerTabHost.test.ts`（V-46）

静态检查：`pnpm check:refactor` 通过（4910+ 文件，全部 ≤ 800 行）。

### 4.2 浏览器 QA（本机）

用例：`qa-ui-auto-tests/cases/TC-NP-001..005`（F-NOTEPAD-1～4），全部在真实渲染器上执行：

```bash
python -m qa_ui_auto run --mode browser --filter TC-NP-001,TC-NP-002,TC-NP-003,TC-NP-004,TC-NP-005   --require-pass --workers 2   --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml   --report-dir qa-ui-auto-report/browser
```

结果：5 passed / 0 failed / 0 skipped。证据目录 `qa-ui-auto-report/browser/run-20261122-004206-322632473/`（summary.json、runner_receipt.json、每用例截图、空 runtime-errors）。

### 4.3 Linux native QA（隔离会话）

`TC-NP-101`/`TC-NP-102` 使用真实宿主目录（`file_open_files` fixture）验证真实磁盘写入、外部变更冲突、另存为/保存副本路径语义。本机执行方式：

```bash
# 独立 X11 会话 + 独立 D-Bus + 私有 XDG 目录，与 :0 桌面隔离
Xvfb :137 -screen 0 1600x1000x24 & DISPLAY=:137 openbox &
dbus-run-session -- bash -c 'export DISPLAY=:137 \
  XDG_DATA_HOME=qa-ui-auto-report/_local/native-session/data \
  XDG_CONFIG_HOME=qa-ui-auto-report/_local/native-session/config \
  XDG_CACHE_HOME=qa-ui-auto-report/_local/native-session/cache; \
  python -m qa_ui_auto run --mode native --filter TC-NP-101,TC-NP-102'
```

结果：两个用例均 1 passed；QA 二进制身份记录 `src-tauri/target/qa-ui-auto/debug/taomni.qa-identity.json`。

### 4.4 GitHub 托管 CI（qa-ui-auto-platforms）

```bash
gh workflow run qa-ui-auto-platforms.yml --ref feat/notepad-2plus-impl \
  -f scope=selected -f platforms=linux,windows,macos -f modes=browser,native \
  -f case_ids=TC-NP-001,TC-NP-002,TC-NP-003,TC-NP-004,TC-NP-005,TC-NP-101,TC-NP-102
```

selected scope 会自动并入 `crash-regression` 标签用例（AGENTS.md 要求）。

**结果（多轮修复后）：**

| run / head | browser | native |
|---|---|---|
| `44936461619` / `3fab61357` | Linux/Windows/macOS 各 23 passed（22+1 单用例 shard），0 failed；含 TC-NP-001..005 | macOS 4 shards：TC-NP-101/102 通过；Linux/Windows `TC-FILE-OPEN-002`（后续定位为 CM 缺 `defaultKeymap`）与 `TC-FILE-OPEN-006`（`has-text` 选择器不支持 native）失败，其余 crash 套件通过 |
| `44945018379` / `5327b1af9` | 同上，三端 69/69 通过（含 5 个 Notepad 用例） | 三端各 24 cases：TC-NP-101/102 **全部通过**；仅剩 `TC-FILE-OPEN-006` 的 Playwright-only `:has-text` 等待（分支已修） |
| `44951373132` / `a6158201a` | 最终证据运行 | 最终证据运行 |

本地同时用同一 head 的 debug QA 二进制在隔离 Xvfb/DBus 会话验证 TC-NP-101/102 与 `TC-FILE-OPEN-002`。与本次改动无关的既有 flake（如 DB-GRID 指针稳定性、Markdown 导出质量用例）在各轮单独出现且与本分支无因果关系，未混入 Notepad 结论；未执行平台/项目保持“未验证”。

### 4.4 Linux 真机（Xvfb 隔离会话）

native 用例在独立 X11 会话（Xvfb `:n`）、独立 D-Bus（`dbus-run-session`）与独立数据/配置/缓存目录下运行，不接触 `:0` 桌面。

### 4.5 既有回归用例的适配（TASK-NP-24 要求）

TextEditor → NotepadEditor 迁移后，既有崩溃回归用例 `TC-FILE-OPEN-001/006/008` 暴露了两处真实回归，已修复并复核：

1. **共享保存按钮契约**：旧 `viewer-save` 在文档干净或只读时禁用；新工具栏最初按原型“全部按钮可点”实现，导致三个用例失败。现保存按钮仅对“脏且可写且不在保存中”的文档启用，其余 21 个原型按钮保持可点。
2. **丢弃未保存内容后仍可恢复**：关闭标签选择“丢弃”后，Notepad 磁盘备份仍残留，重新打开文件会恢复被丢弃的内容而不是磁盘内容。`documentStore.discard` 现在会清理该文档的 Notepad 备份，`release` 对干净文档同样清理。

3. **草稿恢复被旧快照覆盖**：迁移后的打开流程优先采用 Notepad 磁盘备份，而渲染器刷新时最新的缓冲区在旧 `taomni.viewer.drafts.v1` 草稿里，导致 `TC-FILE-OPEN-002`（macOS 原生）恢复出更旧的“Will reload instead”。现在有遗留草稿时优先使用草稿，仅在无草稿时才回退磁盘快照（大文件/迁移文档的崩溃恢复路径），保存成功后同时清理该文档快照。
4. **纯 Delete 键被命令拦截**：Edit 菜单把 Delete 显示为“删除”命令的快捷键，工作台 keydown 分发在 CodeMirror 之前命中了这条裸键映射，按 Delete 会删掉整行而不是删除光标后的字符。现在裸 Delete 键放行给编辑器，菜单项仍走命令注册表，且“删除”命令在没有选区时为空操作。浏览器实测：`abc def` 光标在 `abc` 后按 Delete → `abcdef`；全选后菜单 Edit → Delete 清空缓冲区。

5. **CodeMirror 基础按键与外部同步竞态**：Notepad 的 CM 扩展最初没有挂 `defaultKeymap`，Enter/Backspace/方向键依赖浏览器 contenteditable 默认行为；在 WebKitGTK 快速 WebDriver 输入下 Enter 会重复插入换行（`L1\nL2\nL3\n` 变成 3 个额外尾随换行），`TC-FILE-OPEN-002` 在第一个字节断言即失败。现已与旧编辑器一致地绑定 `defaultKeymap`/`historyKeymap`/`indentWithTab`；同时 `content` 外部同步改为下一帧比对、属性尚未回传时不再用旧内容重建文档，避免快速输入时重排/重复。
6. **保存按钮契约**：旧 `viewer-save` 在文档干净或只读时禁用；新工具栏最初按原型“全部按钮可点”实现，导致 `TC-FILE-OPEN-001/006/008` 失败。现保存按钮仅对“脏且可写且不在保存中”的文档启用，其余 21 个原型按钮保持可点。

本机复核：`TC-FILE-OPEN-001`、`TC-FILE-OPEN-006` 与 `TC-NP-001..005` 一起执行 → 7 passed / 0 failed。`TC-FILE-OPEN-008` 本机因未配置 SSH fixture 跳过（托管 runner 提供 fixture）。

全量 `pnpm test` 另有一个与本次改动无关的既有不稳定用例（`CodeWorkspaceTab.test.tsx` 在满负载并行时偶发 observation 断言失败，单独执行 261 项全部通过），未计入 Notepad 结论。

## 5. 未完成 / 下一步

1. TASK-NP-24：browser/native 三端用例跑通并回填证据；Windows/macOS 未执行项保留“未验证”。
2. 真机项 V-43～V-45、V-51（打印、提权、回收站、远程副本、大文件 5/12/35 MB、遗留草稿迁移）仍待执行。
3. 正则方言差异清单（DEC/§10）与“标记是否随会话保存”评审结论待补。
4. 原型“示意”部分（多光标、矩形选择、虚拟空格、系统打印、提权对话框）需真机逐项确认。
