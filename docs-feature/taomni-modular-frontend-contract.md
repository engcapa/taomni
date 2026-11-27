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

文件查看模块可以在清单中声明 `document: {fileKinds, extensions}`。两项都使用无重复的小写 ASCII 名称列表，扩展名省略点号。发布器逐平台比对声明，并将同一份声明写入签名商店目录。核心可在安装前找到支持的文件类型。模块需声明前端入口，具体格式的解析器、UI 和资源归各自的模块包。文档模块使用已有的 `media` 分类值，旧核心仍能读取完整商店目录。新清单的文档声明需要支持此扩展的核心，现有模块沿用 `coreApiVersion: "1"`。

查看器仅向已启用且持有 `fs.readUserFile` 的渲染器传入当前文件的读取操作。核心按当前清单版本与实际扩展名重新检查权限，并拒绝读取应用的配置、数据和缓存目录。关闭文件或停用模块会释放已打开的媒体流。发布器通过 `documentPermissions` 传递文档权限，使旧核心可以继续读取目录中的其他模块。核心逐包验证文档声明和权限。

TaOffice PDF 与 TaOffice Media 声明了独立版本和四个包平台，两者均为纯前端模块。PDF.js、worker、字体和解码资产随 PDF 包签名。媒体模块使用平台 WebView 解码。模块自身不写入用户文件或持有业务数据，清单中的备份路径和旧表迁移列表均为空。

核心在求值 ESM 前安装只读的 `globalThis.__taomniHost`。模块不能打包第二份 React；共享 hooks 必须使用该对象里的 React 实例。

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
