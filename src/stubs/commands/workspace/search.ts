import { VFS_ROOT, vfsList, vfsReadText } from "../../localVfs";

/** Pending stub-search cancellations by search id (browser preview only). */
export const stubSearchCancelIds = new Set<string>();

export function stubSearchCancelled(searchId: string): () => boolean {
  return () => stubSearchCancelIds.has(searchId);
}

export function stubSearchGlobMatch(text: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(text);
}

export function stubSearchPathAllowed(
  relativePath: string,
  includeGlobs: string[],
  excludeGlobs: string[],
): boolean {
  const fileName = relativePath.split("/").pop() ?? relativePath;
  for (const raw of excludeGlobs) {
    const pattern = raw.trim();
    if (pattern && (stubSearchGlobMatch(fileName, pattern) || stubSearchGlobMatch(relativePath, pattern))) {
      return false;
    }
  }
  const positives = includeGlobs.map((raw) => raw.trim()).filter(Boolean);
  if (positives.length === 0) return true;
  return positives.some(
    (pattern) => stubSearchGlobMatch(fileName, pattern) || stubSearchGlobMatch(relativePath, pattern),
  );
}

/**
 * Browser-preview workspace search: line grep over VFS text files. Emits
 * `batch`/`done` events shaped like the native backend. Roots outside the
 * VFS jail are skipped with the reason recorded on the done event.
 */
export async function stubWorkspaceSearch(
  searchId: string,
  roots: Array<{ id?: unknown; name?: unknown; path?: unknown; }>,
  query: string,
  options: Record<string, unknown>,
  cancelled: () => boolean,
  emitSearch: (payload: Record<string, unknown>) => void,
): Promise<void> {
  const includeGlobs = Array.isArray(options.includeGlobs)
    ? (options.includeGlobs as unknown[]).map(String)
    : [];
  const excludeGlobs = Array.isArray(options.excludeGlobs)
    ? (options.excludeGlobs as unknown[]).map(String)
    : [];
  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;
  const useRegexp = options.regexp === true;
  const maxTotal = typeof options.maxTotalMatches === "number" ? options.maxTotalMatches : 2000;
  let pattern: RegExp;
  try {
    const source = useRegexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(wholeWord ? `\\b(?:${source})\\b` : source, caseSensitive ? "g" : "gi");
  } catch {
    emitSearch({
      searchId, kind: "error", matches: [], truncated: false, cancelled: false,
      filesScanned: 0, totalMatches: 0, error: `Invalid search pattern: ${query}`,
    });
    return;
  }
  interface StubMatch {
    rootId: string;
    rootName: string;
    rootPath: string;
    path: string;
    lineNumber: number;
    column: number;
    matchStart: number;
    matchEnd: number;
    lineText: string;
  }
  let filesScanned = 0;
  let totalMatches = 0;
  let truncated = false;
  const skippedRoots: string[] = [];
  const harvestFile = async (
    rootId: string,
    rootName: string,
    rootPath: string,
    relative: string,
    absolute: string,
    out: StubMatch[],
  ): Promise<boolean> => {
    let text: string;
    try {
      text = await vfsReadText(absolute);
    } catch {
      return true;
    }
    filesScanned += 1;
    const lines = text.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const lineText = lines[lineIndex];
      pattern.lastIndex = 0;
      let hit: RegExpExecArray | null;
      while ((hit = pattern.exec(lineText)) !== null) {
        const start = Array.from(lineText.slice(0, hit.index)).length;
        const end = start + Array.from(hit[0]).length;
        out.push({
          rootId, rootName, rootPath, path: relative,
          lineNumber: lineIndex + 1, column: start + 1,
          matchStart: start, matchEnd: end, lineText,
        });
        totalMatches += 1;
        if (totalMatches >= maxTotal) {
          truncated = true;
          return false;
        }
        if (hit[0].length === 0) pattern.lastIndex += 1;
      }
    }
    // Yield so a racing cancel lands before the done event.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return true;
  };
  const walk = async (
    rootId: string,
    rootName: string,
    rootPath: string,
    absolute: string,
    relative: string,
    depth: number,
    out: StubMatch[],
  ): Promise<boolean> => {
    if (cancelled() || totalMatches >= maxTotal || depth > 16) return false;
    let entries;
    try {
      entries = await vfsList(absolute);
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (cancelled() || totalMatches >= maxTotal) return false;
      const childRel = relative ? `${relative}/${entry.name}` : entry.name;
      const childAbs = `${absolute.replace(/\/+$/, "")}/${entry.name}`;
      if (entry.fileType === "dir") {
        if (entry.name === ".git") continue;
        if (!(await walk(rootId, rootName, rootPath, childAbs, childRel, depth + 1, out))) return false;
        continue;
      }
      if (entry.fileType !== "file" || entry.size > 262144) continue;
      if (!stubSearchPathAllowed(childRel, includeGlobs, excludeGlobs)) continue;
      if (!(await harvestFile(rootId, rootName, rootPath, childRel, childAbs, out))) return false;
    }
    return true;
  };
  const all: StubMatch[] = [];
  for (const root of roots) {
    if (cancelled()) break;
    const rootPath = String(root.path ?? "");
    const normalized = rootPath.replace(/\\/g, "/");
    if (normalized !== VFS_ROOT && !normalized.startsWith(`${VFS_ROOT}/`)) {
      skippedRoots.push(rootPath);
      continue;
    }
    const out: StubMatch[] = [];
    const keepGoing = await walk(
      String(root.id ?? ""), String(root.name ?? ""), rootPath, normalized, "", 0, out,
    );
    if (out.length > 0) {
      emitSearch({
        searchId, kind: "batch", matches: out, truncated: false, cancelled: false,
        filesScanned, totalMatches, error: null,
      });
    }
    all.push(...out);
    if (!keepGoing) break;
  }
  if (cancelled()) {
    emitSearch({
      searchId, kind: "done", matches: [], truncated, cancelled: true,
      filesScanned, totalMatches: 0, error: null,
    });
    return;
  }
  const skippedNote = skippedRoots.length > 0
    ? ` Skipped ${skippedRoots.length} non-VFS root(s): browser preview cannot read host disk.`
    : null;
  if (skippedNote) {
    console.warn(`[tauri-stub] workspace search:${skippedNote}`);
  }
  emitSearch({
    searchId, kind: "done", matches: [], truncated, cancelled: false,
    filesScanned, totalMatches, error: null,
  });
}
