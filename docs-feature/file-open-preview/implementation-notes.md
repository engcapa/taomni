# Open File Service 实施与验证记录

## 当前状态（2026-11-14）

- 分支：`feat/file-open-improve`，开发基线 `719109a3`。
- 实现进行中；此记录不等同于 UI / 原生验收通过。
- 用户指定：本地仅单元测试与静态检查，所有 browser/native 通过 GitHub `qa-ui-auto-platforms.yml`。不在本地启动桌面或浏览器作产品验证。
- 原型依据：`prototype-v1.html`，采用 DEC-02 A / DEC-03 A / DEC-04 A。不实现原型顶栏的评审控制器、模拟粘贴按钮或固定样本页面。

## 实施边界

| 领域 | 当前实现 / 保持约束 |
|---|---|
| 入口 / 标签 | `src/lib/openFile` 唯一入口；规范化路径按 Explorer 契约处理，主界面 `file-viewer` / 工作区 `viewer` 按作用域去重。 |
| 文档 | `documentStore` 持有共享文本、编码/BOM/换行、脏标记、保存基线/冲突、草稿；异步代次守卫防关闭后同路径重开串入旧结果。 |
| Code Workspace | 保留 IDE 源码编辑器。已由 IDE 打开的文本激活其唯一编辑 owner；共享查看器有脏草稿时不另开独立 IDE 草稿。干净查看器切 IDE 时关闭查看器；不把 IDE 状态复制进第二套草稿。 |
| 文件读写 | `viewer_*` Rust 命令；复用 Workspace 编码与原子写；SHA-256 前置条件和写前再次核验，不静默覆盖；只读临时副本禁止写回。 |
| 大文件 | 默认 5 MiB 文本编辑 / 256 KiB 只读块；显式确认后至 20 MiB。图片查看器暂设保守 32 MiB，Explorer 保持 20 MiB。均为保守安全上限，**不是实测性能结论**。 |
| 图片 / SVG | 共享 `imageSafety` 净化；缩放/平移/旋转/翻转仅视图；SVG 渲染/代码/分栏编辑；同目录导航、缩略条及属性。 |
| Markdown | CM6 标准源码 + 非活动块装饰；活动块显源码；大纲/格式/表格/图片/mermaid；粘贴图片落盘后才插相对链接；表格转换可一次 Undo 恢复纯文本。 |
| 导出 | HTML 内嵌本地图片；PNG `html-to-image`、DOCX `docx` 按需加载；Markdown+图片夹用新目录；PDF/打印由系统打印，UI 不谎称 PDF 已落盘。复制富文本不能静默降级成功。导出不得选择源路径或其规范化别名。 |
| HTML | 不含 `allow-same-origin` 的 iframe；native token 根目录 GET 协议，目录穿越/符号链接拒绝；默认离线。允许外部资源必须经受限后端代理通道，页面直接 HTTP(S) 被 CSP 禁止；代理模式应用/独立/无代理，不隐式回落。 |
| 远程 | 邮件附件 / SFTP 下载为受控临时只读副本；最终宿主关闭和正常进程退出清理。SFTP 已有队列继续拥有重试/暂停/取消的安全部分文件；不增加远程写回。 |
| 设置 | 按扩展名处理器、双击默认、Markdown 图片目录/命名、表格转换、换行/字号、HTML 脚本与网络/代理。中英文文案。 |
| 生命周期 | 主界面与工作区脏关闭提示、退出门禁、草稿恢复、冲突 diff；全局关闭提示 portal 到 document.body，不能被隐藏 Sessions 宿主遮掉。 |

### 安全 / 原型差异说明

1. 远程 SVG/HTML 不因“在 Workspace 编辑”丢掉只读属性；必须先另存本地。
2. browser stub 为 VFS + blob 模拟，只证明前端。其本地多页面导航有明确限制，不据此宣称 native 协议行为；外部网络即使开关允许也不走浏览器直连。
3. HTML 资源通道只支持预览所需受控 GET；不扩成任意网页浏览器、WebSocket、worker、下载任务。代理失败必须显示，不回落直连。
4. 已有导出 stream API 会打开时截断目标；本功能禁止覆盖源码及别名，新 Markdown 图片目录独占创建。非源码已有导出目标的原子覆盖仍受现有 stream 契约限制。
5. 共享 Markdown 渲染沿用 `renderFormatted` / marked / DOMPurify；不引入另一份 Markdown 序列化格式。图片缩放暂为视图状态，不写私有 Markdown 语法。
6. `docx` 通过 browser-only JS 适配器和窄 `.d.ts` 懒加载，防止依赖声明引入 Node 全局类型污染 DOM 类型项目；不是用 `any` 隐藏全项目错误。

