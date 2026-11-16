import { useSyncExternalStore } from "react";
import { getLocale, subscribeLocale } from "../../lib/i18n";

/** Tao uses the application's locale subscription. Strings are kept here so
 * switching language never replaces the chat controller or its drafts. */
const english: Record<string, string> = {
  "请根据所选资料回答我的问题：": "Please answer my question using the selected records:", "命令": "Commands", "笔记": "Notes",
  "thread": "Chat", "session": "Session", "workspace": "Workspace", "command": "Command", "sql": "SQL", "note": "Note",
  "问": "Ask", "做": "Act", "深研": "Research", "你": "You", "待处理": "Pending", "跳过": "Skipped",
  "代码 review": "Code review", "SQL 排查": "SQL investigation", "故障排查": "Troubleshooting", "文件整理": "File organization", "done": "Completed", "skipped": "Skipped",
  "解释、总结、回答开发问题": "Explain, summarize and answer development questions",
  "提出动作并等待你的确认": "Propose actions and wait for your approval",
  "生成计划并多轮研究": "Plan and research across multiple steps",
  "来源": "Sources", "文件": "Files", "生成物": "Artifacts", "工作流": "Workflows", "语音": "Voice", "导入导出": "Import / export",
  "记忆": "Memory", "技能": "Skills", "编辑内容": "Edit content", "导出": "Export", "编辑": "Edit", "删除": "Delete", "开始": "Start", "暂无可用工作流": "No workflows available", "暂无已确认的记忆、身份或技能": "No confirmed memories, identity or skills", "本轮没有来源。": "No sources for this turn.", "暂无生成物": "No artifacts", "保存 Markdown": "Save Markdown", "回复 {index}": "Reply {index}", "文件已上传：{bytes} 字节": "File uploaded: {bytes} bytes", "选择或拖入 PDF / 图片。上传在后台继续，关闭侧栏不会取消。": "Choose or drop a PDF/image. Uploads continue in the background.", "文件上传需要桌面应用。": "File upload requires the desktop app.", "选择文件": "Choose files", "上传在后台继续，关闭侧栏不会取消。": "Uploads continue in the background.", "导入会创建新 Tao 对话，保留已有记录。支持 DeepSeek ZIP v3。": "Import creates new Tao chats and keeps existing records. DeepSeek ZIP v3 is supported.", "导入 ZIP": "Import ZIP", "导出 ZIP": "Export ZIP", "正在处理…": "Processing…", "历史导入导出需要桌面应用。": "History import/export requires the desktop app.", "已导出": "Exported", "已导入 {count} 个新对话": "Imported {count} new chats", "识别音频文件": "Transcribe audio file", "停止朗读": "Stop reading", "正在识别…": "Transcribing…", "本地录音仅回填草稿，不会自动发送。": "Local dictation only fills the draft; it never sends automatically.", "DeepSeek 语音：选择 WAV / OGG，最长 60 秒。": "DeepSeek voice: choose WAV / OGG, up to 60 seconds.", "停止": "Stop", "取消": "Cancel", "记忆与技能": "Memory and skills", "每一步都需确认；关闭侧栏后仍可在后台恢复。": "Each step requires confirmation and survives closing the panel.", "运行中": "Running", "已完成": "Completed", "已取消": "Cancelled", "失败": "Failed",
  "移除引用": "Remove reference", "活动文件": "Active file", "分支": "Branch", "创建分支": "Create branch", "交给 Codex": "Send to Codex", "交给 Claude": "Send to Claude", "朗读": "Read aloud", "撤销": "Undo", "已撤销": "Undone", "已收到的内容已保留。请检查网络或代理设置后重试。": "Received content is retained. Check your network or proxy settings, then retry.", "无": "None", "保存到 Vault 后，Tao 才能在首页回答问题。": "Save a key to Vault before Tao can answer on Home.",
  "memory": "Memory", "soul": "Identity", "skill": "Skill", "connecting": "Connecting", "uploading": "Uploading", "completed": "Completed", "cancelled": "Cancelled", "failed": "Failed", "pending": "Pending", "running": "Running", "paused": "Paused",
  "新 Tao 对话": "New Tao chat", "Tao 模式": "Tao mode", "历史": "History", "关闭历史": "Close history",
  "Tao 对话": "Tao chats", "最近会话": "Recent sessions", "最近工作区": "Recent workspaces", "最近目录": "Recent directories",
  "搜索历史": "Search history", "会话排序": "Session order", "最近连接优先": "Most recently connected", "较早连接优先": "Least recently connected",
  "名称升序": "Name ascending", "名称降序": "Name descending", "类型升序": "Type ascending", "类型降序": "Type descending", "主机升序": "Host ascending", "主机降序": "Host descending",
  "对话": "Chat", "会话": "Session", "工作区": "Workspace", "终端": "Terminal", "数据库": "Database", "目录": "Directory",
  "旧 tao-chat": "Legacy tao-chat", "暂无记录": "No records", "＋ 新 Tao 对话": "+ New Tao chat", "↺ 恢复上次会话": "↺ Restore last session",
  "本地终端": "Local terminal", "选择本地终端": "Choose local terminal", "本地终端选项": "Local terminal options", "选择 Shell": "Choose shell",
  "以管理员身份启动": "Run as administrator", "打开 Home 目录": "Open home directory", "新会话": "New session", "新工作区": "New workspace",
  "更多": "More", "更多启动选项": "More launch options", "本地目录": "Local directories", "邮件会话": "Mail sessions", "数据库 / VNC / RDP 会话": "Database / VNC / RDP session",
  "Tao 设置": "Tao settings", "关闭启动提示": "Dismiss launch message", "已隐藏": "Hidden", "绑定{kind}": "Bind {kind}", "+ 绑定{kind}": "+ Bind {kind}",
  "{kind}（已关闭）": "{kind} (closed)", "绑定不会发送内容。选择后点击“引用到本次提问”预览并发送。": "Binding does not send content. Use Cite in this question to include a previewed excerpt.",
  "暂无可绑定的{kind}，请先打开对应资源。": "No {kind} available. Open a resource first.", "@ 引用到本次提问": "@ Cite in this question", "解除绑定": "Unbind",
  "绑定的资源已关闭，请重新选择。": "The bound resource is closed. Select it again.", "终端已经关闭，请重新绑定。": "The terminal is closed. Bind it again.",
  "数据库连接已经关闭，请重新绑定。": "The database connection is closed. Bind it again.", "请先在数据库中选择要引用的表或对象。": "Select the database tables or objects to cite first.",
  "工作区已经关闭，请重新绑定。": "The workspace is closed. Bind it again.", "当前资源没有可引用的内容。": "The resource has no content to cite.",
  "连接 DeepSeek · 全家桶": "Connect DeepSeek App", "Key 由 Vault 安全保存，Tao 不会记录到日志。": "Keys are protected by Vault and are never logged by Tao.",
  "去设置": "Open settings", "沿用已有 Key": "Reuse existing key", "代理失败会显式提示，不会静默直连": "Proxy failures are reported without silently connecting directly",
  "浏览器预览不提供 DeepSeek 原生对话，请在桌面应用中使用。": "DeepSeek native chat is unavailable in browser preview. Use the desktop app.",
  "历史保存失败：{error}": "Could not save history: {error}", "历史读取失败：{error}": "Could not load history: {error}", "保存 Key 失败：{error}": "Could not save the key: {error}",
  "Tao 在这里": "Tao is here", "Develop Buddy · 问、做、深研你的开发问题": "Develop Buddy · Ask, act and research",
  "用量与预算": "Usage and budget", "第 {n} 轮": "Turn {n}", "输入": "Input", "输出": "Output", "搜索": "Search", "读链接": "Read URL", "未知": "Unknown",
  "费用未知": "Cost unknown", "本轮": "This turn", "约 ¥{amount}（估算）": "Approx. ¥{amount} (estimated)",
  "搜索 Taomni 本地资料": "Search local Taomni records", "Tao 更多": "More Tao options", "导入 / 导出历史": "Import / export history",
  "演示模式": "Presentation mode", "界面设置": "Appearance settings", "给 Tao 的消息": "Message Tao", "请先连接 DeepSeek · 全家桶": "Connect DeepSeek App first",
  "问 Tao 任何开发问题…（{key} 发送）": "Ask Tao a development question… ({key} to send)", "添加附件": "Add attachment", "添加上下文": "Add context",
  "引用文件": "Attach file", "技能 / 工作流": "Skills / workflows", "本地资料": "Local records", "模型与能力": "Model and capabilities", "思考": "Thinking", "联网": "Web",
  "录音": "Record audio", "停止生成": "Stop generating", "发送": "Send", "{key} 发送": "{key} to send", "联网会产生费用（估算）": "Web tools may incur costs (estimated)",
  "本次将发送：正文 + {count} 条本地资料": "Sending: message + {count} local excerpts", "请先处理上方动作提议": "Review the action proposal above first",
  "预览 {label}": "Preview {label}", "移除 {label}": "Remove {label}", "{label} 的脱敏预览": "Redacted preview of {label}",
  "演示模式下已隐藏内容": "Content hidden in presentation mode", "该上下文尚无可预览内容。": "No preview is available for this context.", "关闭": "Close",
  "可以这样问": "Try asking", "解释一个终端报错": "Explain a terminal error", "帮我排查最近的构建失败": "Investigate the latest build failure",
  "写一个安全的 SQL 查询": "Write a safe SQL query", "深研一个技术方案": "Research a technical approach",
  "Tao 侧栏": "Tao sidebar", "关闭侧栏": "Close sidebar", "展开侧栏": "Expand sidebar", "收缩侧栏": "Collapse sidebar", "调整侧栏宽度": "Resize sidebar", "选择一条来源或生成物查看详情。": "Select a source or artifact to inspect it.", "暂无来源": "No sources yet", "暂无文件": "No files attached",
  "暂无工作流": "No workflows yet", "尚未连接此功能。": "This feature is not connected yet.",
  "复制": "Copy", "重新生成": "Regenerate", "已思考": "Thinking", "· 展开": "· Expanded", "· 点击查看": "· Show details", "正在搜索": "Searching", "已找到来源": "Sources found",
  "网络不可用": "Network unavailable", "流中断": "Stream interrupted", "请求参数无效": "Invalid request parameters", "配置不可用": "Configuration unavailable", "Tao 暂时无法完成": "Tao could not complete this request",
  "重试": "Retry", "工作流计划": "Workflow plan", "编辑动作": "Edit action", "我已确认命令内容": "I have reviewed this action", "执行": "Execute", "拒绝": "Reject",
  "执行编辑内容": "Use edited action", "编辑后执行": "Edit before executing", "已拒绝": "Rejected", "执行失败": "Execution failed",
  "本轮请求没有完成": "This request did not complete", "安全校验未通过本次回复": "This response did not pass the safety check",
  "思考与正文已丢弃，未保存到线程。可以改写问题后重试。": "This turn's thinking and text were discarded. Rephrase the question and try again.",
  "本轮 token 预算已用完": "This turn reached its token budget", "已完成步骤已保存，续跑不会重做。": "Completed steps are retained for continuation.", "提高预算并继续": "Increase budget and continue",
  "重新生成（联网回复无法续写）": "Regenerate (web replies cannot continue)", "继续生成": "Continue", "已停止生成": "Generation stopped", "已收到的内容已保留，可以从当前位置继续。": "Received content is retained. You can continue from here.",
  "Vault 已锁定": "Vault is locked", "解锁后可从已收到的位置继续": "Unlock Vault before continuing", "解锁 Vault": "Unlock Vault", "无法解锁 Vault：{error}": "Could not unlock Vault: {error}", "本轮尚未收到回复，可重新生成。": "No reply was received. You can regenerate this response.", "本机检索 · 不消耗 token": "Local search · No tokens used",
  "关闭搜索": "Close search", "搜索已保存资料（支持 source:sql since:14d）": "Search saved records (source:sql since:14d)", "资料来源": "Record sources", "全部": "All",
  "正在本机检索…": "Searching locally…", "已脱敏 {count} 处": "{count} redactions", "加入上下文": "Add context", "问 Tao": "Ask Tao", "打开": "Open", "本地没有找到相关资料": "No matching local records",
  "关键词少于 3 字，已改用精确匹配": "Short keyword: using exact matching", "当前宿主没有提供动作执行器。": "This host does not provide an action executor.",
  "清理状态": "Privacy cleanup", "已清理命令 {commands} 条、SQL {queries} 条": "Cleaned {commands} commands and {queries} SQL records",
};

export function taoText(text: string, params?: Record<string, string | number>): string {
  const value = getLocale() === "zh-CN" ? text : english[text] ?? text;
  return value.replace(/\{(\w+)\}/g, (match, key: string) => params?.[key] === undefined ? match : String(params[key]));
}

export function useTaoText() {
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  return taoText;
}
