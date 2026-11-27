# 官方模块前端接入契约

本页细化模块化设计的 TASK-007。当前实现接入主窗口与模块分离窗口，验证入口为 `TC-MODULES-016/017/018`。这不是 MFA 或其它实际业务已迁出核心的声明；生产 facade 切换、旧数据迁移、全部 G 门仍按实施台账推进。

## 包与入口

- 在 `module.json` 的 `entry.frontend` 声明 `frontend/` 内的相对 ESM 路径；原生宿主入口可以独立声明，至少声明一项。
- `tabs` 声明 `{kind,title}`；kind 在所属 slug 内唯一，打开时同时保存 slug/kind。原有内置 TabKind 不与模块声明混用。
- 默认导出 React 组件，或使用命名导出 `component`。普通函数、class、`memo` 和 `forwardRef` 均可；组件内部的懒加载由模块自己的 Suspense 管理。
- 入口及相对导入文件全部进入官方包和签名 inventory。不能只签入口、额外从远端加载可执行 chunk。
- 原生只从已启用、当前版本且通过完整性校验的受限协议读取文件。打包主窗/分离窗使用自身 `tauri://localhost/__taomni_plugins__/<slug>/<version>/frontend/...`（WebView2 为 http(s) 映射），由每个 app WebView 的 Tauri resource hook 交给同一 registry/路径/hash 验证器；其它核心资源的 body、CSP 和 headers 不改。该同源路径避免 WKWebView 跨两个自定义 scheme 导入 ESM 的真实失败，保持官方前端与核心同权的既有边界。外部 dev server 继续使用 `taomni-plugin` 协议，不回退到 Vite SPA 路径。版本目录不可覆盖，升级换版本；重试/重新激活的 fragment 只改变 ESM identity，不改变验签路径。两条路径均不允许任意文件、query、非前端文件或目录穿越；CORS 不增加 `null`、通配 origin 或 credentials。
- `hello-plugin/frontend/index.js` 与 `messages.js` 是可执行的最小示例。开发预览对 Hello 与 VNC 使用各自的源码入口，原生安装与验签由 GitHub runner 验证。
- VNC Client 也声明签名前端入口。它从保存的会话或快速连接取得 typed 会话参数，商店通过 `tabs: []` 隐藏无连接参数的打开动作。核心保留代理、凭据、系统剪贴板、截图与分离交接服务。TC-MODULES-053 核对主窗和分离窗的生产模块路径及绘制，TC-MODULES-054 覆盖 browser 预览的源码入口与启禁。 [VNC 模块构建](../src-tauri/plugins/vnc-client/README.md)

## 共享依赖与组件输入

按钮、分区标签与模态框的共享实现位于 `src-tauri/crates/taomni-plugin-api/frontend/ui/`。模块直接打包这些无平台依赖的组件，向组件传入翻译后的名称，React 与 Portal 使用宿主现有导出。独立前端构建检查组件边界，签名工作流核对所用的组件和样式来源。

文件查看模块可以在清单中声明 `document: {fileKinds, extensions}`。两项都使用无重复的小写 ASCII 名称列表，扩展名省略点号。发布器逐平台比对声明，并将同一份声明写入签名商店目录。核心可在安装前找到支持的文件类型。模块需声明前端入口，具体格式的解析器、UI 和资源归各自的模块包。文档模块使用已有的 `media` 分类值，旧核心仍能读取完整商店目录。新清单的文档声明需要支持此扩展的核心，现有模块沿用 `coreApiVersion: "1"`。

查看器仅向已启用且持有 `fs.readUserFile` 的渲染器传入当前文件的读取操作。核心按当前清单版本与实际扩展名重新检查权限，并拒绝读取应用的配置、数据和缓存目录。关闭文件或停用模块会释放已打开的媒体流。发布器通过 `documentPermissions` 传递文档权限，使旧核心可以继续读取目录中的其他模块。核心逐包验证文档声明和权限。

