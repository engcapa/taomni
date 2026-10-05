import type { DockEdge } from "./types";
interface SidebarBridge { setCollapsed(collapsed: boolean): void; toggle(): void; select(area: "sessions" | "tools"): void; apply(): void }
let sidebar: SidebarBridge | undefined;
export function installSidebarBridge(value: SidebarBridge) { sidebar = value; return () => { if (sidebar === value) sidebar = undefined; }; }
export function shellSidebarBridge() { return sidebar; }
let activateTab: ((id: string) => void) | undefined;
export function installTabActivationBridge(value: (id: string) => void) {
  activateTab = value;
  return () => { if (activateTab === value) activateTab = undefined; };
}
export function notifyShellTabActivation(id: string) { activateTab?.(id); }
interface TaoBridge { update(patch: { edge?: DockEdge; width?: number; height?: number; pinned?: boolean; opacity?: number }): void }
let tao: TaoBridge | undefined;
export function installTaoBridge(value: TaoBridge) { tao = value; return () => { if (tao === value) tao = undefined; }; }
export function shellTaoBridge() { return tao; }
