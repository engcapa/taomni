import { create } from "zustand";
import type { ShellAction } from "./shellActions";
export const SHELL_KEYMAP_KEY = "taomni.shellKeymap.v1";
export const SHELL_BINDABLE_ACTIONS = ["shell.quickSwitch", "shell.overview", "shell.home", "shell.navigator.toggle", "shell.tao.toggle", "shell.panel.open"] as const;
const defaults: Partial<Record<ShellAction, string>> = { "shell.quickSwitch": "Mod+K" };
export function normalizeShellKey(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "key">): string {
  const mods = [event.ctrlKey ? "Control" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""].filter(Boolean);
  return [...mods, event.key.length === 1 ? event.key.toUpperCase() : event.key].join("+");
}
function loadBindings() {
  try { const raw = JSON.parse(localStorage.getItem(SHELL_KEYMAP_KEY) ?? "{}"); return { ...defaults, ...Object.fromEntries(SHELL_BINDABLE_ACTIONS.filter((action) => typeof raw[action] === "string" && raw[action].length < 80).map((action) => [action, raw[action]])) }; }
  catch { return { ...defaults }; }
}
export const useShellKeymapStore = create<{ bindings: Partial<Record<ShellAction, string>>; setBinding(action: ShellAction, key: string): void; reset(): void }>((set) => ({
  bindings: loadBindings(),
  setBinding: (action, key) => set((state) => { const bindings = { ...state.bindings, [action]: key }; try { localStorage.setItem(SHELL_KEYMAP_KEY, JSON.stringify(bindings)); } catch { /* Current runtime binding remains valid. */ } return { bindings }; }),
  reset: () => { try { localStorage.removeItem(SHELL_KEYMAP_KEY); } catch { /* Memory fallback. */ } set({ bindings: { ...defaults } }); },
}));