TaOffice Project 可通过原生模块导入 `.mpp`。核心为 Project 的 `.mpp` 源文件生成 `.xml` 另存建议名，并限制副本扩展名为 `.xml`。原生命令在用户选定目的地后重新验证源授权，沿用只读副本、应用目录保护和禁止覆盖的规则。TC-TAOFFICE-029 检查浏览器导出名与源字节，TC-TAOFFICE-030 验证签名宿主、原生另存和副本重开。

TaOffice PDF 与 TaOffice Media 声明了独立版本和四个包平台，两者均为纯前端模块。PDF.js、worker、字体和解码资产随 PDF 包签名。媒体模块使用平台 WebView 解码，在 Matroska 设备播放不可用时，通过同一个文档授权准备 MP4 或 WebM 兼容副本。Mediabunny 的发行版本、许可证和前端构建回执随模块交付。模块自身不写入用户文件或持有业务数据，清单中的备份路径和旧表迁移列表均为空。

核心归档查看器支持 ZIP/CBZ、7z、TAR，以及 gzip、bzip2、xz、Zstandard 压缩的 TAR 和单文件。原生命令按条目读取并校验展开范围，在目标目录下暂存结果，校验完成后以禁止覆盖的方式提交。单文件压缩打开一个条目，解压直接生成文件。TC-TAOFFICE-006/009/010/011 覆盖核心归档视图和实际文件字节，TC-TAOFFICE-009 同时进入纯核心崩溃回归。浏览器预览支持常规 USTAR、gzip TAR 和单文件 gzip，TC-TAOFFICE-012 验证 7z 的桌面打开提示。

PDF 工具栏使用应用按钮和字号。文档区域聚焦时，Windows/Linux 使用 Ctrl+F、Ctrl+=、Ctrl+-、Ctrl+0，macOS 使用 ⌘F、⌘=、⌘-、⌘0。查找输入接受 Enter 和 ↑/↓，在匹配页之间移动时保留输入焦点。Esc 回到原按钮或文档区域。按钮提示显示对应平台键位。TC-TAOFFICE-007 覆盖 UI-FND-13、UI-PAT-05/15 和 UI-ZOOM-02/03，TC-TAOFFICE-008 在原生 WebView 中验证查找、大纲跳转及缩放。媒体模块播放地址被 WebView 拒绝时，通过同一文档授权读取上限为 32 MiB 的本地 Blob，再尝试播放一次。

加密 PDF 在当前文档内显示密码输入。Enter 提交，Esc 结束当前解码任务，用户可在同一标签重开提示。密码交给当前 PDF.js 任务后清空。TC-TAOFFICE-007/008 使用实际 AES-128 PDF 覆盖 UI-INP-02/04/06/07、错误反馈、重新打开和原始文件摘要。

PDF 0.1.4 在表单面板显示普通 AcroForm 文本、复选框和单选列表。Esc 关闭面板并返回工具栏，Windows/Linux 的 Ctrl+S 与 macOS 的 ⌘S 调用共享保存动作。PDF.js 负责生成带填写结果的 PDF，核心负责原生另存选择、目标扩展名检查、受保护目录检查和禁止覆盖的发布。共享文档状态跟踪未保存字段，关闭标签时提供保存副本、放弃和取消。远程临时副本、PDF 权限限制和签名表单保持只读。TC-TAOFFICE-017/018 验证实际输出和原文件摘要。

核心归档查看器通过 Apache-2.0 的 `rars` 支持 RAR4/RAR5 单卷目录、只读预览及解压。固实成员按顺序解码，应用继续校验路径、条目数量和体积并在校验后发布。加密和分卷归档在原生查看器中显示原因。TC-TAOFFICE-013/014 分别覆盖原生字节验证及浏览器桌面打开提示。

PDF 0.1.5 将表单更改同步到当前页面的画布。重绘保持当前缩放、文字层和表单输入焦点。TC-TAOFFICE-017/018 在保存前验证画布中的复选标记。

文档副本复用应用的 Tauri 文件对话框。核心通过调用方窗口打开对话框，以原文档目录和建议文件名初始化面板，返回后再次检查模块版本、文件权限和目标目录。原生用例操作属于 Taomni 进程的 GTK、AppKit 或 Windows 保存面板。

核心在求值 ESM 前安装只读的 `globalThis.__taomniHost`。模块不能打包第二份 React；共享 hooks 必须使用该对象里的 React 实例。

