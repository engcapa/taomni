# Mobile Web Host 设置

## 背景与范围

通过保留外部 Host 的 HTTPS 反向代理访问 Mobile Web 时，默认监听地址白名单会返回 `403 {"error":"host_denied"}`。此前只能手工修改当前 profile 的 `mobile-listener.json`，再重启移动服务。

本次将设置放入 Settings → Network → Mobile remote（设置 → 网络 → 移动服务），提供额外域名白名单和显式的“允许所有域名（不限制 Host）”。不改变监听地址、端口、LAN 开关、配对二维码 endpoint、应用网络代理或防火墙，不启动或重启用户现有正式实例。

## 行为与安全边界

- 默认 `allow_all_hosts=false`；缺少配置文件时保持原默认策略。原有只含 `allowed_hosts` 的 JSON 继续可用。
- 当前监听端口的 loopback 地址始终允许；LAN 模式继续额外允许启动时枚举的本机网卡地址。
- 额外白名单逐行填写实际 authority：`pc.example.com`、`pc.example.com:8443` 或 `[::1]:8787`。不填协议、路径、凭据、查询参数或通配符。域名大小写归一化，去除首尾空白和重复项；最多 32 项，每项最多 255 字节，显式端口限定为 u16。
- 只匹配实际 Host（域名及显式端口），不自动放行子域名、不从二维码 endpoint 隐式添加、不信任 `X-Forwarded-Host` 或其他转发头。`https://...proxy-8787.../` 的域名中含 8787 不代表 authority 要加 `:8787`。
- 允许所有域名时只取消 Host 白名单限制，仍要求正常的非空 Host。界面始终显示此模式会取消 Host 校验和 DNS 重绑定防护，仅建议可信反向代理使用。
- **不绕过配对、Bearer、Origin、设备吊销或 WebSocket 单次票据**，不增加允许跨域凭据的 CORS 行为。无有效令牌仍 401；不被原规则允许的 Origin 仍 403；WS 票据仍不可重放。
- 允许所有域名时保留额外白名单；切回限制模式无需重新填写。
- 设置读取失败时禁止用默认值覆盖，提供重试；保存失败保留草稿并报告错误，不改变当前有效策略或原配置。

## 持久化与生命周期

沿用当前实例的数据目录文件 `mobile-listener.json`：

```json
{
  "allowed_hosts": ["pc.example.com", "pc.example.com:8443"],
  "allow_all_hosts": false
}
```

新增 IPC：

- `mobile_listener_get() -> ListenerConfig`
- `mobile_listener_save({ config: ListenerConfig }) -> ListenerConfig`

`ListenerConfig` 是类型明确的 `{ allowed_hosts: string[], allow_all_hosts: boolean }`。保存先校验，用同目录临时文件、sync、原子替换发布，再更新运行中 listener 的共享策略。与启动/停止共用 runtime lifecycle 锁，避免并发启动时读取旧策略；写盘失败不更新内存。配置不会受 Settings 三秒状态轮询覆盖。

保存立即对当前应用进程之后的 HTTP 请求和 WebSocket upgrade 生效，既有 WS 流不因 Host 策略变更而断开；原有设备吊销和停止服务的流清理不变。关闭 Settings 不停止服务，重新打开读取当前配置；停止/重新启动服务或应用后从同一文件恢复。headless 同样读取此配置。若多个桌面进程共享同一 profile，各自已运行的 listener 不跨进程热同步；其他进程或手工修改配置文件后，需要重启对应 listener 才重新读取。

责任边界：`listener_policy.rs` 负责配置、校验与 Host 匹配；`MobileRuntime` 持有共享运行策略并协调持久化；`settings.rs` 负责 IPC；`MobileHostSettings.tsx` 独立持有草稿/加载/保存/错误生命周期，主设置面板仅组合；浏览器 stub 仅模拟持久化 UI，不作为 native 网络证据。

## 验证清单

- Rust 配置测试：受限默认、旧格式、规范化、IPv6、精确端口、非法 authority/超量/未知字段、原子持久化、全域开关保留白名单。
- Rust 实际 HTTP/WS：用户报告域名的默认拒绝→显式放行、静态外壳与 API、一律拒绝不匹配的 host/port、忽略伪造转发头、允许所有→受限即时切换、重启恢复、失败不改变原策略、Bearer/Origin 和 WS 单次票据保持。
- Vitest：加载完成前禁用、保存契约、规范化回显、开关保留白名单、重挂载恢复、EN/ZH 风险提示与错误、失败保留草稿/重试、防重复保存、迟到加载、主设置组合和搜索。
- UI 自动化：域名设置浏览器/原生用例、原生 HTTP 生效边界、已有 Mobile Web 相关用例，以及完整 `crash-regression` browser/native；原生必须使用匹配当前源码的 QA release。

验证执行结果在实际运行后记录，不将浏览器 stub、旧二进制或构建成功等同于原生行为通过。

## 验证执行

- Node.js 22.23.4、pnpm 10.33.0；锁文件未修改。
- 聚焦前端测试：4 个文件 **18 passed**（Host 设置、主移动设置、设置搜索、浏览器 stub）。
- `pnpm build`（包含 TypeScript、`check:refactor`、Mobile Web 和桌面生产 bundle）通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过。
- Rust 移动模块真实测试：`cargo test --locked --offline --release --lib mobile:: -- --test-threads=2` **74 passed，0 failed，0 ignored**，包括 7 项新增配置与真实 HTTP/WS 测试；使用隔离的临时 profile，未运行本机 UI 套件。
- QA runner 单元契约：**31 passed**；新 YAML schema、所选三平台计划均通过，`gaps=[]`、`unreviewed=[]`。`qa_ui_auto.audit --gate` 通过，未放宽 coverage baseline。
- 独立只读评审发现并修正了端口校验、IPv6 bracket 后非法后缀，以及旧下划线主机名的兼容问题；相应断言保留。
- 按用户要求，browser/native 统一通过 `.github/workflows/qa-ui-auto-platforms.yml` 在 GitHub 执行，不以本机旧 QA 二进制代替。计划：`scope=selected`、`platforms=linux,windows,macos`、`modes=browser,native`、`native_release=true`、`tags=crash-regression`，额外选取 `TC-MOBILE-001/002/003/004/005/010/014/015`。共 **84 次**执行（Linux browser 13/native 17，Windows 与 macOS 各 browser 13/native 14），无不可达用例。
- GitHub 实际运行结果待触发后记录；计划成功不等于运行通过。正式安装实例及其配置保持不变。
