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

- `pnpm test --maxWorkers=2`：最新稳定批次737文件通过，6,663测试通过、1项跳过（`/tmp/explorer-post-ci-full-unit.log`）。此前735文件/6,647通过批次保留在`/tmp/explorer-full-unit-stable.log`。第一次在并发开发期间运行的全套出现3个尚在修改的模块失败；保留原始`/tmp/explorer-full-unit.log`，不以重跑覆盖旧失败。
- 最后的小型 tree/地址/滚动调整另外跑过对应 mounted 单测；7 文件72项的 Explorer 定向批次通过。预览/交互完整55项、后端18项、剪贴板21项存在重叠，不把批次数相加当作独立用例数。
- `LIBCLANG_PATH=/usr/lib/llvm-18/lib cargo test --manifest-path src-tauri/Cargo.toml --lib filebrowser::local_ops -- --nocapture`：18通过。
- 同环境 `cargo test --manifest-path src-tauri/Cargo.toml --lib file_clipboard -- --nocapture`：21通过。
- `pnpm exec tsc -b --pretty false`、`pnpm check:refactor`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`git diff --check`：通过。
- Windows x86_64 GNU / macOS ARM64 临时 source harness 对新增平台路径/回收站/文件剪贴板执行静态 `cargo check` 通过；不是完整应用构建或桌面运行证据。

### GitHub 执行追踪

完整轮次选择三端 `browser,native`、匹配 release QA 构建、TC-EXPLORER-001..005、TC-010/043，加 workflow 自动合并的完整 `crash-regression`；下表单列未进入执行的定向尝试。实际 selection 为每端15个 browser /14个 native，即87个模式-平台用例执行；不能将 GitHub 执行 job 为 success 当作 case 全通过，必须读取 runner summary 与最终汇总。

| Run / 提交 | 结果与后续 |
|---|---|
| [43362457801](https://github.com/engcapa/taomni/actions/runs/43362457801) / `6a5dca91` | catalog gate 在UI执行前失败：4个新增 selector orphan。补登记后本地 audit 通过，未改既有基线。无UI通过证据。 |
| [43362989083](https://github.com/engcapa/taomni/actions/runs/43362989083) / `61ab5dfe` | 三端构建通过；browser大目录与crash集合通过；Tools标签被隐藏、非标准选择器、焦点转移误取消拖动导致Explorer用例失败。修复见`f918a8ac`。原始汇总保留于`/tmp/taomni-explorer-previous-summary.pgldai`。 |
| [43365859206](https://github.com/engcapa/taomni/actions/runs/43365859206) / `f918a8ac` | 三端构建通过，browser文件操作003/大目录004通过；Linux/Windows crash集合通过。剩余失败包含：工作区重载被主Explorer抢焦点、Markdown断言非标准`:visible`、Windows原生等待剪切态的竞态、窄窗口原生预览未手动展开、终端输入目标错误、macOS面包屑目标在视口外。macOS crash失败也由本次Explorer恢复污染引起，不当作无关失败忽略。原始汇总`/tmp/taomni-explorer-run3-summary.h3fdvS`。 |
| [43372314485](https://github.com/engcapa/taomni/actions/runs/43372314485) / `d1309cab` | **完成，78通过/9失败，无跳过**：三端构建、完整crash-regression、受影响SFTP通过。三端browser002/003/004与native004通过。browser001异步标签计数；native003的Linux残留右键、macOS树目标被状态栏遮挡、Windows路径分隔符选择器；native005的Linux退出确认、Windows/macOS窄窗预览遮挡行中心失败。原始汇总`/tmp/taomni-explorer-round4-summary.z4pzrm`，细节保留`round4-browser.fKykoz`、`round4-native.d1dcCT`、`round4-windows.zG17Np`。恢复污染修复后Mac crash已全部通过。 |
| [43374078423](https://github.com/engcapa/taomni/actions/runs/43374078423) / `2671e416` | 定向browser001尝试在catalog门禁失败：新增异步等待选择器未登记。补aliases后本地audit通过；无UI执行证据。 |
| [43374770655](https://github.com/engcapa/taomni/actions/runs/43374770655) / `8c68c55a` | 定向browser001的`modes=browser`与自动完整crash集合内native-only用例不兼容，plan拒绝；无UI执行。后续仍使用`browser,native`，不删减crash集合。 |

本次相关失败均保留原始报告，不因后续修复而改写旧结果。尚不宣称最终 UI 验收或三端全部通过。

### 本轮失败定位与重跑准备

- Linux拖动原始DOM收据显示开始前`buttons=2`，按左键后变为`buttons=3`且没有`pointerdown`。定位到WebKitGTK W3C非左键释放丢失button的实现路径；测试输入改用已核对QA可执行文件、隔离profile和窗口标题的X11平衡右键点击，绝不让产品接受错误双键状态。其他系统及左键继续既有W3C输入；Wayland非左键路径明确未验证、不回落错误W3C。
- macOS树目标矩形中心虽在WebView内，却被状态栏/滚动裁剪遮挡。native drag现在滚动实际端点并复用稳定`elementFromPoint`命中检查，准备source后再次检查target未移动/遮挡；所有动作与实际DOM事件、完整字节oracle仍保留。
- Windows从原生列表进入子目录会得到反斜杠路径，fixture输入为正斜杠。用例选择器现匹配相同完整绝对路径的两种分隔符，不采用可能命中别处的basename退让。
- 窄窗手动预览覆盖行中心时，005点击仍可见的`.ex-name`子元素；不使用force/synthetic click。OS重启保留Explorer标签，并显式声明、核对和点击退出确认；不以关闭全部标签、reload或kill冒充恢复证明。
- 标签图标复用原型同一文件夹SVG，浅/深色分别使用`#f5b83d`/`#e8b04a`；全局chrome其余部分仍沿用产品。图标及保留SFTP图标的3文件28项单测通过，`tsc`及`check:refactor`通过。最终稳定合并`test_native_drag`、restart/shutdown、pointer/transport、X11/window-drag及case契约共256项通过（`/tmp/explorer-native-tool-unit-stable.log`）；此前与pointer签名修改交叠的失败日志保留在`/tmp/explorer-native-tool-unit-final.log`。catalog audit与三端87项selection plan通过，未更改coverage baseline。下一轮GitHub结果另行追加。
