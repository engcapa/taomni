# File Explorer 实施与验证记录

依据：[`../file-explorer-design.md`](../file-explorer-design.md) 与高保真 [`prototype-v1.html`](prototype-v1.html)。

## 实施边界

- 当前分支 `feat/file-explorer` 直接修改；不改原型、不引入原型评审控制条。应用自身标题栏、全局侧栏和标签容器仍沿用产品组件，Explorer 内容区使用原型的浅/深色 token、210px 导航、300px 右预览、190px 底预览、28px 文件行、24px 状态栏与命令栏顺序。
- 文件列表仍经过 `LocalFileBrowserPanel` → `FilePanel`，后者保留排序、过滤、选择及 SFTP 默认视图。Explorer 使用明确的 `renderView` / `sortState` 扩展契约，而不是复制一套目录状态；虚拟列表仅存在于 Explorer 视图中。
- `sftpStore.sessions[tabId].local` 是唯一目录/选择权威。抽出 `sftp/navigation.ts` 的刷新、导航和历史请求所有权，以及 `localAttachment.ts` 本地挂载生命周期；请求序号和 StrictMode 清理使迟到响应不能覆盖更新目录或复活已关闭标签。
- 主界面与单个工作区各自去重；按当前已提交目录、原生规范路径比较。`forceNew` 显式新开。旧 File 会话保留 `sessionId` 并采用 Explorer 外观；SFTP 双栏继续原视图。
- 主界面新增独立的 Explorer 恢复开关（更多菜单；默认开），元数据存储 `taomni.explorer.tabs.v1` / `taomni.explorer.restoreTabs.v1`；工作区沿用工作区持久化。恢复只记录路径/标签，不保存剪贴板、撤销标识、预览内容或进行中的任务。
- 共享视图偏好 `taomni.explorer.view.v1`。预览默认开，窄容器自动折叠但保留开关，可手动覆盖展开。文本固定 256 KiB、CSV 前100行、图片固定20 MiB；Markdown/SVG 预览移除外部资源和主动内容，不扩大 asset scope。
- 原生复制/移动、重命名和创建使用 no-replace 语义；符号链接按链接本身复制，拒绝目录自身/子孙目标；跨卷剪切复制完成后才开始删除源。每项失败汇总，不回滚已完成项。取消保留已写入的部分目标并报告。
- 拖放使用产品已有指针 DnD（避免 Windows Tauri 拦截 HTML5 drag），同卷默认移动、异卷默认复制，Ctrl（macOS Option）强制复制。目标覆盖列表文件夹、导航树和面包屑。
- 回收站依赖 trash 5.3；Linux 单元测试直接使用隔离 XDG Trash 验证真实删除/还原，不以 browser stub 代替。macOS 使用 NSFileManager resulting URL 保存还原位置；Windows Explorer 专用 IFileOperation 避免不可回收卷静默永久删除。Shift+Delete 永久删除必须确认；回收站失败仅对失败项提供显式永久删除确认。
- Windows/Linux 剪切向系统文件剪贴板写入 move 提示。macOS Finder 没有同等 cut 格式，系统移动沿用 Finder 的 Option+Command+V；应用内 Command+X/V 正常移动。不能宣称在 Finder Command+V 会移除源。
- 工作区入口为已选方案 A，Project 树不切换实现。Alt+3（macOS Option+3）只在工作区有效且让出编辑框、IME、对话框；终端 Explorer 入口不分配新快捷键。本地非 SSH、非命令终端显示当前目录与新标签两项。

## 测试执行策略（本轮用户要求）

本地仅执行单元测试和静态检查，不运行 browser/native UI。UI、真实 IPC、系统剪贴板/文件管理器和打包 WebView 验证在 GitHub `qa-ui-auto-platforms.yml` 执行；所有外网命令通过用户提供代理。GitHub 选择包含完整 `crash-regression` 与受影响既有 SFTP 用例。

新增可执行用例：

| 用例 | 层级 | 行为 |
|---|---|---|
| TC-EXPLORER-001 | browser | Tools/菜单/工作区导航条/项目树入口、去重、新标签、地址/面包屑/导航历史/失败/恢复 |
| TC-EXPLORER-002 | browser | 预览类型、截断、过期响应、浅深色原型尺寸、共享偏好、窄窗、创建和回收站降级 |
| TC-EXPLORER-003 | browser/native | 选择、复制/剪切/冲突/重命名/属性、回收站/撤销/永久删除、拖放；独立全树字节与目录 oracle |
| TC-EXPLORER-004 | browser/native | 10,000项真实列表、虚拟DOM、排序、过滤；记录实测，不预造性能目标 |
| TC-EXPLORER-005 | native | 实际本地PTY cwd、系统文件剪贴板、真实系统文件管理器粘贴、外部修改、预览与标签恢复 |

Browser/VFS 不能证明原生文件语义；WebView reload 不等同整个 OS 进程冷重启。macOS bridge 按键不是物理键盘/AppKit 全局菜单证据。截图仅证明执行状态；尺寸与颜色有命名断言，完整像素/交互保真需结合截图审阅。

## 当前证据

### 本地单元与静态检查

- `pnpm test --maxWorkers=2`：735 文件通过，6,647 测试通过、1 项跳过（完整日志 `/tmp/explorer-full-unit-stable.log`）。第一次在并发开发期间运行的全套出现3个尚在修改的模块失败；保留该原始日志 `/tmp/explorer-full-unit.log`，稳定代码重新完整运行后通过，不以旧失败覆盖或伪装通过。
- 最后的小型 tree/地址/滚动调整另外跑过对应 mounted 单测；7 文件72项的 Explorer 定向批次通过。预览/交互完整55项、后端18项、剪贴板21项存在重叠，不把批次数相加当作独立用例数。
- `LIBCLANG_PATH=/usr/lib/llvm-18/lib cargo test --manifest-path src-tauri/Cargo.toml --lib filebrowser::local_ops -- --nocapture`：18通过。
- 同环境 `cargo test --manifest-path src-tauri/Cargo.toml --lib file_clipboard -- --nocapture`：21通过。
- `pnpm exec tsc -b --pretty false`、`pnpm check:refactor`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`git diff --check`：通过。
- Windows x86_64 GNU / macOS ARM64 临时 source harness 对新增平台路径/回收站/文件剪贴板执行静态 `cargo check` 通过；不是完整应用构建或桌面运行证据。

GitHub run/commit、逐平台结果和关联失败将在执行后回填。尚不宣称 UI 验收或三端通过。