## 依赖

- `html-to-image`（MIT）仅 PNG 导出时导入。
- `docx`（MIT）仅 DOCX 导出时导入；实际 ZIP 产物由单元检查。
- Rust 直接声明已有 Tauri parser `tauri-utils` 的 HTML manipulation feature，结构化插入 nonce bridge，避免正则拼接整份 HTML。
- 未加入 pdf.js：PDF 内置查看仍为 P1，交系统应用。
- 生产 bundle 分块与体积需以 hosted build 为准；未在本地跑 UI 或打包来证明性能。

## 验证选择与当前结果

| 检查 | 当前结果 / 证据 |
|---|---|
| Node / pnpm | 聚焦批次最终使用 Node 22.23.5 / pnpm 10.30.0，与 CI 主版本一致；初始环境 Node24 已切换。 |
| 核心+保留前端单元 | `pnpm exec vitest run --maxWorkers=4 src/components/viewer src/components/explorer src/lib/openFile src/lib/markdownAssets.test.ts src/stores/documentStore.test.ts src/stores/documentStore.lifecycle.test.ts src/components/settings/FileOpenSettings.test.tsx src/lib/fileOpenTemp.test.ts src/lib/filePathLinks.test.ts src/components/filebrowser/FileToolbarWiring.test.tsx src/layouts/MainLayout.test.tsx`：首个稳定批次 **33 files / 340 tests passed**；最终扩展集合加入 Explorer 恢复、Workspace/AI/terminal/stub 保留验证，**44 files / 425 tests passed**；首轮失败修复后的扩展集合（含 HTML data URI 资源、CRLF paste、设置 clear→type、文本行列状态）**45 files / 436 tests passed**；HTML 外链 consent 新增测试的被动 effect 就绪问题已用单次发送前显式 await act 修复，生产 bridge 改为 layout effect 防初始页面消息丢失。 |
| 类型 / 边界 | `pnpm exec tsc -b --pretty false`、`pnpm check:refactor` 已通过一轮；native 命令契约 821，新增文件均不超过 800 行。最终网络通道变更后复验通过；source size 4600 文件。 |
| Rust | 初轮 `cargo test --manifest-path src-tauri/Cargo.toml --lib viewer:: -- --nocapture`：**24 passed / 0 failed**；跨平台 `openat` 修复后新增私有文件/目录权限验证，**25 passed / 0 failed**；`workspace::tests` 保留过滤集：**90 passed / 0 failed**（含 query_workspace 名称匹配项）。编码/BOM/EOL、temp防写、路径越界、代理绕过环境/不回落、取消/大小上限与原子写前置条件通过；macOS 编译仍需 hosted 再验。 |
| QA 静态 | 扩充至 TC-FILE-OPEN-001..012，另选择受影响 TC-EXPLORER-001..005 与完整 crash suite；policy/dependencies/smoke/mandatory expectations/feature-list/control catalog 同步。各模式、行为 contract、OS helper 单元通过后才能提交；不放宽 baseline。 |
| GitHub browser/native | 初轮 `43451418842`：三端 browser 各 **11 pass / 3 fail**，Windows native **9 pass / 5 fail**。扩充轮 `43526262110`（`d1c1f7e0`）：三端 browser 各 **17 pass / 4 fail / 0 skip**，合计 **51/63 pass**；005 与保留 Explorer 001..004 三端实际通过。Linux native 被完整前端单元 7 项失败阻断；macOS native 被本次新增 `openat` 参数跨平台编译错误阻断；Windows native 构建尚未终止。**整体未通过**，修复后须用匹配源码重跑；不以报告上传 job 成功替代 case pass。 |

### 专项用例