TaOffice Excel 0.1.0 将 Calamine 放在独立宿主，通过分块 RPC 接收当前打开的 XLSX/XLSM。渲染器按工作表读取 32 行、12 列的窗口，显示缓存结果和原公式，支持键盘切换工作表和复制选区。每个工作表保留最近选中的单元格。工作簿数据随会话释放。清单的迁移和备份列表为空。TC-TAOFFICE-015 使用浏览器 RPC fixture，TC-TAOFFICE-016 使用签名包和真实工作簿验证原生解析、启用与停用。

TaOffice Excel 0.1.1 为已有的 XLSX 文字和数字单元格提供保存副本。Enter 和 F2 进入编辑，Enter 提交，Esc 取消，Tab 提交后移到邻格。工作表聚焦时，Windows/Linux 的 Ctrl+S 和 macOS 的 Cmd+S 提交有效输入并打开保存对话框。关闭对话框后保留未保存的更改。Excel 宿主修改对应的 XML 单元格和工作簿计算标记，并保留其他部件的内容。工作表显示缓存结果，打开副本后的重算遵循 Excel 的计算模式。含保护、合并、校验或数组公式的工作表提供预览。共享文档关闭守卫处理 PDF 和 Excel 的未保存内容。TC-TAOFFICE-019/020 分别覆盖键盘交互与原生保存重开。

渲染器可以通过可选的 `api.deferCleanup(command, payload)` 注册当前标签的资源释放操作。回调只派发一次，仍经过模块 IPC 的命令授权。关闭标签或发生渲染错误时，核心取消在途请求并执行释放回调。模块停用或版本变化后，原生宿主随注册表生命周期释放资源。

Excel 0.1.2 使用应用的主题边框区分单元格、选区和键盘焦点。滚动工作表时保留表头与行号。TC-TAOFFICE-019 验证实际渲染的网格边框和键盘编辑。

Excel 0.1.3 从工作表关系解析表格范围。列标题和汇总行与表格定义共享数据，查看器将它们标为只读并显示原因。Excel 宿主在保存副本前执行相同检查。表格内已有的普通文字和数值仍可编辑。TC-TAOFFICE-019/020 验证标题、键盘操作及保存后的表格和公式。

TaOffice Word 0.2.0 是独立打包的前端文档模块。离线页面预览显示 DOCX 的页眉、页脚、静态分页和表格。编辑模式支持含多个文本 run 的正文和表格单元格段落。另存副本按照原有文本 run 写入改动，保留段落与 run 的样式属性以及未修改部件的字节。含修订、字段或嵌入对象的段落保留为只读，受保护或签名的文件以预览方式打开。模块的备份和迁移声明为空。TC-TAOFFICE-021/022 验证混合格式、单元格、取消另存和副本重开。

TaOffice Project 0.2.0 根据 MSPDI 命名空间打开 XML 和 MPPX 项目。普通 XML 继续使用文本查看器。任务表显示日期、工期、进度、前置任务 UID 和甘特条。自动排程任务可改工期，计算使用 FS、SS、FF、SF 依赖、提前量和滞后量、工作日历及例外。界面标注关键路径。另存副本在原 XML 中更新排程字段并保留基线和资源分配。手动和已开始任务保留导入日期。模块的数据、迁移和备份声明为空。TC-TAOFFICE-023/024 验证筛选和改名，TC-TAOFFICE-027/028 验证重算与另存。

TaOffice Media 0.1.2 在已加载且聚焦的播放器中支持 Space 播放或暂停，使用左右方向键定位 5 秒。TC-TAOFFICE-025/026 使用由旧编码样本离线转换的 VP8/WebM，验证 WebView 实际解码、定位和离开标签暂停。

| SDK 字段 | 当前公开内容 |
|---|---|
| `coreApiVersion` | 与 manifest 协商的核心 API 版本 |
| `React`、`jsxRuntime` | 与核心相同的 React 与 JSX runtime |
| `ReactDOM` | `createPortal`、`flushSync` |
| `zustand` | `create`、`createStore`、`useStore` |
| `icons` | 显式公开的 Check、Loader2、Package、RefreshCw、X |
| `i18n` | `getLocale`、`t`、`useLocale`、`useT` |

