import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { broadcastReattach, clearDetachedHandoff, consumeDetachedHandoff } from "../../lib/detachedSession";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { readPluginTab } from "../../lib/pluginTabs";
import { usePluginFrontendRegistry } from "../../lib/usePluginFrontendRegistry";
import { useT } from "../../lib/i18n";
import { isTauriRuntime } from "../../lib/runtime";
import { useAppStore } from "../../stores/appStore";
import { PluginTabPane } from "./PluginTabPane";

export function PluginDetachedWindow({ id }: { id: string }) {
  const t = useT();
  usePluginFrontendRegistry();
  const [error, setError] = useState<string | null>(null);
  const [returned, setReturned] = useState(false);
  const [tab] = useState(() => {
    const key = `taomni.plugin-window.${id}`;
    try {
      const saved = readPluginTab(consumeDetachedHandoff("plugin", id))
        ?? readPluginTab(JSON.parse(sessionStorage.getItem(key) ?? "null"));
      if (saved?.id !== id) return null;
      sessionStorage.setItem(key, JSON.stringify(saved));
      return saved;
    } catch { return null; }
  });
  const reattaching = useRef(false);
  const closing = useRef(false);
  useEffect(() => {
    if (!tab) return;
    useAppStore.setState({ tabs: [tab], activeTabId: tab.id });
  }, [tab]);
  const publish = useCallback(() => {
    if (!tab || reattaching.current) return;
    reattaching.current = true;
    setReturned(true);
    broadcastReattach("plugin", id, tab);
    clearDetachedHandoff("plugin", id);
    try { sessionStorage.removeItem(`taomni.plugin-window.${id}`); } catch { /* noop */ }
  }, [id, tab]);
  const reattach = useCallback(async () => {
    if (!tab || closing.current) return;
    closing.current = true;
    setError(null);
    publish();
    try {
      if (isTauriRuntime()) await closeCurrentDetachedWindow();
      else window.close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      closing.current = false;
    }
  }, [publish, tab]);
  useEffect(() => {
    if (!isTauriRuntime()) {
      // pagehide also fires on reload. Preview returns through the explicit
      // button; only the native close-request event establishes OS-close.
      return;
    }
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      void reattach();
    }).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; stop?.(); };
  }, [publish, reattach]);
  return <div data-testid="plugin-detached-window" className="flex h-screen min-h-0 flex-col">
    <header className="flex shrink-0 items-center gap-3 border-b border-[var(--taomni-divider)] p-2 text-ui-body">
      <span className="min-w-0 flex-1 truncate">{tab?.title}</span>
      <button type="button" data-testid="plugin-tab-reattach" className="taomni-btn px-2 py-1" disabled={!tab} onClick={() => { void reattach(); }}>{t(returned ? "plugins.closeWindow" : "plugins.reattach")}</button>
    </header>
    {error && <p role="alert" className="p-2 text-ui-body text-red-600">{error}</p>}
    <div className="min-h-0 flex-1">{returned
      ? <p data-testid="plugin-tab-returned" role="status" className="p-4 text-ui-body">{t("plugins.returned")}</p>
      : tab ? <PluginTabPane tab={tab} active /> : <p role="alert">{t("plugins.detachedMissing")}</p>}</div>
  </div>;
}