- **001** browser：Explorer 预览/双击、共享去重、保存字节、脏关闭、快捷键。
- **002** native：真实文件保存、外部改动冲突/diff/keep/reload、草稿恢复、二进制重试、大文件分块。
- **003** browser/native：恶意 SVG 净化、三模式、编辑保存和源字节不被净化覆盖。
- **004** browser：Markdown 实时/源码/分栏、大纲/表格/图片操作、真实剪贴板粘贴、实际下载内容/各导出入口状态。
- **005** browser/native：HTML 本地 CSS/图片/脚本实际 bridge 结果、父页面隔离、默认网络阻止、设备尺寸/缩放/源码分栏/console/网络策略。
- **006** browser/native：工作区入口、设置持久化/恢复默认、独立代理设置、邮件只读临时副本去重/关闭清理。
- **007** native：真实 OS 图片剪贴板与粘贴、系统保存/目录选择器、HTML/PNG/DOCX/Markdown 图片夹独立产物检查；真实 Mermaid 实时/分栏 SVG、浅深主题截图、导出图形保留；取消/缺图失败不改源码。
- **008** browser/native：AI 实际文件芯片、Git 预览作用域、SSH 文件路径拒绝误读本地、SFTP 真实下载只读副本与清理。
- **009** native：独立 HTTP/proxy 日志证明应用/独立/无代理路线、失败不直连、token 关闭取消、相对资源、目录穿越/符号链接/IPC 拒绝。
- **010** browser/native：页面脚本伪造 bridge 消息也必须父页面确认，取消/Escape 不打开系统浏览器，脚本关闭后无 author 执行。
- **011** native：真实本地 PTY 输出路径，实际 modifier-click 打开/去重，关闭查看器后终端仍可执行。
- **012** browser/native：真实 PNG/JPEG/WebP/GIF、缩放/平移/旋转/翻转/背景/缩略导航、复制像素与路径、损坏与大小边界，源字节不变。

以上新增 007..012 的 unit/schema/static 通过不构成真实 UI/OS 结果；必须以接下来 hosted receipts 与产物为准。

### 保留的 IDE crash-regression 路由

TC-WS-038/039/051/052/053/054/055/056/057 与 TC-IDE-C8-08 的目标是原有 IDE 编辑器/面板/终端/布局生命周期，而非新查看器默认值。它们在已有首次 reload 前显式持久化 `.md`/`.txt` → `workspace` 关联，仍通过真实项目树操作进入 Code Workspace；原有 pane/content/dirty/PTY/精确磁盘断言不变，不替换为 Viewer、不 skip。新增一个 setup 步骤（C8 没有原 reload，因此显式 seed+reload 两步）后按旧→新索引映射同步全部 verification 引用；专项 TC-FILE-OPEN-001..006 单独保护 Taomni 默认打开。该调整只是保留验收上下文，尚未形成新的 browser/native 执行证据。

### 不可误报的边界

- 自动化 AppKit 激活或 WKWebView 按键不证明物理键盘/IME/全局菜单条。
- `reload_window` 证明 renderer 恢复，不等同于 OS 杀进程后重启。
- hosted macOS ARM64 不证明 Intel 或全部支持版本；图片 AVIF/WebView 打印差异必须按实际记录。
- SFTP/终端/AI/Git 各入口代码迁移及单元，不等同于每个完整 native UI 流程已验。
- PNG/DOCX/PDF/打印/Markdown图片夹、原生剪贴板、系统文件选择器的完整链路仍需各自原生执行证据；只有菜单可见不能视为产物通过。

## GitHub 执行与修复循环

保留失败 run，不覆盖旧证据；与本次改动无关的失败仅在明确定位后单列，不改用例期望制造通过。