组件的类型以 `src/lib/pluginFrontendHost.ts` 为准：

```ts
interface PluginFrontendProps {
  tabId: string;
  kind: string;
  active: boolean;
  api: {
    invoke<T>(command: string, payload?: unknown,
      options?: { signal?: AbortSignal }): Promise<T>;
    dispose(): void;
  };
}
```

`invoke` 自动绑定当前 slug 与独立 request ID，不允许通过 payload 改变 owner。原生仍执行 manifest、权限和宿主准入检查。SDK 不提供通用原始 IPC；官方前端仍与核心共享 WebView 信任边界，不宣称第三方代码沙箱。

## 状态、取消与清理

普通切换标签保留组件实例和未提交输入；`active=false` 时由模块暂停无需继续的动画或预览任务。关闭标签、启禁变更、卸载和版本切换会卸载组件、撤销 API 并取消所有未完成请求。旧请求即使晚到，也不能向新激活的视图发布结果。

模块必须清理自己创建的 effect、订阅、计时器与事件监听。异步操作需要处理错误和取消；不能靠渲染错误边界接管异步异常。核心边界只隔离组件 render 错误，发生错误后撤销该视图的 API，允许用户显式重试。

不要在模块顶层安装无法回收的监听器，也不要在加载或重新挂载时自动重放写操作。业务数据归宿主的受控存储；示例通过 `hello/read` 与 `hello/write` 演示读取与显式提交。

## 保存、分离和返回

主窗 `taomni.plugin-tabs.v1` 仅保存经过清理的 tab ID、标题、slug/kind 和活动 tab ID。没有 manifest、路径、权限、业务 payload 或凭据。恢复活动模块时经普通 focus action 同时恢复 Sessions 可见区域；若用户已切到 Home/Workspace/Agents，只保留 locator，不保存隐藏模块为活动页。恢复 locator 不代表授予执行权限：缺失/禁用的模块展示占位，仍须重新读取 native registry。

分离窗口使用相同的 locator 契约：先写可读 handoff，成功创建窗口后才移除源 tab；存储失败、弹窗被拦截或 native 创建失败均保留源 tab。新 WebView 独立注册 registry 监听并安装 SDK，不依赖主窗口的 JS 全局对象。

原生 close-request 与返回按钮共用幂等回挂。返回时立即卸载分离窗口的模块，即使窗口关闭失败也不保留可操作的第二个副本；用户可重试关闭。主窗校验 envelope ID 与 locator ID 一致，再按原 ID 去重。浏览器 reload 不触发返回；preview 依赖显式返回按钮，浏览器 OS 关闭自动回挂仍是待办。

截图 overlay 当前没有模块 view，不在本批中初始化模块 SDK。新增其它能够渲染模块的独立入口时，必须像模块分离窗一样接入 registry、共享 SDK 与清理，并补对应场景。

## 验证边界

| 场景 | 验证入口 | 能证明的边界 |
|---|---|---|
| 真实 ESM、相对资源、保存、隐藏/启禁、reload、分离/回挂、卸载保留 | TC-MODULES-016 | GitHub native 的匹配官方包、真实进程/存储、独立 WebView |
| 同类 renderer 与真实 browser popup 的状态同步 | TC-MODULES-017 | browser-only model；不能替代 native 安装/存储 |
| 已安装 ESM 篡改拒绝、错误隔离、恢复原字节后重试 | TC-MODULES-018 | GitHub native 的生产协议和完整性边界 |
| 生命周期、晚到结果、render 错误、取消、保存清理和关闭失败 | pluginFrontendStore、pluginFrontendHost、PluginTabPane、PluginDetachedWindow 等单元 | 进程内行为；不能替代 native 副作用 |

上述新增场景必须取得匹配源码的 runner 证据，并与受影响功能及完整 browser/native crash-regression 一起验收。验签成功不证明操作系统签名、Gatekeeper、TCC、性能预算或真实业务迁移，后者仍由 G 门和升级任务分别验证。
