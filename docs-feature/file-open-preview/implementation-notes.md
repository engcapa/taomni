# Open File Service 实施与验证记录

## 当前状态（2026-11-13）

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
| 核心+保留前端单元 | `pnpm exec vitest run --maxWorkers=4 src/components/viewer src/components/explorer src/lib/openFile src/lib/markdownAssets.test.ts src/stores/documentStore.test.ts src/stores/documentStore.lifecycle.test.ts src/components/settings/FileOpenSettings.test.tsx src/lib/fileOpenTemp.test.ts src/lib/filePathLinks.test.ts src/components/filebrowser/FileToolbarWiring.test.tsx src/layouts/MainLayout.test.tsx`：首个稳定批次 **33 files / 340 tests passed**；最终扩展集合加入 Explorer 恢复、Workspace/AI/terminal/stub 保留验证，**44 files / 425 tests passed**；HTML 外链 consent 新增测试的被动 effect 就绪问题已用单次发送前显式 await act 修复，生产 bridge 改为 layout effect 防初始页面消息丢失。 |
| 类型 / 边界 | `pnpm exec tsc -b --pretty false`、`pnpm check:refactor` 已通过一轮；native 命令契约 821，新增文件均不超过 800 行。最终网络通道变更后复验通过；source size 4600 文件。 |
| Rust | 最终 `cargo test --manifest-path src-tauri/Cargo.toml --lib viewer:: -- --nocapture`：**24 passed / 0 failed**；`workspace::tests` 保留过滤集：**90 passed / 0 failed**（含 query_workspace 名称匹配项）；编码/BOM/EOL、temp防写、路径越界、代理绕过环境/不回落、取消/大小上限与原子写前置条件通过。 |
| QA 静态 | 新增 TC-FILE-OPEN-001..006 / policy / dependencies / feature-list / control catalog；schema+audit gate 已通过一轮，无 baseline 放宽；代理新增控件后须刷新。 |
| GitHub browser/native | **尚未执行**；使用三端 `linux,windows,macos`、`browser,native`、`native_release=true`、六组用例 + 完整 `crash-regression`。待写入 run URL / commit / receipts。 |

### 专项用例

- **001** browser：Explorer 预览/双击、共享去重、保存字节、脏关闭、快捷键。
- **002** native：真实文件保存、外部改动冲突/diff/keep/reload、草稿恢复、二进制重试、大文件分块。
- **003** browser/native：恶意 SVG 净化、三模式、编辑保存和源字节不被净化覆盖。
- **004** browser：Markdown 实时/源码/分栏、大纲/表格/图片操作、真实剪贴板粘贴、实际下载内容/各导出入口状态。
- **005** browser/native：HTML 本地 CSS/图片/脚本实际 bridge 结果、父页面隔离、默认网络阻止、设备尺寸/缩放/源码分栏/console/网络策略。
- **006** browser/native：工作区入口、设置持久化/恢复默认、独立代理设置、邮件只读临时副本去重/关闭清理。

### 保留的 IDE crash-regression 路由

TC-WS-038/039/052/053/054/055/056/057 的目标是原有 IDE 编辑器/面板/终端/布局生命周期，而非新查看器默认值。它们在已有首次 reload 前显式持久化 `.md`/`.txt` → `workspace` 关联，仍通过真实项目树操作进入 Code Workspace；原有 pane/content/dirty/PTY/精确磁盘断言不变，不替换为 Viewer、不 skip。新增一个 setup 步骤后按旧→新索引映射同步全部 verification 引用；专项 TC-FILE-OPEN-001..006 单独保护 Taomni 默认打开。该调整只是保留验收上下文，尚未形成新的 browser/native 执行证据。

### 不可误报的边界

- 自动化 AppKit 激活或 WKWebView 按键不证明物理键盘/IME/全局菜单条。
- `reload_window` 证明 renderer 恢复，不等同于 OS 杀进程后重启。
- hosted macOS ARM64 不证明 Intel 或全部支持版本；图片 AVIF/WebView 打印差异必须按实际记录。
- SFTP/终端/AI/Git 各入口代码迁移及单元，不等同于每个完整 native UI 流程已验。
- PNG/DOCX/PDF/打印/Markdown图片夹、原生剪贴板、系统文件选择器的完整链路仍需各自原生执行证据；只有菜单可见不能视为产物通过。

## GitHub 执行与修复循环

待填写。保留失败 run，不覆盖旧证据；与本次改动无关的失败仅在明确定位后单列，不改用例期望制造通过。
