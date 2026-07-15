/** Sorting, recent-ref tracking, and collapsible section helpers for Git branches/tags. */

const RECENT_BRANCH_KEY = "taomni.git.recent.branches";
const RECENT_TAG_KEY = "taomni.git.recent.tags";
const BRANCH_COLLAPSE_KEY = "taomni.git.branches.collapsed";
const TAG_COLLAPSE_KEY = "taomni.git.tags.collapsed";
const RECENT_LIMIT = 12;

export type BranchSectionId = "recent" | "local" | "remote";
export type TagSectionId = "recent" | "all";

export interface DatedNamed {
  name: string;
  date?: string | null;
}

export function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Primary: modification/create date newest-first; secondary: name A→Z. */
export function sortByDateThenName<T extends DatedNamed>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const delta = dateMs(b.date) - dateMs(a.date);
    if (delta !== 0) return delta;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function readNameList(storageKey: string, repoRoot: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const list = parsed[repoRoot];
    return Array.isArray(list) ? list.filter((name) => typeof name === "string" && name.trim()) : [];
  } catch {
    return [];
  }
}

function writeNameList(storageKey: string, repoRoot: string, names: string[]) {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    parsed[repoRoot] = names.slice(0, RECENT_LIMIT);
    localStorage.setItem(storageKey, JSON.stringify(parsed));
  } catch {
    /* ignore quota / private mode */
  }
}

export function rememberRecentBranch(repoRoot: string, name: string): void {
  const trimmed = name.trim();
  if (!repoRoot || !trimmed) return;
  const next = [trimmed, ...getRecentBranchNames(repoRoot).filter((item) => item !== trimmed)];
  writeNameList(RECENT_BRANCH_KEY, repoRoot, next);
}

export function getRecentBranchNames(repoRoot: string): string[] {
  return readNameList(RECENT_BRANCH_KEY, repoRoot);
}

export function rememberRecentTag(repoRoot: string, name: string): void {
  const trimmed = name.trim();
  if (!repoRoot || !trimmed) return;
  const next = [trimmed, ...getRecentTagNames(repoRoot).filter((item) => item !== trimmed)];
  writeNameList(RECENT_TAG_KEY, repoRoot, next);
}

export function getRecentTagNames(repoRoot: string): string[] {
  return readNameList(RECENT_TAG_KEY, repoRoot);
}

/**
 * Build the Recent branch list: remembered checkouts first (still existing),
 * then fill from date-sorted branches until `limit`.
 */
export function pickRecentItems<T extends { name: string } & DatedNamed>(
  items: readonly T[],
  rememberedNames: readonly string[],
  limit = RECENT_LIMIT,
): T[] {
  const byName = new Map(items.map((item) => [item.name, item]));
  const picked: T[] = [];
  const seen = new Set<string>();
  for (const name of rememberedNames) {
    const item = byName.get(name);
    if (!item || seen.has(item.name)) continue;
    picked.push(item);
    seen.add(item.name);
    if (picked.length >= limit) return picked;
  }
  for (const item of sortByDateThenName(items)) {
    if (seen.has(item.name)) continue;
    picked.push(item);
    seen.add(item.name);
    if (picked.length >= limit) break;
  }
  return picked;
}

export type CollapseState = Record<string, boolean | undefined>;

export function readCollapseState<T extends string>(
  storageKey: string,
  defaults: Record<T, boolean>,
): Record<T, boolean> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as CollapseState;
    const next = { ...defaults };
    for (const key of Object.keys(defaults) as T[]) {
      if (typeof parsed[key] === "boolean") next[key] = parsed[key]!;
    }
    return next;
  } catch {
    return { ...defaults };
  }
}

export function writeCollapseState<T extends string>(
  storageKey: string,
  state: Record<T, boolean>,
): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export const defaultBranchCollapse = (): Record<BranchSectionId, boolean> => ({
  recent: false,
  local: false,
  remote: false,
});

export const defaultTagCollapse = (): Record<TagSectionId, boolean> => ({
  recent: false,
  all: false,
});

export function loadBranchCollapse(): Record<BranchSectionId, boolean> {
  return readCollapseState(BRANCH_COLLAPSE_KEY, defaultBranchCollapse());
}

export function saveBranchCollapse(state: Record<BranchSectionId, boolean>): void {
  writeCollapseState(BRANCH_COLLAPSE_KEY, state);
}

export function loadTagCollapse(): Record<TagSectionId, boolean> {
  return readCollapseState(TAG_COLLAPSE_KEY, defaultTagCollapse());
}

export function saveTagCollapse(state: Record<TagSectionId, boolean>): void {
  writeCollapseState(TAG_COLLAPSE_KEY, state);
}

export function formatRefDate(value: string | null | undefined): string {
  if (!value) return "";
  const ms = dateMs(value);
  if (!ms) return value;
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}
