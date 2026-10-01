/**
 * ED-PARITY-027 (PROP-026-01, option B + A): the main sidebar rail is the one
 * tool window bar of the window.
 *
 * - A: tab kinds that own tool windows (Code Workspace, terminals) remember
 *   their own sidebar state and start with the sidebar collapsed to the rail;
 *   every other tab kind shares the "other" state, which keeps the previous
 *   global behaviour. Leaving a group restores the next group's state.
 * - B: while the sidebar is collapsed, the active tab renders its tool window
 *   buttons into the rail instead of a second stripe of its own.
 *
 * Both are per-viewer preferences kept in browser storage; failures fall back
 * to the defaults.
 */

import type { TabKind } from "../types";

export type SidebarRailGroup = "code-workspace" | "terminal" | "other";

export type SidebarCollapsedByGroup = Record<SidebarRailGroup, boolean>;

export const MERGE_TOOL_WINDOW_RAIL_KEY = "taomni.mergeToolWindowRail";
export const SIDEBAR_COLLAPSED_BY_GROUP_KEY = "taomni.sidebarCollapsedByGroup.v1";

export function sidebarRailGroup(kind: TabKind | null | undefined): SidebarRailGroup {
  if (kind === "code-workspace") return "code-workspace";
  if (kind === "terminal") return "terminal";
  return "other";
}

export function readMergeToolWindowRail(): boolean {
  try {
    return window.localStorage.getItem(MERGE_TOOL_WINDOW_RAIL_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeMergeToolWindowRail(value: boolean): void {
  try {
    window.localStorage.setItem(MERGE_TOOL_WINDOW_RAIL_KEY, value ? "true" : "false");
  } catch {
    // Storage unavailable: the session keeps the in-memory choice.
  }
}

/** Defaults: tool-window tab kinds collapse to the rail; others keep `otherCollapsed`. */
export function defaultSidebarCollapsedByGroup(otherCollapsed: boolean): SidebarCollapsedByGroup {
  return { "code-workspace": true, terminal: true, other: otherCollapsed };
}

export function readSidebarCollapsedByGroup(otherCollapsed: boolean): SidebarCollapsedByGroup {
  const defaults = defaultSidebarCollapsedByGroup(otherCollapsed);
  try {
    const raw = window.localStorage.getItem(SIDEBAR_COLLAPSED_BY_GROUP_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<SidebarRailGroup, unknown>>;
    const pick = (group: SidebarRailGroup) => (typeof parsed[group] === "boolean" ? parsed[group] as boolean : defaults[group]);
    return { "code-workspace": pick("code-workspace"), terminal: pick("terminal"), other: pick("other") };
  } catch {
    return defaults;
  }
}

export function writeSidebarCollapsedByGroup(value: SidebarCollapsedByGroup): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_BY_GROUP_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable: the session keeps the in-memory map.
  }
}
