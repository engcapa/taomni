import type { WorkspaceEntry } from "../../../lib/editor/workspace";

export type ExplorerSortField = "name" | "type" | "size" | "modified";
export interface ExplorerSort {
  field: ExplorerSortField;
  descending: boolean;
  foldersFirst: boolean;
}

export const DEFAULT_EXPLORER_SORT: ExplorerSort = { field: "name", descending: false, foldersFirst: true };
export const EXPLORER_SORT_KEY = "taomni.codeWorkspace.explorerSort.v1";
export function createExplorerNameCollator(locale = new Intl.Collator().resolvedOptions().locale): Intl.Collator {
  // WebKit inherits en-US-u-va-posix on C/UTF-8 Linux desktops. That variant
  // orders uppercase before lowercase even with sensitivity:"base".
  const naturalLocale = locale.replace(/-va-posix(?=-|$)/i, "").replace(/-posix(?=-|$)/i, "").replace(/-u$/i, "");
  return new Intl.Collator(naturalLocale, { numeric: true, sensitivity: "base" });
}
const collator = createExplorerNameCollator();

export function readExplorerSort(): ExplorerSort {
  try {
    const value = JSON.parse(localStorage.getItem(EXPLORER_SORT_KEY) ?? "null") as Partial<ExplorerSort> | null;
    if (!value || !["name", "type", "size", "modified"].includes(value.field ?? "")) return DEFAULT_EXPLORER_SORT;
    return { field: value.field!, descending: value.descending === true, foldersFirst: value.foldersFirst !== false };
  } catch { return DEFAULT_EXPLORER_SORT; }
}

export function writeExplorerSort(value: ExplorerSort): void {
  try { localStorage.setItem(EXPLORER_SORT_KEY, JSON.stringify(value)); }
  catch { /* Keep the current viewer usable when browser storage is unavailable. */ }
}

export function explorerEntryType(entry: WorkspaceEntry): string {
  if (entry.fileType === "dir") return "Folder";
  if (entry.fileType === "symlink") return "Link";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 && dot < entry.name.length - 1 ? entry.name.slice(dot + 1).toUpperCase() : "File";
}

const sortedEntries = new WeakMap<readonly WorkspaceEntry[], Map<string, WorkspaceEntry[]>>();

/** Cache by immutable listing: opening another folder does not re-sort old ones. */
export function sortExplorerEntries(entries: readonly WorkspaceEntry[], sort: ExplorerSort): WorkspaceEntry[] {
  const signature = `${sort.field}:${sort.descending}:${sort.foldersFirst}`;
  let cached = sortedEntries.get(entries);
  const previous = cached?.get(signature);
  if (previous) return previous;
  const result = [...entries].sort((a, b) => {
    if (sort.foldersFirst && (a.fileType === "dir") !== (b.fileType === "dir")) return a.fileType === "dir" ? -1 : 1;
    // Directory byte sizes are filesystem bookkeeping, not folder content sizes.
    // Keep grouped folders ordered by name on every platform.
    if (sort.foldersFirst && a.fileType === "dir" && b.fileType === "dir") {
      const order = collator.compare(a.name, b.name) || collator.compare(a.path, b.path);
      return sort.descending ? -order : order;
    }
    const order = sort.field === "size" ? a.size - b.size
      : sort.field === "modified" ? a.mtime - b.mtime
      : sort.field === "type" ? collator.compare(explorerEntryType(a), explorerEntryType(b))
      : collator.compare(a.name, b.name);
    const stable = order || collator.compare(a.name, b.name) || collator.compare(a.path, b.path);
    return sort.descending ? -stable : stable;
  });
  if (!cached) { cached = new Map(); sortedEntries.set(entries, cached); }
  cached.set(signature, result);
  return result;
}

/** Package folders under source roots flatten independently of their files. */
export function explorerPackage(path: string): { sourceRoot: string; name: string; file: string } {
  const normalized = path.replace(/\\/g, "/");
  const source = /^(.*?\bsrc\/(?:main|test)\/(?:java|kotlin))\//.exec(normalized)
    ?? /^(.*?\b(?:src|lib|app|source|sources))\//.exec(normalized);
  const sourceRoot = source?.[1] ?? "";
  const relative = sourceRoot ? normalized.slice(sourceRoot.length + 1) : normalized;
  const parts = relative.split("/");
  const file = parts.pop() ?? relative;
  return { sourceRoot, name: parts.join(".") || "(default package)", file };
}
