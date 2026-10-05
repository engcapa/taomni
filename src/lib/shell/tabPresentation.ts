import type { Tab } from "../../types";
import type { BusinessLane, PanelOwner, TabLane } from "./types";

const lanes: Record<string, TabLane> = {
  welcome: "home",
  terminal: "connect", sftp: "connect", rdp: "connect", vnc: "connect",
  "file-browser": "connect", "object-storage": "connect",
  "code-workspace": "build", git: "build", database: "build", redis: "build", "hbase-shell": "build",
  mail: "communicate", "mail-unified": "communicate", "lan-chat": "communicate",
  nettools: "utility", sockscap: "utility", "proxy-test": "utility", mfa: "utility", settings: "utility", placeholder: "utility",
};
export function defaultLane(kind: string): TabLane { return lanes[kind] ?? "utility"; }
export function tabLane(tab: Tab, override?: BusinessLane): TabLane {
  return tab.type === "welcome" ? "home" : override ?? defaultLane(tab.type);
}
export function panelOwnerKey(owner: PanelOwner): string {
  return owner.kind === "workspace" ? `workspace:${owner.workspaceInstanceId}`
    : owner.kind === "background" ? `background:${owner.resourceKey}` : `tab:${owner.tabId}`;
}
export function panelIdentity(kind: string, owner: PanelOwner): string { return `${panelOwnerKey(owner)}:${kind}`; }
export function ownerMatches(owner: PanelOwner, tabId: string | null): boolean {
  return owner.kind !== "background" && owner.tabId === tabId;
}
function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}
const typeAliases: Record<string, string> = {
  terminal: "terminal ssh shell 终端 连接 本地", sftp: "sftp files transfer 文件 传输",
  "code-workspace": "code workspace project 工作区 项目 代码", git: "git version changes 版本 更改",
  database: "database sql 数据库 查询", mail: "mail email 邮件 邮箱", "mail-unified": "mail inbox 邮件 收件箱",
  settings: "settings preferences 设置", "lan-chat": "chat 聊天", welcome: "home welcome 首页 欢迎",
  rdp: "remote desktop 远程 桌面", vnc: "remote desktop 远程 桌面", redis: "database cache 数据库 缓存",
  "hbase-shell": "database hbase shell 数据库 终端", "file-browser": "files directory 文件 目录",
  "object-storage": "s3 oss cos bucket 对象 存储", nettools: "network tools 网络 工具",
  sockscap: "proxy tunnel 代理 隧道", "proxy-test": "proxy network 代理 测试", mfa: "otp totp authentication 验证 口令",
};
export function tabSearchText(tab: Tab, displayFields: string[] = []): string {
  // Deliberately select display fields: serializing a connection would expose credentials.
  return [tab.title, tab.type, tab.ssh?.host, tab.sftp?.host, tab.rdp?.host, tab.vnc?.host,
    tab.git?.repoRoot, tab.git?.workspaceName, tab.codeWorkspace?.repoRoot,
    ...(tab.codeWorkspace?.roots?.map((root) => `${root.name} ${root.path}`) ?? []),
    ...(tab.codeWorkspace?.looseFiles?.map((file) => file.path) ?? []), tab.db?.host, tab.db?.engine,
    tab.fileBrowser?.initialPath, tab.mail?.imap.host, tab.mail?.emailAddress, typeAliases[tab.type], ...displayFields].map(clean).join(" ").normalize("NFC").toLocaleLowerCase();
}
export function matchesTabSearch(tab: Tab, query: string, displayFields: string[] = []): boolean {
  const haystack = tabSearchText(tab, displayFields);
  return query.normalize("NFC").trim().toLocaleLowerCase().split(/\s+/).every((token) => haystack.includes(token));
}
export function tabSummary(tab: Tab): string {
  return clean(tab.codeWorkspace?.repoRoot ?? tab.git?.repoRoot ?? tab.fileBrowser?.initialPath
    ?? tab.ssh?.host ?? tab.sftp?.host ?? tab.rdp?.host ?? tab.vnc?.host ?? tab.db?.host ?? tab.mail?.emailAddress ?? tab.type);
}
export interface TabPresentation {
  tabId: string; defaultLane: TabLane; lane: TabLane; role: "primary"; active: boolean; pinned: boolean;
  dirty: boolean; attention: "none" | "unread" | "busy" | "error"; unreadCount: number; lastUsedAt: number;
  preview: { kind: "terminal" | "tree" | "mail" | "database" | "remote" | "tool"; summary: string; secondary?: string };
  capabilities: { close: boolean; duplicate: boolean; detach: boolean; rename: boolean };
}
export function presentTab(tab: Tab, facts: { active?: boolean; pinned?: boolean; override?: BusinessLane; dirty?: boolean; error?: string | null; busy?: boolean; unreadCount?: number; lastUsedAt?: number; secondary?: string } = {}): TabPresentation {
  const unreadCount = Math.max(0, facts.unreadCount ?? (tab.hasNewOutput ? 1 : 0));
  const kind = tab.type === "terminal" ? "terminal" : tab.type === "code-workspace" || tab.type === "git" ? "tree" : tab.type.startsWith("mail") ? "mail" : tab.type === "database" || tab.type === "redis" ? "database" : tab.type === "rdp" || tab.type === "vnc" ? "remote" : "tool";
  return { tabId: tab.id, defaultLane: defaultLane(tab.type), lane: tabLane(tab, facts.override), role: "primary", active: !!facts.active, pinned: !!facts.pinned,
    dirty: !!facts.dirty, attention: facts.error ? "error" : facts.busy ? "busy" : unreadCount ? "unread" : "none", unreadCount, lastUsedAt: facts.lastUsedAt ?? 0,
    preview: { kind, summary: tabSummary(tab), ...(facts.secondary ? { secondary: clean(facts.secondary) } : {}) },
    capabilities: { close: tab.closable, duplicate: tab.type !== "welcome" && !tab.shellPanelId, detach: primaryCanDetach(tab), rename: tab.closable } };
}
export function primaryCanDetach(tab: Tab): boolean {
  return ["terminal", "sftp", "database", "rdp", "vnc", "git"].includes(tab.type);
}
/** Keep the active result reachable when a lane has more than six tabs. */
export function stripTabs(tabs: Tab[], activeId: string | null, limit = 6): Tab[] {
  const shown = tabs.slice(0, limit);
  const active = tabs.find((tab) => tab.id === activeId);
  if (active && !shown.includes(active) && shown.length) shown[shown.length - 1] = active;
  return shown;
}
export function closeSuccessor(tabs: Tab[], removed: Set<string>, activeId: string | null,
  mru: readonly string[], overrides: Record<string, BusinessLane>): string | null {
  if (activeId && !removed.has(activeId) && tabs.some((t) => t.id === activeId)) return activeId;
  const remaining = tabs.filter((t) => !removed.has(t.id));
  const active = tabs.find((t) => t.id === activeId);
  const lane = active ? tabLane(active, overrides[active.id]) : "home";
  const ordered = mru.map((id) => remaining.find((t) => t.id === id)).filter((t): t is Tab => !!t);
  return ordered.find((t) => tabLane(t, overrides[t.id]) === lane)?.id
    ?? ordered.find((t) => t.type !== "welcome")?.id ?? remaining.find((t) => t.type === "welcome")?.id
    ?? remaining[0]?.id ?? null;
}
