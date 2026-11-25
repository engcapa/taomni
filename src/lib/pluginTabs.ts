import type { PluginTabInfo, Tab } from "../types";
import { useAppStore } from "../stores/appStore";
import { usePluginFrontendStore } from "../stores/pluginFrontendStore";

export function isPluginTabInfo(value: unknown): value is PluginTabInfo {
  if (!value || typeof value !== "object") return false;
  const info = value as Partial<PluginTabInfo>;
  return typeof info.slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(info.slug)
    && typeof info.kind === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(info.kind);
}

/** Discard every field outside the non-sensitive view locator contract. */
export function readPluginTab(value: unknown): Tab | null {
  if (!value || typeof value !== "object") return null;
  const tab = value as Partial<Tab>;
  if (tab.type !== "plugin" || !isPluginTabInfo(tab.plugin) || typeof tab.id !== "string"
    || !/^plugin-[a-zA-Z0-9-]{1,100}$/.test(tab.id) || typeof tab.title !== "string" || tab.title.length > 256) return null;
  return { id: tab.id, type: "plugin", title: tab.title, closable: true, plugin: { slug: tab.plugin.slug, kind: tab.plugin.kind } };
}

/** Built-in tab kinds remain unchanged; manifest kinds are scoped to their owner. */
export function openPluginTab(info: PluginTabInfo): string {
  if (!isPluginTabInfo(info)) throw new Error("Invalid module tab");
  const runtime = usePluginFrontendStore.getState();
  const record = runtime.records[info.slug];
  const declaration = record?.manifest?.tabs.find((tab) => tab.kind === info.kind);
  if (runtime.status !== "ready" || runtime.pending.has(info.slug) || record?.lifecycle !== "enabled"
    || !record.manifest?.entry.frontend || !declaration) throw new Error("Module tab is unavailable");
  const app = useAppStore.getState();
  const existing = app.tabs.find((tab) => tab.type === "plugin" && tab.plugin?.slug === info.slug && tab.plugin.kind === info.kind);
  if (existing) { app.setActiveTab(existing.id); return existing.id; }
  const tab: Tab = {
    id: `plugin-${crypto.randomUUID()}`, type: "plugin", title: declaration.title,
    closable: true, plugin: { slug: info.slug, kind: info.kind },
  };
  app.addTab(tab);
  return tab.id;
}
