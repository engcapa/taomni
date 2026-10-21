import type { Tab } from "../../types";
import { sidebarRailGroup, writeSidebarCollapsedByGroup } from "../sidebarRailPolicy";
import { type DbSelectedObject, type AppState } from "./types";
import { writeSidebarCollapsed } from "./preferences";

export function pruneSet(ids: Set<string>, validIds: Set<string>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) {
    if (validIds.has(id)) next.add(id);
  }
  return next;
}

export function omitRecordKeys<T>(record: Record<string, T>, ids: Set<string>): Record<string, T> {
  if (![...ids].some((id) => id in record)) return record;
  const next = { ...record };
  for (const id of ids) delete next[id];
  return next;
}

export function dbSelectedObjectsEqual(a: DbSelectedObject[] | undefined, b: DbSelectedObject[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return (
      other &&
      item.catalog === other.catalog &&
      item.schema === other.schema &&
      item.name === other.name &&
      item.kind === other.kind
    );
  });
}

export function arraysEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function activeTabIsTerminal(tabs: Tab[], activeTabId: string | null): boolean {
  return !!activeTabId && tabs.some((tab) => tab.id === activeTabId && tab.type === "terminal");
}

/**
 * Build the title for a duplicated tab. The base name is the source title with
 * any trailing `-<digits>` stripped, so the whole "family" shares one counter.
 * The returned title is `<base>-<n>` where `n` is one past the highest suffix
 * already used by an open tab in that family.
 *
 * Examples (given the open titles in brackets):
 *   "Server"   ["Server"]                       -> "Server-1"
 *   "Server"   ["Server","Server-1"]            -> "Server-2"
 *   "Server-1" ["Server","Server-1","Server-2"] -> "Server-3"
 */

export function terminalAutoTitleBase(tab: Tab, cwdPrefix: string): string {
  const sessionName = tab.terminalTitleSessionName?.trim();
  return sessionName ? `${sessionName} · ${cwdPrefix}` : cwdPrefix;
}

/**
 * ED-PARITY-027 A: a manual sidebar change is remembered for the active tab's
 * group, so returning to that kind of tab restores it. With the merged rail the
 * legacy key keeps only the "other" group's state, which is what a new launch
 * (Welcome) starts from.
 */
export function rememberSidebarForActiveGroup(
  s: Pick<AppState, "mergeToolWindowRail" | "sidebarCollapsedByGroup" | "tabs" | "activeTabId">,
  collapsed: boolean,
): Partial<Pick<AppState, "sidebarCollapsedByGroup">> {
  if (!s.mergeToolWindowRail) {
    writeSidebarCollapsed(collapsed);
    return {};
  }
  const active = s.tabs.find((tab) => tab.id === s.activeTabId);
  const group = sidebarRailGroup(active?.type);
  if (group === "other") writeSidebarCollapsed(collapsed);
  if (s.sidebarCollapsedByGroup[group] === collapsed) return {};
  const sidebarCollapsedByGroup = { ...s.sidebarCollapsedByGroup, [group]: collapsed };
  if (group !== "other") writeSidebarCollapsedByGroup(sidebarCollapsedByGroup);
  return { sidebarCollapsedByGroup };
}
