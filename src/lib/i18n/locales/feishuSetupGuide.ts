export const feishuSetupGuideEn = {
  show: "Setup guide",
  hide: "Hide setup guide",
  title: "Connect a Feishu bot step by step",
  intro: "Use a Feishu enterprise custom app and a private chat for the first setup. Each Taomni instance needs its own app because Feishu distributes events across connections. You need app developer access and may need an administrator to approve publication and permissions.",
  create: {
    title: "Create the app and copy its credentials",
    body: "Open the Feishu Developer Console, create an enterprise custom app, then open Credentials & Basic Info → App Credentials. Copy App ID (cli_…) and App Secret into the corresponding fields below. App Secret is saved in Taomni's credential vault; leave it blank after saving to keep the stored secret.",
    link: "Open Developer Console",
  },
  permissions: {
    title: "Enable the bot and request permissions",
    body: "In App Features → Add Feature, enable Bot. In Permissions & Scopes, select application permissions (tenant_access_token) and add both permissions below. Apply for approval if required by your organization.",
    send: "Send messages as the app",
    receive: "Receive private messages sent to the bot",
    note: "Start with private chats. Group reception needs additional permissions and Taomni requires the /taomni prefix at the start of a group message; an @bot mention at the start is not supported.",
  },
  publish: {
    title: "Publish and authorize the app",
    body: "Open App Release → Version Management & Release → Create Version. Include yourself and each intended user in the availability scope, save and publish, then wait for administrator approval if required. Confirm the bot is visible to these users in Feishu. Permissions and availability must take effect before continuing; publish a new version when you change them.",
  },
  user: {
    title: "Get the user's open_id",
    body: "Open API Explorer and select the same app as the App ID below. Find Messaging → Message → Send Message. Under Query Parameters set receive_id_type to open_id, choose Quick Copy open_id, select the person who will control Taomni and copy the member ID (ou_…). An open_id belongs to a particular app: use this app's ID for this user.",
    link: "Open API Explorer",
  },
  chat: {
    title: "Get the private chat_id and fill Authorized identities",
    body: "In that same Send Message API, obtain a tenant_access_token for this app through the explorer's credentials panel. Keep receive_id_type=open_id. Replace receive_id in the example with the user's real ou_… value, keep msg_type=text and send the request. This sends a setup message to that user. After code=0, copy data.chat_id (oc_…) from the response. No Taomni connection or incoming event is needed for this step.",
    binding: "In Authorized identities below, enter the user's open_id, a space, then data.chat_id. Use one pair per line, up to 32 pairs; both IDs must match. Example format (replace both placeholders):",
    note: "Do not use data.sender.id from this response: the sender is the bot. A chat_id alone does not authorize a user. For a group, use that group's chat_id and each authorized user's open_id, and add the bot to the group. Notifications are visible to other group members.",
    link: "Send Message API documentation",
  },
  connect: {
    title: "Save in Taomni and start the connection",
    body: "The optional Mobile Web address is your phone-reachable instance URL, such as https://pc.example.com, not a Feishu callback URL. Leave it empty if you do not need links in notifications. For a reverse proxy, add its external domain under Mobile Web domains (Host), and pair the phone separately. Choose application proxy (default), independent proxy or no proxy according to how this computer reaches Feishu.",
    start: "Save Feishu settings and initialize or unlock the credential vault on this computer when prompted. Enable the mobile service above, then click Start Feishu connection and wait for Connected. Save does not start the connection. Stop the Feishu connection before editing saved settings.",
  },
  events: {
    title: "Configure event and card subscriptions while connected",
    body: "Keep Taomni connected. In the Developer Console → Events & Callbacks → Event Configuration, select Use persistent connection to receive events, save and add Receive Message (im.message.receive_v1). Under Callback Configuration, also choose the persistent connection mode and add Card Action Trigger (card.action.trigger). Save, then create and publish a new app version for the changes to take effect.",
    note: "If Feishu reports that no connection was detected, complete the previous step and wait for Connected before saving the subscription mode. No public inbound address, webhook, Verification Token or Encrypt Key is needed in these Taomni settings.",
    link: "Official persistent connection instructions",
  },
  verify: {
    title: "Verify commands and card buttons",
    body: "From the bound user's private chat with this bot, send /taomni help, then /taomni list. Check that a reply arrives, the Delivered counter increases and the list card's Show button works. Empty lists are valid when no sessions exist; Agent operations require an existing Agent thread. File content export is optional and defaults off; enable it only if you want private-chat file queries sent to Feishu.",
    troubleshooting: "No bot or permission denied: check publication, administrator approval and user availability. No reply: check im.message.receive_v1, the two permissions and both binding IDs from this app. Rejected counter increases: check the user/chat pair. Card buttons fail: check card.action.trigger. Connecting or reconnecting: check App ID, App Secret and the selected proxy. After permission or subscription changes, publish again.",
  },
};

