# 语音模型下载代理

语音模型设置提供三种下载模式，默认“使用应用级代理”：

- 使用应用级代理：每次开始下载时读取 Settings 的应用代理；未启用时直连。支持应用代理的手动配置和代理会话。
- 单独配置代理：复用 Settings 的 `AppProxyPanel`，支持 HTTP CONNECT、SOCKS5、代理会话、用户名及 Vault 密码引用。配置保存在 `ai.json` 的 `asr.download_proxy`，不修改全局 `proxy.json`。点击“保存下载代理”后生效；未保存修改时禁用下载。
- No proxy：强制直连，忽略 OS/HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 自动代理。切换模式保留此前独立配置，便于再次使用。

“单独配置”中的 Test 测试到 `huggingface.co:443` 的代理连接；Settings 原有 Test 仍使用原目标。连接测试不等于完整权重下载成功，上游重定向的 CDN 也需可达。密码先通过 Store 存入保险库，再保存下载代理；配置文件只保存 Vault 引用。应用代理的配置、测试仍在 Settings 原入口完成。

下载开始时固定当前路由，后续修改只影响下一次下载。下载/更新复用同一客户端；HTTP/HTTPS 重定向继续使用已选代理；SOCKS 使用代理侧 DNS。启用但不完整的配置、代理解析失败或连接失败返回错误，不静默切换成直连。离线导入和本地完整性检查不连接网络、不依赖代理。

## 验证范围

- 设置组件：默认应用模式、独立配置保存/重开、No proxy、保存失败保留草稿并禁止下载、独立测试使用 Hugging Face、原 Settings 保存/测试回归。
- 原生 Rust 本地网络测试：代理选路、未配置拒绝、HTTP 转发及跨域重定向、HTTPS CONNECT、SOCKS5 远程域名解析、独立子进程带代理环境变量时强制直连。使用短响应，不下载大型权重。
- 浏览器：`TC-VOICE-003` 验证三种模式和共享编辑器；保留 `TC-VOICE-001/002` 语音设置/升级回归。浏览器 fixture 不证明真实网络代理或麦克风。
- 真机补验：Windows 11 分别以应用代理、独立代理和 No proxy 下载 Base；测试代理需要身份验证、Vault 锁定、断连重试，以及 Hugging Face CDN 可达性。跨平台系统代理/企业代理环境仍需实际机器验证。

## 本轮记录（Linux，2026-10-07）

- Node 22 下 TypeScript 与 Vite 生产构建通过。
- 前端定向验证 20 个不同测试通过：首轮 2 个新断言使用了错误的 IPC 参数名，修正为既有 `proxyHost/proxyPort/testHost` 后，受影响的设置测试文件 5 个测试复跑全部通过；其余 15 个沿用同批结果。
- 浏览器 3 个用例全部通过、无跳过，报告 `qa-ui-auto-report/browser/run-20261007-203521-991671058/`。已检查独立代理编辑器截图，弹窗内字段可见，较长内容在弹窗中滚动。
- 最终 Rust 定向测试 9 个全部通过，包含 HTTP 重定向、HTTPS CONNECT、SOCKS5 远程 DNS 和带代理环境变量的直连子进程测试。
- QA 静态审计、3 个用例的 CI 计划、本次 Rust 文件格式检查及 `git diff --check` 均通过。
- 原始日志保存在忽略目录 `qa-ui-auto-report/voice-download-proxy/`，保留首轮断言和 YAML schema 失败及修复后的结果。
- 本地协议测试不代替 Win11 或远端 Hugging Face 的完整下载测试。
