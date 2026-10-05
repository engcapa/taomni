import { useShellLayoutStore } from "../../stores/shellLayoutStore";
export type ShellAction = "shell.home" | "shell.quickSwitch" | "shell.overview" | "shell.navigator.toggle" | "shell.panel.open" | "shell.panels.recent" | "shell.tao.toggle" | "shell.layout.reset" | "shell.actions" | "shell.immersive.toggle";
const handlers = new Map<ShellAction, () => void | Promise<void>>();
export function registerShellActions(actions: Partial<Record<ShellAction, () => void | Promise<void>>>): () => void {
  for (const [id, handler] of Object.entries(actions)) handlers.set(id as ShellAction, handler);
  return () => { for (const [id, handler] of Object.entries(actions)) if (handlers.get(id as ShellAction) === handler) handlers.delete(id as ShellAction); };
}
export function dispatchShellAction(id: ShellAction): void | Promise<void> {
  if (id === "shell.actions") { useShellLayoutStore.getState().setOverlay("actions"); return; }
  if (id === "shell.immersive.toggle") { useShellLayoutStore.getState().toggleImmersive(); return; }
  return handlers.get(id)?.();
}
