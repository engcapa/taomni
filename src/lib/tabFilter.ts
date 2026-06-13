import type { Tab } from "../types";
import type { SessionConfig } from "./ipc";
import { normalizeGroupPath } from "./sessionPaths";

/**
 * Filter applied to the open-tab strip so the user can focus on one working
 * context (issue #121). It is transient, session-scoped view state: it hides
 * non-matching tabs from the strip *without closing them*, so the underlying
 * connections stay alive and can be revealed again by clearing the filter.
 *
 * - `group` keeps only tabs whose saved session lives under `path` (the
 *   normalized `group_path`; `""` is the ungrouped/local bucket).
 * - `query` keeps only tabs whose title or host contains `text`.
 */
export type TabFilter =
  | { kind: "group"; path: string }
  | { kind: "query"; text: string }
  | { kind: "multi"; paths: string[]; tabIds: string[] };

/**
 * The directory a tab belongs to, derived from its saved session's
 * `group_path`. Returns the normalized path (e.g. `"proj / cap"`), or null
 * when the tab has no saved session (local terminals, Welcome) or its session
 * sits at the tree root — those collapse into the ungrouped bucket.
 */
export function deriveTabGroupPath(
  tab: Tab,
  sessions: readonly SessionConfig[],
): string | null {
  if (!tab.sessionId) return null;
  const session = sessions.find((s) => s.id === tab.sessionId);
  if (!session) return null;
  return normalizeGroupPath(session.group_path);
}

/** Stable bucket key for grouping; `""` is the ungrouped/local bucket. */
export function tabGroupKey(tab: Tab, sessions: readonly SessionConfig[]): string {
  return deriveTabGroupPath(tab, sessions) ?? "";
}

/** Connection host for a tab, across the tab kinds that carry one. */
export function tabHost(tab: Tab): string | null {
  return (
    tab.ssh?.host ??
    tab.db?.host ??
    tab.rdp?.host ??
    tab.vnc?.host ??
    tab.sftp?.host ??
    tab.hbase?.host ??
    null
  );
}

/** Lower-cased text a query filter matches against (title + host). */
export function tabSearchText(tab: Tab): string {
  const host = tabHost(tab);
  return `${tab.title} ${host ?? ""}`.toLowerCase();
}

export function tabMatchesFilter(
  tab: Tab,
  sessions: readonly SessionConfig[],
  filter: TabFilter | null,
): boolean {
  if (!filter) return true;
  if (filter.kind === "query") {
    const q = filter.text.trim().toLowerCase();
    if (!q) return true;
    return tabSearchText(tab).includes(q);
  }
  if (filter.kind === "multi") {
    const { paths, tabIds } = filter;
    const key = tabGroupKey(tab, sessions);
    return paths.includes(key) || tabIds.includes(tab.id);
  }
  return tabGroupKey(tab, sessions) === (filter as any).path;
}

export function filterVisibleTabs(
  tabs: readonly Tab[],
  sessions: readonly SessionConfig[],
  filter: TabFilter | null,
): Tab[] {
  if (!filter) return [...tabs];
  return tabs.filter((tab) => tabMatchesFilter(tab, sessions, filter));
}

export function getFilterChipText(
  filter: TabFilter,
  _sessions: readonly SessionConfig[],
  tabs: readonly Tab[],
  t: (key: string, args?: any) => string,
): string {
  if (filter.kind === "query") return filter.text;
  if (filter.kind === "multi") {
    const parts: string[] = [];
    for (const p of filter.paths) {
      parts.push(p === "" ? t("tabs.filterUngrouped") : p);
    }
    for (const id of filter.tabIds) {
      const tab = tabs.find((t) => t.id === id);
      if (tab) {
        parts.push(tab.title);
      }
    }
    if (parts.length === 0) return t("tabs.filterClear");
    if (parts.length <= 2) return parts.join(", ");
    return t("tabs.filterCount", { count: parts.length }) || `${parts.length} filters`;
  }
  return "";
}
