import type { WorkspaceEntry } from "../../../../lib/editor/workspace";
import type { GitChange } from "../../../../lib/git";
import { basename } from "./paths";
import { isMarkdownPath } from "./files";
import { lspPresetIdForPath } from "./lspBinding";

/** Directory names skipped in recursive indexes / heavy walks (and hidden in tree). */
export const HEAVY_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

export function shouldHideEntry(entry: WorkspaceEntry): boolean {
  if (!entry.path) return false;
  const segments = entry.path.replace(/\\/g, "/").split("/");
  return segments.some((segment) => HEAVY_DIR_NAMES.has(segment));
}

/** Compact-tree display name: `src` → `src/main` when a single-child chain is folded. */
export function compactEntryName(
  entry: WorkspaceEntry,
  chain: { path: string; } | undefined,
): string {
  if (!chain || chain.path === entry.path) return entry.name;
  const suffix = chain.path.startsWith(`${entry.path}/`)
    ? chain.path.slice(entry.path.length + 1)
    : "";
  return suffix ? `${entry.name}/${suffix}` : entry.name;
}

/** Flat-view group key by file extension (lowercase, including the dot). */
export function flatExtensionGroup(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "No extension";
  return name.slice(dot).toLowerCase();
}

/**
 * Directories that must never appear as flat-view language source groups
 * (build output, docs, caches, vendored trees, etc.).
 */
export const FLAT_EXCLUDED_DIR_NAMES = new Set([
  ...HEAVY_DIR_NAMES,
  "output",
  "outputs",
  "out",
  "docs",
  "doc",
  "documentation",
  "examples",
  "example",
  "vendor",
  "third_party",
  "third-party",
  "coverage",
  "tmp",
  "temp",
  "logs",
  "log",
  "bin",
  "obj",
  "assets",
  "static",
  "public",
  "images",
  "img",
  "fonts",
  "testdata",
  "fixtures",
  "snapshots",
  "generated",
  "gen",
]);

/** Directory basenames treated as language source roots for the flat view. */
export const LANGUAGE_SOURCE_DIR_NAMES = new Set([
  "src",
  "lib",
  "app",
  "source",
  "sources",
]);

export function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Nearest language source root containing `path` (prefer the deepest `src` /
 * `lib` / `app` segment). Returns null when the file is not under such a root
 * (e.g. README, docs/, target/, root-level configs).
 *
 * Examples:
 * - `src/App.tsx` → `src`
 * - `src-tauri/src/lib.rs` → `src-tauri/src`
 * - `packages/web/src/main.ts` → `packages/web/src`
 */
export function languageSourceRootFor(path: string): string | null {
  const normalized = normalizeWorkspacePath(path);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // Walk directory segments only (exclude the file name).
  let rootIndex = -1;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (LANGUAGE_SOURCE_DIR_NAMES.has(parts[i])) rootIndex = i;
  }
  if (rootIndex < 0) return null;
  return parts.slice(0, rootIndex + 1).join("/");
}

export function pathHasExcludedSegment(path: string): boolean {
  return normalizeWorkspacePath(path)
    .split("/")
    .some((segment) => segment.length > 0 && FLAT_EXCLUDED_DIR_NAMES.has(segment));
}

/** True when the path looks like a documentation / non-source artifact. */
export function isDocumentationPath(path: string): boolean {
  if (isMarkdownPath(path)) return true;
  const name = basename(path).toLowerCase();
  if (
    name === "readme"
    || name === "changelog"
    || name === "license"
    || name === "licence"
    || name === "authors"
    || name === "contributing"
    || name.startsWith("readme.")
  ) {
    return true;
  }
  const lower = normalizeWorkspacePath(path).toLowerCase();
  return (
    lower.startsWith("docs/")
    || lower.startsWith("doc/")
    || lower.includes("/docs/")
    || lower.includes("/doc/")
  );
}

/**
 * Flat-view eligibility: language source file under a recognized `src`/`lib`/
 * `app` root, excluding build output and documentation trees.
 */
export function isFlatViewSourceFile(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  // Java/Kotlin package segments are namespace names: com.example, org.doc,
  // etc. are real source packages, not sample/documentation containers.
  const packageSource = /^((?:.*\/)?src\/(?:main|test)\/(?:java|kotlin))\//.exec(normalized)?.[1];
  const containers = packageSource ?? normalized;
  if (!normalized || pathHasExcludedSegment(containers)) return false;
  if (normalized.split("/").some((segment) => HEAVY_DIR_NAMES.has(segment))) return false;
  if (isDocumentationPath(containers)) return false;
  if (!lspPresetIdForPath(normalized)) return false;
  return languageSourceRootFor(normalized) != null;
}

/**
 * Flat-view group key: language source root (`src`, `src-tauri/src`, …).
 * Falls back to the top-level directory only when a source root is missing
 * (callers should normally filter with {@link isFlatViewSourceFile} first).
 */
export function flatSourceGroup(path: string): string {
  const root = languageSourceRootFor(path);
  if (root) return root;
  const normalized = normalizeWorkspacePath(path);
  const slash = normalized.indexOf("/");
  if (slash <= 0) return "(root)";
  return normalized.slice(0, slash);
}

/** Path relative to {@link flatSourceGroup} for display under that group. */
export function flatSourceRelativePath(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  const root = languageSourceRootFor(normalized) ?? flatSourceGroup(normalized);
  if (root === "(root)") return normalized || path;
  if (normalized === root) return basename(normalized);
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** Case-insensitive name/path substring match for the project-tree filter. */
export function matchesTreeFilter(name: string, path: string, filter: string): boolean {
  const q = filter.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q) || path.replace(/\\/g, "/").toLowerCase().includes(q);
}

/** Lookup a git change in the precomputed `rootId:workspacePath` map. */
export function gitChangeForPath(
  gitChangeByRootPath: Map<string, GitChange> | ReadonlyMap<string, GitChange>,
  rootId: string,
  path: string,
): GitChange | undefined {
  return gitChangeByRootPath.get(`${rootId}:${path}`);
}

/** Count git changes under a directory (or whole root when path is empty). */
export function gitDirectoryChangeCount(
  gitChangeByRootPath: Map<string, GitChange> | ReadonlyMap<string, GitChange>,
  rootId: string,
  path: string,
): number {
  const prefix = path ? `${rootId}:${path}/` : `${rootId}:`;
  let count = 0;
  for (const key of gitChangeByRootPath.keys()) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
}

/** Build once per immutable Git snapshot, keeping directory-row lookup O(1). */
export function createGitDirectoryChangeCounts(
  changes: ReadonlyMap<string, GitChange>,
  rootIds: readonly string[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const rootId of rootIds) {
    const prefix = `${rootId}:`;
    for (const key of changes.keys()) {
      if (!key.startsWith(prefix)) continue;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      const path = key.slice(prefix.length);
      for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
        const parent = `${prefix}${path.slice(0, slash)}`;
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
    }
  }
  return counts;
}
