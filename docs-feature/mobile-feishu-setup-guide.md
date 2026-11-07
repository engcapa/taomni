# Mobile Web 飞书配置指南

设置 → 搜索 `feishu` / `飞书` →「配置指南」展开应用内分步指导。指南默认收起，支持鼠标、Enter、Space 和中英文即时切换；与表单状态独立，开启、收起和切换语言均保留未保存的凭据、绑定、地址与代理选择。移动服务未启动或飞书已连接时也能阅读。指南区域限制高度并独立滚动，方便对照下方字段。

## 配置路径与依据

1. 创建企业自建应用，在「凭证与基础信息 → 应用凭证」复制 App ID 与 App Secret。
2. 启用机器人，申请应用身份的 `im:message:send_as_bot`、`im:message.p2p_msg:readonly`。
3. 发布应用，配置用户可用范围并完成管理员审批。
4. 在同一应用的 API 调试台中选择发送消息，`receive_id_type=open_id`，使用「快速复制 open_id」取得用户 ID。
5. 在调试台取得本应用的 `tenant_access_token`，按指南示例向该用户发送测试消息，从成功响应的 `data.chat_id` 取得私聊 ID，组成 `ou_… oc_…` 绑定。响应中的 `data.sender.id` 是机器人身份，不能用作用户绑定。
6. 按需填写手机可达的 Mobile Web 地址，选择代理，保存并初始化/解锁凭据库，开启移动服务和飞书连接。
7. 保持连接，在飞书事件配置和回调配置中分别选择长连接，订阅 `im.message.receive_v1`、`card.action.trigger`，再次发布。
8. 使用授权私聊验证 help、list 与卡片按钮，并按指南排查发布、身份、权限、事件和网络问题。

此顺序避免两处配置死锁：绑定 ID 的获取不依赖尚未启动的 Taomni；飞书后台保存长连接订阅方式要求已有在线连接。指南不填充真实凭据，不发起飞书鉴权请求，不自动发送测试消息；API 调试台操作由用户执行。官方链接复用现有外部 URL 打开通道，并显示打开失败反馈。

2026-11-07 核对的飞书官方资料：

- [获取用户 ID](https://open.feishu.cn/document/home/user-identity-introduction/open-id)：发送消息接口的快速复制 open_id 操作。
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)：应用身份权限、可用范围、请求体与响应 `data.chat_id`。
- [使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)：先启动客户端再保存订阅方式；同应用多连接按集群分发。
- [卡片回调订阅方式](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address)：卡片回调的长连接配置。

检索原文保留在忽略目录 `qa-ui-auto-report/_local/feishu-guide/reference/`。

## 验证范围

| 验收行为 | 检查 | 依据与边界 |
| --- | --- | --- |
| 有序配置路径、合法消息示例、外部链接分发与失败反馈 | `FeishuSetupGuide.test.tsx` | 组件测试；外部 URL 打开通道 mock |
| 开关、切换语言保留所有表单草稿；连接中可阅读 | `FeishuAdapterSettings.test.tsx` | 真实设置组件，IPC mock；不调用保存或启动 |
| Settings 入口、八步指南、键盘操作、中英文切换、草稿保留 | `TC-MOBILE-016` browser/native | browser 验证 renderer；native 验证内嵌 WebView，用户明确要求两种模式 |
| 配置持久化、首次按需凭据库初始化、密钥清空、独立代理 | `TC-MOBILE-004` browser/native | 保留原用例，native 使用真实隔离配置/vault IPC |
| 相关移动服务与设置行为 | MobileServiceSettings、MobileHostSettings、settingsSearch 单测 | 保留现有入口和配置行为 |
| 应用崩溃回归 | 完整 `crash-regression` 集合 browser/native | 由指定 platforms workflow 自动并入，native 使用匹配源码的 QA release binary |

GitHub 使用 `.github/workflows/qa-ui-auto-platforms.yml`，`scope=selected`、`platforms=linux,windows,macos`、`modes=browser,native`、`native_release=true`，选择 `TC-MOBILE-004,TC-MOBILE-016`。执行结果、原始 artifact 和精确提交身份在完成后补充。

本地 Node 22.23.4 / pnpm 10.34.9：上述 5 个组件/设置单测文件 26/26 通过，`pnpm build`（含 TypeScript、`check:refactor` 与 mobile bundle）通过，`qa_ui_auto.audit --gate` 通过。本地 QA browser 首轮因缺少 Playwright Chromium 在 setup 阶段失败，未执行用例；原始日志与 receipt 保留在 `qa-ui-auto-report/_local/feishu-guide/browser/`，GitHub 的实际执行结果另行记录。

真实飞书租户的管理员授权、机器人收发消息和系统浏览器实际打开不作为自动化通过声明；需使用用户自己的应用配置验证。