export const feishuSetupGuideZh: typeof feishuSetupGuideEn = {
  show: "配置指南",
  hide: "收起配置指南",
  title: "一步一步连接飞书机器人",
  intro: "首次配置建议使用飞书企业自建应用和私聊。每个 Taomni 实例使用独立应用，避免飞书将事件分发到其他连接。你需要应用开发者权限；发布和权限申请可能需要企业管理员审批。",
  create: {
    title: "创建应用并复制凭据",
    body: "打开飞书开发者后台，创建企业自建应用，进入「凭证与基础信息 → 应用凭证」。将 App ID（cli_…）和 App Secret 分别复制到下方同名字段。App Secret 会保存在 Taomni 凭据库；保存后再次编辑时留空即可保留原密钥。",
    link: "打开飞书开发者后台",
  },
  permissions: {
    title: "启用机器人并申请权限",
    body: "在「添加应用能力」中启用「机器人」。进入「权限管理」，选择应用身份权限（tenant_access_token），添加以下两项权限；如果企业要求审批，提交权限申请。",
    send: "以应用的身份发消息",
    receive: "获取用户发给机器人的单聊消息",
    note: "建议先完成私聊配置。群聊接收需要额外权限，且 Taomni 要求群消息以 /taomni 开头；暂不支持以 @机器人 开头的指令。",
  },
  publish: {
    title: "发布应用并完成授权",
    body: "进入「应用发布 → 版本管理与发布 → 创建版本」，在「可用范围」中加入自己和所有需要操作 Taomni 的用户，保存并发布；按企业要求等待管理员审核通过。确认这些用户能在飞书中找到该机器人。权限与可用范围生效后再继续；后续修改时也需要发布新版本。",
  },
  user: {
    title: "获取用户 open_id",
    body: "打开 API 调试台，选择与下方 App ID 相同的应用，找到「消息 → 消息管理 → 发送消息」接口。在「查询参数」中将 receive_id_type 设为 open_id，点击「快速复制 open_id」，选择将要操作 Taomni 的用户并「复制成员 ID」，得到 ou_…。open_id 与应用相关，同一个人在不同应用中的值不同，务必使用本应用的值。",
    link: "打开 API 调试台",
  },
  chat: {
    title: "获取私聊 chat_id，填写授权身份绑定",
    body: "在同一个「发送消息」接口的鉴权凭证区域，为本应用获取 tenant_access_token。保持 receive_id_type=open_id，将示例中的 receive_id 替换成用户真实的 ou_…，保留 msg_type=text，然后开始调试。这会给该用户发送一条配置测试消息。返回 code=0 后，复制响应中的 data.chat_id（oc_…）。这一步不需要先启动 Taomni 连接或接收事件。",
    binding: "在下方「授权身份绑定」中填写：用户 open_id、一个空格、data.chat_id。每行一组，最多 32 组；用户和会话必须同时匹配。以下仅展示格式，请替换两个占位值：",
    note: "不要使用本次响应的 data.sender.id：发送者是机器人。只填写 chat_id 不能授权用户。群聊需使用该群的 chat_id 与每位授权用户的 open_id，并将机器人加入群聊；其他群成员也能看到通知。",
    link: "发送消息接口文档",
  },
  connect: {
    title: "在 Taomni 保存并启动连接",
    body: "「通知中的 Mobile Web 地址」是手机能访问的实例地址，例如 https://pc.example.com，不是飞书回调地址；不需要通知链接时可留空。使用反向代理时，在「Mobile Web 访问域名（Host）」中添加外部域名，并单独完成手机配对。根据本机访问飞书的网络情况，选择应用代理（默认）、独立代理或不使用代理。",
    start: "点击「保存飞书设置」，按提示在本机初始化或解锁凭据库。开启上方移动服务，再点击「启动飞书连接」，等待状态显示「已连接」。仅保存不会启动连接；修改已保存的配置前请先停止飞书连接。",
  },
  events: {
    title: "保持连接，配置事件与卡片订阅",
    body: "保持 Taomni 已连接。在飞书开发者后台进入「事件与回调 → 事件配置」，订阅方式选择「使用长连接接收事件」，保存并添加「接收消息」（im.message.receive_v1）。再到「回调配置」中同样选择长连接，添加「卡片回传交互」（card.action.trigger）。保存后创建新版本并发布，使配置生效。",
    note: "若提示「未检测到应用连接」，先完成上一步并等待「已连接」，再保存订阅方式。这里无需公网入站地址、Webhook、Verification Token 或 Encrypt Key。",
    link: "飞书官方长连接配置说明",
  },
  verify: {
    title: "验证指令与卡片按钮",
    body: "使用已绑定用户与该机器人的私聊，依次发送 /taomni help 和 /taomni list。确认收到回复、「已送达」计数增加，列表卡片的「查看」按钮可用。没有会话时列表为空属于正常情况；Agent 操作需要先在 Taomni 中创建 Agent 线程。文件内容导出默认关闭，仅在需要把私聊查询的文件内容发送到飞书时开启。",
    troubleshooting: "找不到机器人或权限不足：检查发布状态、管理员审批与用户可用范围。没有回复：检查 im.message.receive_v1、两项权限和本应用的两个绑定 ID。「拒绝」计数增加：检查用户与会话是否成对匹配。卡片按钮无效：检查 card.action.trigger。一直连接或重连：检查 App ID、App Secret 与所选代理。权限或订阅变更后记得重新发布。",
  },
};
