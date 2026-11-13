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

快捷键验收范围：Explorer非编辑区的Copy/Cut/Paste/Select-all使用Windows/Linux Ctrl与macOS Command；地址Ctrl/Command+L，预览Alt/Option+P，工作区入口Alt/Option+3。文本输入、IME和对话框优先；terminal Control信号不改。上下文菜单显示⌘编辑命令，工作区入口显示Option+3。预览/导航/属性部分提示仍使用跨平台`Alt`文字，macOS Option功能映射已测但文字一致性为剩余显示缺口；物理键盘、Fn键、AppKit系统菜单加速器/重复分发与IME候选窗仍未进行OS级验证，不从WKWebView合成按键推断通过。

## 当前证据

### 本地单元与静态检查

- `pnpm test --maxWorkers=2`：最终提交`f86468ac`稳定批次739文件通过，6,672测试通过、1项跳过（`/tmp/explorer-final-stable-full-unit.log`）；前一稳定polish批次6,667通过保留在`/tmp/explorer-stable-polish-full-unit.log`。此前737文件/6,663通过保留在`/tmp/explorer-post-ci-full-unit.log`，735文件/6,647通过保留在`/tmp/explorer-full-unit-stable.log`。第一次在并发开发期间运行的全套出现3个尚在修改的模块失败；保留原始`/tmp/explorer-full-unit.log`，不以重跑覆盖旧失败。
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
| [43396714161](https://github.com/engcapa/taomni/actions/runs/43396714161) / `2181bd69` | **完成，84通过/3失败，无跳过**：三个平台browser均15/15、native均13/14；Explorer001–004、完整crash-regression、SFTP全通过。仅005仍失败：Linux重复原地pointer move等待超时、macOS底部预览窄窗误全高遮挡、Windows终端OSC7路径`/D:/...`未归一化导致重复无效Explorer。汇总`/tmp/taomni-explorer-round5-summary.jST8Gm`；实际DOM/字节收据保留round5-auto目录。6份browser receipt及全部artifact hash已核对（`/tmp/explorer-round5-browser-receipt-check-stable.log`）；Linux/macOS003原生receipt/build-source与artifact也已核对。 |
| [43405262473](https://github.com/engcapa/taomni/actions/runs/43405262473) / `f86468ac` | **完成，87/87通过，0失败/0跳过，workflow success**：三端均browser15/15、native14/14；完整Explorer、crash-regression与受影响SFTP通过，三端release构建/native契约/SFTP契约通过。新增folder图标、短文本高度、窄窗bottom几何断言通过，截图已复核。最终`passed=true`、`report_ok=true`，failures/gaps/infrastructure_errors均为空；原始汇总`/tmp/taomni-explorer-final-summary.PlEt3X/ci-summary.json`。18份原始runner receipt、source/build与全部artifact hash已核对，不复用旧source证据。 |

本次相关失败均保留原始报告，不因后续修复而改写旧结果。最终所选三端自动化验证闭环已通过；不将此扩大成所有物理OS交互、逐像素全应用保真、跨物理卷/磁盘满注入或性能基线均已验证。

### 本轮失败定位与重跑准备

- Linux拖动原始DOM收据显示开始前`buttons=2`，按左键后变为`buttons=3`且没有`pointerdown`。定位到WebKitGTK W3C非左键释放丢失button的实现路径；测试输入改用已核对QA可执行文件、隔离profile和窗口标题的X11平衡右键点击，绝不让产品接受错误双键状态。其他系统及左键继续既有W3C输入；Wayland非左键路径明确未验证、不回落错误W3C。
- macOS树目标矩形中心虽在WebView内，却被状态栏/滚动裁剪遮挡。native drag现在滚动实际端点并复用稳定`elementFromPoint`命中检查，准备source后再次检查target未移动/遮挡；所有动作与实际DOM事件、完整字节oracle仍保留。
- Windows从原生列表进入子目录会得到反斜杠路径，fixture输入为正斜杠。用例选择器现匹配相同完整绝对路径的两种分隔符，不采用可能命中别处的basename退让。
- 窄窗手动预览覆盖行中心时，005点击仍可见的`.ex-name`子元素；不使用force/synthetic click。OS重启保留Explorer标签，并显式声明、核对和点击退出确认；不以关闭全部标签、reload或kill冒充恢复证明。
- 标签图标复用原型同一文件夹SVG，浅/深色分别使用`#f5b83d`/`#e8b04a`；全局chrome其余部分仍沿用产品。图标及保留SFTP图标的3文件28项单测通过，`tsc`及`check:refactor`通过。最终稳定合并`test_native_drag`、restart/shutdown、pointer/transport、X11/window-drag及case契约共256项通过（`/tmp/explorer-native-tool-unit-stable.log`）；此前与pointer签名修改交叠的失败日志保留在`/tmp/explorer-native-tool-unit-final.log`。catalog audit与三端87项selection plan通过，未更改coverage baseline。
- 后续截图复核：工作区仍显示`EXPL`badge而非原型文件夹，现改为与主标签共享的ExplorerTabIcon；短文本预览原先固定300px导致操作区在窄窗落到滚动区下方，现按实际虚拟内容高度收缩，上限300px，长文本仍虚拟化。对应5文件21项单测通过（`/tmp/explorer-final-polish-unit.log`）；新增完整路径图标与短文本高度断言。完整suite在源码更新交叠时载入旧PreviewContent而运行新测试，产生2个失败（`/tmp/explorer-final-full-unit.log`）；已在稳定源码上重新完整运行739文件/6,667通过、1跳过（`/tmp/explorer-stable-polish-full-unit.log`）。
- run43396714161的Linux和macOS原生003已完整通过，真实列表/树/修饰键面包屑拖放含全树字节oracle。Linux005走过第一次终端右键，但第二次指针已在相同位置，`xdotool mousemove --sync`等待不存在的MotionNotify超时；改为一次真实move后读取实际root坐标核对，不等待坐标必须变化。49项pointer单测及最终合并258项工具/契约单测通过（`/tmp/explorer-native-tools-noop-stable.log`），保留原失败。Linux/macOS003的实际`pointerdown buttons=1`、目标`pointerup buttons=0`、Ctrl/Option复制状态及17次完整树oracle已检查；receipt/build-source/artifact hash也已核对。
- 同轮macOS005走到外部修改刷新后，截图证明底部偏好在窄窗误沿用全高覆盖层，遮住文件列表；这是本次产品布局问题而非无关失败。覆盖层现按`data-position`分支，bottom固定190px贴底且跨列表宽度，right保持原300px宽侧层；添加002窄窗bottom几何断言、截图与mounted回归。2文件24项单测、类型与边界检查通过。
- 同轮Windows005的截图/DOM显示终端报告`/D:/...`，初次计数读取了异步打开前一帧，随后错误地新开无法读取的目录。Explorer本地终端入口现复用已有`normalizeLocalStartCwd`，只在本地终端边界转换PowerShell/MSYS报告；SSH与通用地址输入不受影响。新增drive/MSYS/UNC/无法映射的WSL路径单测；005在返回Explorer与force-new后等待真实激活/第二标签再保留精确计数。5文件52项相关单测通过。

### 最终提交的已核对原生证据

最终执行源码提交：`f86468ac06d27c2ab2428f8b3164d179f5d9f960`。生产source SHA：`1d68b22fd320f9f98aeeed033d37306ace2cdb60e2badfab36d10989ad1d2312`；runner SHA：`5410a3e1fef30dff7f5a25171148a083887afebf89c4382041bce1a4e9fb48fe`。后续文档回填不改变这两个指纹。

可重复的GitHub选择（完整crash-regression由workflow自动并入，`publish_issues=false`不创建外部issue）：

```bash
HTTPS_PROXY=http://10.1.0.80:3228 HTTP_PROXY=http://10.1.0.80:3228 \
  gh workflow run qa-ui-auto-platforms.yml --ref feat/file-explorer \
  -f scope=selected -f platforms=linux,windows,macos -f modes=browser,native \
  -f linux_profiles=ubuntu-24.04-xvfb -f native_release=true \
  -f case_ids=TC-EXPLORER-001,TC-EXPLORER-002,TC-EXPLORER-003,TC-EXPLORER-004,TC-EXPLORER-005,TC-010,TC-043 \
  -f publish_issues=false
```

GitHub run43405262473 artifact key：`5e6642dbb64e479abc4bbbc759c960d0`；最终汇总为`qa-summary-<key>`，每平台原始报告为`qa-<platform>-<mode>-shard-<N>-<key>`。本地临时路径仅用于本次查证，长期定位以run链接、artifact名、提交及内容SHA为准。

- macOS ARM64：run43405262473的4份native summary共14/14通过。receipt、summary/artifact SHA、QA bundle ID及source=`1d68b22fd320f9f98aeeed033d37306ace2cdb60e2badfab36d10989ad1d2312`一致；binary=`1cfaec392e9a8302149dec04bd50e32d3e1aad126d2c7a10b0cac404f22c95e8`。原始目录`/tmp/taomni-explorer-round5-auto-{4jsuqyy3,ii4c6ui4,aua6v7ov,stblma0d}`（脚本历史命名前缀，不代表旧run）。
- macOS005：独立NSURL/file-url剪贴板观察与Finder System Events真实Edit/Paste Item创建目标副本，hash匹配；PTY输出、外部修改刷新、Blob图片解码、新标签与当前目录恢复通过。退出前精确匹配一标签Exit提示并单次真实session.click，点击后连接关闭使release回复丢失，未重试；旧进程正常exit0、PID 3288→4120，冷启动后偏好与路径断言通过。原始`native-application-restarts.jsonl`及截图已审阅。
- Linux Ubuntu24.04/Xvfb/Openbox：4份native summary共14/14通过，receipt/build/source及全部artifact SHA匹配；binary=`2500ff598ba786e3a13b6a1e3c2b7809940f3ceeec2337252ffae2fd5f1ea374`。原始`/tmp/taomni-explorer-final-linux.CoxTAA`及`/tmp/taomni-explorer-round5-auto-sumgag_9`。005独立系统文件剪贴板与PCManFM-Qt真实X11 Ctrl+V目标副本hash匹配；确认Exit后旧应用/存储PID 8951/8975/9003/9006结束，WebDriver session由`fe0f4921…`变为`40fd4dce…`，冷启动恢复与force-new通过。003全部17次全树SHA/空目录oracle及真实Trash/Undo通过；004真实10,000文件通过。
- Windows x64/WebView2：4份native summary共14/14通过，含003/004/005、完整native crash及受影响SFTP。原始`/tmp/taomni-explorer-round5-auto-{ivqnqjny,rfvnlt_b,dqn76ckk,lea98os3}`。receipt/build/source与artifact SHA一致；binary=`1c3c3108c69831b1202a0e1d7842c5a38196a08eb9b2a128f914d8dd894368f1`。005使用Windows Shell FolderItem `InvokeVerb(paste)`创建真实副本并核对hash，非browser/VFS；精确Exit确认后旧窗口关闭、旧driver端口释放，新session由`cdeaa632…`变为`4f930545…`，恢复与force-new通过。Windows收据未像Linux一样列举WebView存储PID/exit code；证据边界是正常窗口关闭、新owned driver/session及持久化断言，不额外宣称每个子进程均有独立正常退出收据。
