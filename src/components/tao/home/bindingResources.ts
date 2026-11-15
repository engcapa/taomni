import { useAppStore } from "../../../stores/appStore";
import { getTerminal, listTerminals } from "../../../lib/terminal/terminalRegistry";
import { redactText } from "../redact";
import type { ContextChip } from "../ai-chat";
import { taoText as tr } from "../i18n";

export interface BindingResource { id: string; label: string; kind: "workspace" | "terminal" | "database" }

/** Resolve resources at selection time: closed terminals must never be sent as
 * stale, hardcoded examples. Binding IDs alone are not model context. */
export function listBindingResources(kind: BindingResource["kind"]): BindingResource[] {
  const state = useAppStore.getState();
  if (kind === "terminal") return listTerminals().map((entry) => ({ id: entry.tabId, label: entry.title, kind }));
  if (kind === "database") return state.tabs.filter((tab) => state.dbConnByTab[tab.id]).map((tab) => ({ id: tab.id, label: tab.title, kind }));
  return Object.entries(state.codeWorkspaceByTab).map(([tabId, context]) => ({ id: tabId, label: state.tabs.find((tab) => tab.id === tabId)?.title ?? context.repoRoot, kind }));
}

export function resolveBindingChip(resource: BindingResource): ContextChip {
  const state = useAppStore.getState();
  let content: string;
  if (resource.kind === "terminal") {
    const terminal = getTerminal(resource.id);
    if (!terminal) throw new Error(tr("终端已经关闭，请重新绑定。"));
    content = terminal.getLastLines(80);
  } else if (resource.kind === "database") {
    if (!state.dbConnByTab[resource.id]) throw new Error(tr("数据库连接已经关闭，请重新绑定。"));
    const objects = state.dbSelectedObjectsByTab[resource.id] ?? [];
    content = objects.map((item) => [item.catalog, item.schema, item.name].filter(Boolean).join(".") + ` (${item.kind})`).join("\n");
    if (!content) throw new Error(tr("请先在数据库中选择要引用的表或对象。"));
  } else {
    const context = state.codeWorkspaceByTab[resource.id];
    if (!context) throw new Error(tr("工作区已经关闭，请重新绑定。"));
    content = [`${tr("工作区")}: ${context.repoRoot}`, `${tr("活动文件")}: ${context.activePath ?? tr("无")}`, ...context.openPaths.slice(0, 20).map((path) => `${tr("打开")}: ${path}`)].join("\n");
  }
  const preview = redactText(content).text.slice(0, 8000);
  if (!preview.trim()) throw new Error(tr("当前资源没有可引用的内容。"));
  return { id: `binding:${resource.kind}:${resource.id}`, kind: resource.kind, label: resource.label, preview, removable: true };
}
