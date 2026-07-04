import type { TranslateFn } from "../../lib/i18n";

// A searchable unit in the Settings panel. `id` doubles as the DOM anchor id
// (see SettingsAnchor in SettingsPanel.tsx). `titleKeys` are i18n keys whose
// resolved text is matched in the active locale, so search tracks whatever
// language the UI is showing. `terms` are extra literal aliases (kept bilingual
// where useful) for synonyms the visible labels don't contain.
//
// To make a newly-added settings panel searchable, add one entry here in the
// same order it renders and wrap its markup in <SettingsAnchor id="...">.
export interface SettingsSearchEntry {
  id: string;
  titleKeys: string[];
  terms: string[];
}

// Order MUST match the render order in SettingsPanel so prev/next navigation
// walks matches top-to-bottom.
export const SETTINGS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    id: "language",
    titleKeys: ["settings.languageTitle", "settings.languageLabel"],
    terms: ["language", "locale", "i18n", "语言", "区域", "本地化"],
  },
  {
    id: "app-theme",
    titleKeys: ["settings.appThemeTitle"],
    terms: ["theme", "appearance", "dark", "light", "system", "color scheme", "主题", "外观", "深色", "浅色", "暗色", "亮色", "跟随系统"],
  },
  {
    id: "welcome-history",
    titleKeys: ["settings.welcomeHistoryTitle"],
    terms: ["welcome", "startup", "recent sessions", "session history", "restore sessions", "history limit", "欢迎页", "启动", "最近会话", "会话历史", "恢复会话", "历史数量"],
  },
  {
    id: "global-ui",
    titleKeys: ["settings.globalUiTitle"],
    terms: ["ui font", "font family", "font size", "typography", "interface font", "界面字体", "字体", "字号", "排版"],
  },
  {
    id: "code-view-appearance",
    titleKeys: ["settings.codeViewAppearanceTitle"],
    terms: [
      "code view", "code editor", "diff viewer", "syntax highlighting", "code font", "code theme",
      "match app", "app theme", "taomni theme",
      "代码视图", "代码编辑器", "diff", "差异", "语法高亮", "代码字体", "代码主题",
      "跟随应用", "应用主题", "Taomni 主题",
    ],
  },
  {
    id: "terminal-defaults",
    titleKeys: ["settings.terminalDefaultsTitle", "terminalAppearance.behaviorHeading"],
    terms: [
      "terminal", "ssh terminal", "local terminal", "terminal defaults", "terminal behavior", "terminal font", "terminal theme",
      "cursor", "scrollback", "right click", "copy on select", "bracketed paste", "osc 52",
      "终端", "ssh 终端", "本地终端", "终端默认", "终端行为", "终端字体", "终端主题",
      "光标", "回滚", "右键", "选中即复制", "括号粘贴",
    ],
  },
  {
    id: "vault",
    titleKeys: ["vaultSettings.sectionTitle"],
    terms: ["vault", "password", "secret", "master password", "credentials", "credential vault", "encryption", "密钥库", "保险库", "密码", "凭据", "主密码", "加密"],
  },
  {
    id: "app-proxy",
    titleKeys: ["settings.appProxyTitle"],
    terms: ["proxy", "socks", "socks5", "http proxy", "network", "vpn", "outbound", "代理", "网络", "出站"],
  },
  {
    id: "lanchat",
    titleKeys: ["settings.lanChatSection"],
    terms: ["lanchat", "lan", "messenger", "chat", "broadcast", "局域网", "内网", "通讯", "聊天", "广播", "消息"],
  },
  {
    id: "ai-master",
    titleKeys: ["settings.aiSection", "settings.aiMaster"],
    terms: ["ai", "artificial intelligence", "master switch", "assistant", "人工智能", "智能", "主开关", "助手"],
  },
  {
    id: "ai-privacy",
    titleKeys: ["settings.privacySection", "aiSettings.fullLocal", "settings.fullLocal"],
    terms: ["privacy", "full local", "offline", "cloud", "隐私", "全本地", "本地", "离线", "云端"],
  },
  {
    id: "ai-shell",
    titleKeys: ["aiSettings.aiShellTitle"],
    terms: ["voice shell", "voice", "shell", "command", "语音", "终端命令", "语音命令"],
  },
  {
    id: "ai-asr",
    titleKeys: ["aiSettings.asrTitle", "settings.asrSection"],
    terms: ["asr", "speech", "voice recognition", "dictation", "microphone", "语音识别", "听写", "麦克风"],
  },
  {
    id: "ai-llm",
    titleKeys: ["settings.llmSection"],
    terms: ["llm", "provider", "model", "openai", "anthropic", "api key", "endpoint", "大模型", "模型", "服务商", "密钥", "接口"],
  },
  {
    id: "ai-websearch",
    titleKeys: ["settings.webSearchSection"],
    terms: ["web search", "search", "internet", "browse", "网页搜索", "联网", "搜索", "浏览"],
  },
  {
    id: "ai-claude",
    titleKeys: ["aiSettings.ccTitle", "settings.claudeCodeSection"],
    terms: ["claude", "claude code", "bridge", "桥接"],
  },
  {
    id: "ai-codex",
    titleKeys: ["aiSettings.codexTitle"],
    terms: ["codex", "codex app-server", "openai codex", "bridge", "config", "科德", "配置", "桥接"],
  },
  {
    id: "ai-chatformat",
    titleKeys: ["settings.chatOutputFormat"],
    terms: ["output format", "markdown", "html", "rendering", "输出格式", "渲染"],
  },
  {
    id: "ai-chathistory",
    titleKeys: ["aiSettings.chatHistoryTitle", "settings.chatHistory"],
    terms: ["chat history", "retention", "clear history", "对话历史", "聊天记录", "保留", "清除"],
  },
  {
    id: "ai-models",
    titleKeys: ["settings.modelsAdvanced"],
    terms: ["models", "advanced", "model scope", "preference", "模型", "高级", "偏好"],
  },
];

// True when `query` matches the entry's resolved titles or any literal term.
// Empty/whitespace queries never match (caller treats that as "no search").
export function matchesEntry(entry: SettingsSearchEntry, query: string, t: TranslateFn): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  for (const key of entry.titleKeys) {
    const label = t(key);
    // resolveKey returns the key itself when a translation is missing; skip
    // those so a stray dotted key can't accidentally match.
    if (label && label !== key && label.toLowerCase().includes(q)) return true;
  }
  return entry.terms.some((term) => term.toLowerCase().includes(q));
}

// Ordered list of matching entry ids, preserving registry (render) order.
export function matchingIds(query: string, t: TranslateFn): string[] {
  if (!query.trim()) return [];
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => matchesEntry(entry, query, t)).map((e) => e.id);
}
