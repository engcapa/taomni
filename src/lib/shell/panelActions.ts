import { shellPanelRegistry } from "./panelRegistry";
import { useShellLayoutStore } from "../../stores/shellLayoutStore";
import type { ShellSurfaceAdapter } from "./types";

export type PanelActions = ShellSurfaceAdapter["actions"];
export function registerPanelActions(id: string, actions: PanelActions) {
  return shellPanelRegistry.register({ id, actions, getInstance: () => useShellLayoutStore.getState().panels[id] });
}
export function getPanelActions(id: string) { return shellPanelRegistry.get(id)?.actions; }
