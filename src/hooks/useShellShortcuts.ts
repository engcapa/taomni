import { useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { shellKeyClaimed } from "../lib/shellKeyClaims";
import { dispatchShellAction, type ShellAction } from "../lib/shell/shellActions";
import { normalizeShellKey, useShellKeymapStore } from "../lib/shell/shellKeymap";
import { getAppPlatform } from "../lib/runtime";

export function useShellShortcuts() {
  useEffect(() => {
    let cycle: { ids: string[]; origin: string; index: number } | null = null;
    const handler = (event: KeyboardEvent) => {
      // A permanent escape hatch remains reachable with all chrome hidden,
      // including from an editor/terminal. Never interrupt an IME composition.
      const state = useShellLayoutStore.getState();
      if (!event.isComposing && (event.key === "F1" || state.immersive && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p")) {
        if (document.querySelector('[data-testid="shell-close-dialog"],[data-modal="true"]')) return;
        event.preventDefault(); event.stopPropagation(); dispatchShellAction("shell.actions"); return;
      }
      if (event.key === "Escape" && !event.isComposing && state.immersiveReveal === "workspace" && !document.querySelector('[aria-modal="true"],[data-taomni-context-menu]')) {
        event.preventDefault(); event.stopPropagation(); useShellLayoutStore.setState({ immersiveReveal: null }); return;
      }
      if (event.defaultPrevented || event.isComposing || !cycle && shellKeyClaimed(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const shell = useShellLayoutStore.getState();
      if (event.key === "Escape" && cycle) { event.preventDefault(); useAppStore.getState().setActiveTab(cycle.origin); cycle = null; useShellLayoutStore.setState({ mruCycling: false }); return; }
      if (document.querySelector('[aria-modal="true"]') || !cycle && target?.closest('input,textarea,[contenteditable="true"],.cm-editor')) return;
      if (event.key === "Escape") {
        if (shell.navigatorOverlay) { event.preventDefault(); useShellLayoutStore.setState({ navigatorOverlay: false }); return; }
        if (shell.taoOpen && !shell.layout.tao.pinned) { event.preventDefault(); useChatDismiss(); return; }
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key === "Tab") {
        const app = useAppStore.getState();
        if (!cycle) { cycle = { ids: [...new Set([app.activeTabId ?? "welcome", ...shell.mru, ...app.tabs.map((t) => t.id)])].filter((id) => app.tabs.some((tab) => tab.id === id)), origin: app.activeTabId ?? "welcome", index: 0 }; useShellLayoutStore.setState({ mruCycling: true }); }
        if (!cycle.ids.length) return;
        cycle.ids = cycle.ids.filter((id) => app.tabs.some((tab) => tab.id === id));
        if (!cycle.ids.length) { cycle = null; useShellLayoutStore.setState({ mruCycling: false }); return; }
        cycle.index = (cycle.index + (event.shiftKey ? -1 : 1) + cycle.ids.length) % cycle.ids.length;
        event.preventDefault(); event.stopPropagation(); app.setActiveTab(cycle.ids[cycle.index]); return;
      }
      const key = normalizeShellKey(event), mac = getAppPlatform() === "macos";
      const binding = Object.entries(useShellKeymapStore.getState().bindings).find(([, value]) => value?.replace("Mod", mac ? "Meta" : "Control") === key);
      if (!binding || target?.closest('[data-testid="terminal-pane"]')) return;
      event.preventDefault(); event.stopPropagation(); dispatchShellAction(binding[0] as ShellAction);
    };
    const release = (event: KeyboardEvent) => { if (event.key === "Control" && cycle) { cycle = null; useShellLayoutStore.setState({ mruCycling: false }); const id = useAppStore.getState().activeTabId; if (id) useShellLayoutStore.getState().visitTab(id); } };
    window.addEventListener("keydown", handler, true); window.addEventListener("keyup", release, true);
    return () => { window.removeEventListener("keydown", handler, true); window.removeEventListener("keyup", release, true); };
  }, []);
}
function useChatDismiss() { useShellLayoutStore.getState().setTaoOpen(false); }
