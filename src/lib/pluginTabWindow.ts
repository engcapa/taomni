import type { Tab } from "../types";
import { useAppStore } from "../stores/appStore";
import { clearDetachedHandoff, consumeDetachedHandoff, detachedWindowUrl, writeDetachedHandoff } from "./detachedSession";
import { openDetachedWindow } from "./detachWindowing";
import { readPluginTab } from "./pluginTabs";
import { isTauriRuntime } from "./runtime";

const detaching = new Set<string>();

export async function detachPluginTab(source: Tab): Promise<void> {
  const tab = readPluginTab(source);
  if (!tab || detaching.has(tab.id)) return;
  detaching.add(tab.id);
  const id = tab.id;
  try {
    writeDetachedHandoff("plugin", id, tab);
    if (!readPluginTab(consumeDetachedHandoff("plugin", id))) throw new Error("Module window handoff could not be saved");
    if (isTauriRuntime()) await openDetachedWindow({ kind: "plugin", sessionId: id, title: tab.title });
    else if (!window.open(detachedWindowUrl("plugin", id), `taomni_plugin_${id}`, "width=1100,height=720,resizable=yes")) {
      throw new Error("Module window was blocked");
    }
    useAppStore.getState().removeTab(tab.id);
  } catch (error) {
    clearDetachedHandoff("plugin", id);
    throw error;
  } finally { detaching.delete(tab.id); }
}