| run | 源码 | 结果 / 后续 |
|---|---|---|
| [43449130590](https://github.com/engcapa/taomni/actions/runs/43449130590) | `f7d82646` | checkout 把短 SHA 当分支名，未执行构建/产品用例；改用完整 SHA 重新 dispatch。 |
| [43449514622](https://github.com/engcapa/taomni/actions/runs/43449514622) | `f7d826460a5d7bd7b1383faadc64ff293bac473f` | planning 单元 `test_crash_regressions` 硬编码旧 tag/smoke 清单，新六例未同步；补齐 EXPECTED、单模式集合与 smoke，并跑契约单元。未执行产品用例，不能视为三端通过。 |
| [43451418842](https://github.com/engcapa/taomni/actions/runs/43451418842) | `3bc9afa00c353e9eaf6db71b8ee6093cf1be7eda` | 三端 browser 各 11/14 pass；Windows native 9/14 pass。Linux 在 `cargo fmt` 中发现 `workspace.rs` module 排序错误，已修；macOS job annotation：`The job was not acquired by Runner of type hosted even after multiple attempts`，未执行。产品/用例失败见下述修复，待重跑。 |
| [43526262110](https://github.com/engcapa/taomni/actions/runs/43526262110) | `d1c1f7e02b4aee848167481ea26c9953e3dfff8f` | 扩充 001..012 + Explorer + 全部 crash：browser 63 次实际执行 **51 pass / 12 fail / 0 skip**，每 OS 17/21 pass。004/008/010/012 三端各同根因失败；005 三端 CSS/图片/隔离/默认离线实证通过，Explorer 001..004 三端 12/12 通过。Linux 完整前端单元 **6881 pass / 7 fail / 1 skip** 阻断 native；macOS `viewer/paths.rs:298` C varargs 不接受 `u16 mode_t`，不是 runner 容量问题。Windows native 尚在构建；当前不得声称原生验收通过。 |

### 首轮实际失败与对应修复

- **004 Windows Markdown paste**：真实剪贴板 CRLF 字符串与 CM 标准 LF 坐标不一致，导致 `RangeError: Selection points outside document`；先标准化剪贴板换行再计算 selection/替换范围，并补 mounted Undo/Redo 回归。
- **004 Linux redo**：检查实际输入事件与标准快捷键；保留“Undo 一次变回 TSV、Redo 还原表格”的原始目标，修复自动化按键大小写/平台映射，不删除断言。
- **004 macOS browser export**：异步复制仍 busy 时立即断言 copied；增加真实完成状态等待，不能只看点击完成。
- **005 三端 browser HTML**：opaque-origin sandbox 无权读取父 origin 的 blob CSS/图片，截图确实无样式/图片 broken；仅 browser VFS 资源改为受限 data URI，JS nonce-inline，不开放 same-origin 或直连网络。native 协议独立验证不受替换。
- **002 Windows native**：文件行布局尚在变化时双击命中 next.html 而非 notes.txt；等待命名行并断言目标类型，保留真实双击链路。
- **003/005 Windows native**：1024 宽原生窗口按设计折叠预览，测试却假设必然挂载；新增幂等真实工具栏 `show_explorer_preview`（不可见才点击一次），同时覆盖窄屏 overlay，而不是改产品为测试强制展开。
- **006 Windows native**：受控设置输入在 clear 中间态把默认 assets/font 还原，后续输入变成 assetsimages；产品改为合法中间草稿，只有有效值持久化，补 clear→type/恢复默认单元；不靠全局修改测试 driver 制造通过。
- **C8 / WS051**：旧 IDE 生命周期用例未显式配置源码编辑归属，新默认路由切入查看器；为两个遗漏用例补与其它 IDE crash cases 相同的显式处理器设置，所有旧步骤/断言逆映射 hash 不变。
- **高保真差异**：hosted HTML desktop 截图有不符原型的 24px 外边距与矩形地址栏，改为 desktop full-bleed、设备模式仅 14px 纵向留白、地址栏 pill 15px；正文/大纲/图表浅深主题的最终判断必须新 hosted 截图复核。

### 扩充轮实际失败与修复（43526262110）

- **004 三端 Mermaid**：真实页面内错误是 `dayjs/dayjs.min.js ... does not provide an export named 'default'`，尚未进入 Mermaid render，而不是图形标签断言过严。Vite `optimizeDeps.noDiscovery=true` 的显式清单缺少 Mermaid 及其 CommonJS 转换入口；修复预打包清单并补配置契约单元，仍须 hosted 真 SVG / 标签 / 导出验证。不能用 mock Mermaid 单元冒充渲染成功。
- **004 实时渲染间距**：失败截图与 DOM 证实非活动 Markdown 块之间残留三个 `.cm-line` 空白行，每段额外约 80px，明显不符原型紧凑正文。装饰只合并非活动块的 separator 换行并以渲染块 margin 控制间距，保留当前空白行、EOF 光标和原始 Markdown 字节；补 compact DOM、空白行输入、选区及源码不变单元。新 hosted 浅深主题截图仍需复核。
- **010 三端 scripts-off**：前半段伪造消息与真实外链确认/取消已通过，step 44 的第二个页面失败。trace 中真实生成的 HTML 含 nonce-only CSP，但可信 bridge `<script>` 无 nonce；`DOMParser` 的 detached document 上 `.nonce=` 在 hosted Chromium 序列化时未反射为属性。仅 browser stub 改为显式 `setAttribute`，补模拟非反射属性的序列化测试；不放宽 CSP、页面脚本、外链确认或防骚扰策略。
- **012 三端 wheel helper**：实际 `StepContext` 没有 `report_root`，辅助器在发输入前抛 `AttributeError`；改按当前 `case_dir` 核对独立图像 oracle 必须为其直接子文件且非 symlink，补真实 StepContext 单元。此失败没有证明产品缩放、粘贴板或后续限额已经通过。
- **008 三端 AI → 文件查看器**：step 14 已断言真实文件全文，tab-bound chat 随切到非 chat-capable viewer 自动隐藏；step 15 多余点击隐藏 Hide 按钮。改同一步断言 drawer 不可见，后续 Git/SFTP/PTY 和原有 checkpoint 不删不改步数；后半段本轮尚未执行。
- **Linux native 门禁**：完整单元暴露新增 file-viewer 后 recovery policy 的旧数量（21→22），以及五项 IDE tree 场景、一个邮件附件 mock 契约。六项先聚焦复现失败后修：IDE 焦点/选择/分栏测试的目标 fixture 明确为真实 `.ts` 源码（普通 `.txt`/`.md` 故意已路由到全局查看器），保留原焦点、Undo、selection 与 split 断言，不 mock classify；邮件测试适配真实 controlled temp + `openFile` 边界，并加强 IMAP section、目标路径和只读来源断言。完整 CodeWorkspaceTab **261/261** + MailClientTab **77/77** 单元通过；recovery 四项通过，其余全前端单元正在验证，不跳过门禁。
- **macOS native 编译**：`libc::mode_t` 在 Darwin 为 `u16`，传给可变参数 `openat` 必须先做 C integer promotion。使用 `mode as libc::c_uint`，保留 no-follow、exclusive-create、私有文件/目录权限，增加原生权限回归；Linux 单元不等同于 macOS 编译与运行通过。

该轮 browser 六个 summary 的 `identity_stable=true`，`source_sha256=59c78bdc592cd40f18a37e589b7feb301a35ed696ee72089c34fd241428b4583`；实际 receipt `exitCode=1`，未以报告上传 job 的绿色结论冒充 case pass。保留的九项 browser crash 每 OS 均通过（C8、MOBILE012、WS038/039/045/052/053/055/057，共 27 次），新增失败仍阻断整体通过。所有修复必须随下一匹配 candidate 再验。

本批工具/静态复验：`tsc -b`、`pnpm check:refactor`、全局 `cargo fmt --check` 与 QA `audit --gate` 通过，coverage baseline 未变；`pnpm test:tools` **81 pass / 0 fail / 8 skip**（平台/外部工具限制明确跳过，不将 89 项全称为通过）。QA fixtures/helpers/mandatory crash + CI selection 单元合并批次 **62/62 pass**（另一个聚焦 fixtures/helpers/mandatory 子集 **39/39 pass**，不重复累加为独立覆盖）。下一轮 selection 仍为六组、18 shards、三个匹配 release 构建，browser 每 OS 21 项、native 每 OS 23 项，共 132 次；`gaps=[]` 仅为静态计划，不是执行结果。

完整前端单元以两个互不重复批次执行：IDE+Mail 两文件 **338 pass**；其余 766 文件 **6552 pass / 1 fail / 1 skip**。唯一失败为未改动的 `ScreenshotFavorites.test.tsx:48` 在 DOM empty 刚出现时立即检查 passive cleanup 的 `revoke`，本地同文件独立重跑 **4/4 pass**；生产与测试最后改动均不在本功能 diff（历史 `85bae679`）。该次批量失败保留，不改无关截图功能、不称完整批次全绿；hosted Linux gate 继续原样运行完整前端单元。

`43526262110` 的独立 native-contracts job **110 pass / 0 fail**（2026-11-13 23:48 UTC）。本批仅改 viewer Unix openat 参数，RDP/mobile/截图 Rust 源码、Cargo manifests/lock、工具链及 contract workflow 无变更；下一次同 release 配置按 CI runbook 用 `run_rdp_unit_contracts=false` 复用该成功契约证据，仍执行所有选定 native case，未省略 Linux 完整前端单元或匹配 QA binary 构建。
