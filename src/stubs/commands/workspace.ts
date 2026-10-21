import { vfsList, vfsStat, vfsMkdir, vfsRemove, vfsRename, vfsReadText, vfsWriteText, vfsReadBytes, vfsWriteBytes, VFS_ROOT } from "../localVfs";
import { emit } from "../tauri-event";
import { parity005Enabled, parity005Root } from "../parity005Completion";
import { parity009Cancel, parity009Capabilities, parity009Run } from "../parity009StructuralSearch";
import { parity007Enabled, parity007Root, parity007WriteFailure } from "../parity007Extract";

export function joinWorkspacePath(repoRoot: string, relative = ""): string {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  const clean = relative.replace(/^\/+/, "").replace(/\\/g, "/");
  return clean ? `${root}/${clean}` : root;
}

export function relativeWorkspacePath(repoRoot: string, path: string): string {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  const normalized = path.replace(/\\/g, "/");
  return normalized === root ? "" : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

export function parentWorkspacePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const separator = normalized.lastIndexOf("/");
  return separator > 0 ? normalized.slice(0, separator) : separator === 0 ? "/" : null;
}

export function assertWorkspaceWritablePath(path: string): void {
  if (path.split(/[\\/]+/).includes(".git")) {
    throw new Error("Writing inside .git is not allowed");
  }
}

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
  roots: Array<{ id?: unknown; name?: unknown; path?: unknown }>,
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

export type StubWorkspaceResourceOperation =
  | {
    kind: "create";
    path: string;
    overwrite: boolean;
    ignoreIfExists: boolean;
  }
  | {
    kind: "rename";
    fromPath: string;
    toPath: string;
    toRepoRoot?: string;
    overwrite: boolean;
    ignoreIfExists: boolean;
  }
  | {
    kind: "delete";
    path: string;
    recursive: boolean;
    ignoreIfNotExists: boolean;
  };

export async function workspaceResourceVfsEntry(path: string): Promise<Awaited<ReturnType<typeof vfsStat>> | null> {
  try {
    return await vfsStat(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not found:")) return null;
    throw error;
  }
}

export async function applyStubWorkspaceResourceOperation(
  repoRoot: string,
  operation: StubWorkspaceResourceOperation,
): Promise<{ ignored: boolean }> {
  const root = (repoRoot || VFS_ROOT).replace(/\/+$/, "") || VFS_ROOT;
  if (operation.kind === "create") {
    assertWorkspaceWritablePath(operation.path);
    const target = joinWorkspacePath(root, operation.path);
    const existing = await workspaceResourceVfsEntry(target);
    if (existing) {
      if (operation.overwrite) {
        if (existing.fileType === "dir") {
          throw new Error(`CreateFile cannot overwrite directory: ${target}`);
        }
        await vfsRemove(target, false);
        await vfsWriteText(target, "");
      } else if (operation.ignoreIfExists) {
        return { ignored: true };
      } else {
        throw new Error(`Path already exists: ${target}`);
      }
    } else {
      await vfsWriteText(target, "");
    }
    return { ignored: false };
  }

  if (operation.kind === "delete") {
    assertWorkspaceWritablePath(operation.path);
    const target = joinWorkspacePath(root, operation.path);
    if (relativeWorkspacePath(root, target) === "") {
      throw new Error("Cannot delete the workspace root");
    }
    if (!(await workspaceResourceVfsEntry(target))) {
      if (operation.ignoreIfNotExists) return { ignored: true };
      throw new Error(`Path does not exist: ${target}`);
    }
    await vfsRemove(target, operation.recursive);
    return { ignored: false };
  }

  assertWorkspaceWritablePath(operation.fromPath);
  assertWorkspaceWritablePath(operation.toPath);
  const from = joinWorkspacePath(root, operation.fromPath);
  const destinationRoot = (operation.toRepoRoot || root).replace(/\/+$/, "") || VFS_ROOT;
  const to = joinWorkspacePath(destinationRoot, operation.toPath);
  const sourceEntry = await workspaceResourceVfsEntry(from);
  if (!sourceEntry) throw new Error(`Path does not exist: ${from}`);
  if (from === to) return { ignored: true };
  if (sourceEntry.fileType === "dir" && to.startsWith(`${from}/`)) {
    throw new Error(`Cannot move directory ${from} inside itself`);
  }
  const destinationEntry = await workspaceResourceVfsEntry(to);
  if (destinationEntry) {
    if (operation.overwrite) {
      await vfsRemove(to, true);
    } else if (operation.ignoreIfExists) {
      return { ignored: true };
    } else {
      throw new Error(`Path already exists: ${to}`);
    }
  }
  const destinationParent = parentWorkspacePath(to);
  if (destinationParent && !(await workspaceResourceVfsEntry(destinationParent))) {
    throw new Error(`Parent does not exist: ${destinationParent}`);
  }
  await vfsRename(from, to);
  return { ignored: false };
}

export async function workspaceEntryFromVfs(repoRoot: string, path: string) {
  const entry = await vfsStat(path);
  return {
    name: entry.name,
    path: relativeWorkspacePath(repoRoot, entry.path),
    fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
    size: entry.size,
    mtime: entry.mtime,
    isHidden: entry.isHidden,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizedStubEncoding(label: string): string {
  return label.trim().replace(/_/g, "-").toLowerCase();
}

export function decodeStubBytes(raw: Uint8Array, label: string): { text: string; bom: boolean; encoding: string } {
  const normalized = normalizedStubEncoding(label);
  let bytes = raw;
  let bom = false;
  if (normalized === "utf-8" && bytes.length >= 3
    && bytes.slice(0, 3).every((byte, index) => byte === [0xef, 0xbb, 0xbf][index])) {
    bytes = bytes.slice(3);
    bom = true;
  } else if (normalized === "utf-16le" && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bytes = bytes.slice(2);
    bom = true;
  } else if (normalized === "utf-16be" && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bytes = bytes.slice(2);
    bom = true;
  }
  const decoderLabel = normalized === "gbk" ? "gbk" : normalized;
  let text: string;
  try {
    text = new TextDecoder(decoderLabel, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Browser preview cannot decode ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { text, bom, encoding: label.trim() || "UTF-8" };
}

export function encodeStubText(text: string, label: string, bom: boolean): Uint8Array {
  const normalized = normalizedStubEncoding(label);
  let bytes: Uint8Array;
  if (normalized === "utf-8") {
    bytes = new TextEncoder().encode(text);
  } else if (normalized === "utf-16le" || normalized === "utf-16be") {
    const output = new Uint8Array(text.length * 2);
    let offset = 0;
    for (const unit of text) {
      const codePoint = unit.codePointAt(0)!;
      const units = codePoint > 0xffff
        ? [0xd800 + ((codePoint - 0x10000) >> 10), 0xdc00 + ((codePoint - 0x10000) & 0x3ff)]
        : [codePoint];
      for (const value of units) {
        if (normalized === "utf-16le") {
          output[offset++] = value & 0xff;
          output[offset++] = value >> 8;
        } else {
          output[offset++] = value >> 8;
          output[offset++] = value & 0xff;
        }
      }
    }
    bytes = output.slice(0, offset);
  } else {
    throw new Error(`Browser preview cannot encode ${label}; use the desktop app for legacy charsets`);
  }
  if (!bom) return bytes;
  const marker = normalized === "utf-8"
    ? [0xef, 0xbb, 0xbf]
    : normalized === "utf-16le" ? [0xff, 0xfe] : [0xfe, 0xff];
  const result = new Uint8Array(marker.length + bytes.length);
  result.set(marker);
  result.set(bytes, marker.length);
  return result;
}

export async function readStubWorkspaceEncodedFile(
  path: string,
  repoRoot: string | null,
  encoding: string,
): Promise<{ filePath: string; bytes: Uint8Array; text: string; bom: boolean; encoding: string; entry: Awaited<ReturnType<typeof vfsStat>> }> {
  const target = repoRoot ? joinWorkspacePath(repoRoot, path) : path;
  const [entry, arrayBuffer] = await Promise.all([vfsStat(target), vfsReadBytes(target)]);
  const bytes = new Uint8Array(arrayBuffer);
  const decoded = decodeStubBytes(bytes, encoding);
  return {
    filePath: repoRoot ? relativeWorkspacePath(repoRoot, entry.path) : entry.path,
    bytes,
    text: decoded.text,
    bom: decoded.bom,
    encoding: decoded.encoding,
    entry,
  };
}

export async function invokeWorkspace<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "structural_search_capabilities":
      return parity009Capabilities() as T;

    case "structural_search_run":
      return await parity009Run(args?.request) as T;

    case "structural_search_cancel":
      return parity009Cancel((args?.requestId as string) ?? "") as T;

    case "workspace_ingest_maven_project": {
      const workspaceRoot = String((args?.request as { workspaceRoot?: string } | undefined)?.workspaceRoot ?? "");
      if (parity005Enabled() && workspaceRoot === parity005Root) {
        return {
          status: "ready",
          modules: [{
            id: "parity005:completion", name: "completion", root: parity005Root,
            pomPath: `${parity005Root}/pom.xml`,
            sourceRoots: [`${parity005Root}/src/main/java`], testRoots: [], resourceRoots: [],
            outputDir: null, dependencies: ["org.apache.commons:commons-lang3:3.12.0"],
            classpath: ["commons-lang3-3.12.0.jar"],
          }],
          provenance: {
            toolKind: "qa-fixture", toolVersion: null, javaHome: null, javaVersion: null,
            argv: [], cwd: parity005Root, pomHash: "B-005", resolvedAt: new Date().toISOString(),
          },
          errorMessage: null,
        } as T;
      }
      if (parity007Enabled() && workspaceRoot === parity007Root) {
        return {
          status: "ready",
          modules: [{
            id: "parity007:extract", name: "extract", root: parity007Root,
            pomPath: `${parity007Root}/pom.xml`,
            sourceRoots: [`${parity007Root}/src/main/java`], testRoots: [], resourceRoots: [],
            outputDir: null, dependencies: [],
            classpath: [],
          }],
          provenance: {
            toolKind: "qa-fixture", toolVersion: null, javaHome: null, javaVersion: null,
            argv: [], cwd: parity007Root, pomHash: "B-007", resolvedAt: new Date().toISOString(),
          },
          errorMessage: null,
        } as T;
      }
      // No build backend exists in the browser preview. Return no usable
      // result instead of a well-formed failed response so the store's typed
      // prerequisite failure (ED-PROJECT-005 A4) names the missing backend
      // exactly as the desktop build does when no Maven tooling is present.
      return undefined as T;
    }

    case "workspace_list_dir": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = (args?.path as string) || "";
      const target = joinWorkspacePath(repoRoot, path);
      const entries = await vfsList(target);
      return entries.map((entry) => ({
        name: entry.name,
        path: relativeWorkspacePath(repoRoot, entry.path),
        fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
        size: entry.size,
        mtime: entry.mtime,
        isHidden: entry.isHidden,
      })) as T;
    }

    case "workspace_compact_chain": {
      // Mirror the native walk: descend while a directory holds exactly one
      // child directory, up to maxDepth; report the final path's entries.
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = (args?.path as string) || "";
      const maxDepth = (args?.maxDepth as number | null) ?? 16;
      let current = joinWorkspacePath(repoRoot, path);
      let currentRel = path;
      for (let depth = 0; depth < maxDepth; depth++) {
        const entries = await vfsList(current);
        const mapped = entries.map((entry) => ({
          name: entry.name,
          path: relativeWorkspacePath(repoRoot, entry.path),
          fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
          size: entry.size,
          mtime: entry.mtime,
          isHidden: entry.isHidden,
        }));
        if (mapped.length !== 1 || mapped[0].fileType !== "dir") {
          return { path: currentRel, entries: mapped } as T;
        }
        current = joinWorkspacePath(current, mapped[0].name);
        currentRel = mapped[0].path;
      }
      const finalEntries = await vfsList(current);
      return {
        path: currentRel,
        entries: finalEntries.map((entry) => ({
          name: entry.name,
          path: relativeWorkspacePath(repoRoot, entry.path),
          fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
          size: entry.size,
          mtime: entry.mtime,
          isHidden: entry.isHidden,
        })),
      } as T;
    }

    case "workspace_list_files_recursive": {
      // Mirror collect_workspace_files: files only (dirs recursed, not
      // emitted), .git skipped, depth/file capped, sorted case-insensitively.
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const maxDepth = (args?.maxDepth as number | null) ?? 16;
      const maxFiles = (args?.maxFiles as number | null) ?? 2000;
      const out: Array<{
        name: string;
        path: string;
        fileType: "dir" | "file" | "other";
        size: number;
        mtime: number;
        isHidden: boolean;
      }> = [];
      const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (depth > maxDepth || out.length >= maxFiles) return;
        const entries = await vfsList(dir);
        for (const entry of entries) {
          if (entry.name === ".git" || entry.path.startsWith(".git/")) continue;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.fileType === "file") {
            out.push({
              name: entry.name,
              path: childRel,
              fileType: "file",
              size: entry.size,
              mtime: entry.mtime,
              isHidden: entry.isHidden,
            });
            if (out.length >= maxFiles) return;
          } else if (entry.fileType === "dir" && depth < maxDepth) {
            await walk(joinWorkspacePath(dir, entry.name), childRel, depth + 1);
            if (out.length >= maxFiles) return;
          }
        }
      };
      await walk(joinWorkspacePath(repoRoot, (args?.path as string) || ""), "", 0);
      out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
      return out as T;
    }

    case "workspace_read_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      const target = joinWorkspacePath(repoRoot, path);
      const [entry, text] = await Promise.all([vfsStat(target), vfsReadText(target)]);
      const bom = text.startsWith("\uFEFF");
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: bom ? text.slice(1) : text,
        encoding: "UTF-8",
        bom,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(text),
      } as T;
    }

    case "workspace_detect_git_roots": {
      // The in-memory VFS has no .git directories; report no repos so
      // useWorkspaceGitSnapshots keeps an empty (never undefined) list.
      return [] as unknown as T;
    }

    case "workspace_read_loose_file": {
      const path = args?.path as string;
      const [entry, text] = await Promise.all([vfsStat(path), vfsReadText(path)]);
      const bom = text.startsWith("\uFEFF");
      return {
        path: entry.path,
        text: bom ? text.slice(1) : text,
        encoding: "UTF-8",
        bom,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(text),
      } as T;
    }

    case "workspace_read_file_with_encoding": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      const encoding = (args?.encoding as string) || "UTF-8";
      const file = await readStubWorkspaceEncodedFile(path, repoRoot, encoding);
      return {
        path: file.filePath,
        text: file.text,
        encoding: file.encoding,
        bom: file.bom,
        size: file.entry.size,
        mtime: file.entry.mtime,
        hash: await sha256Bytes(file.bytes),
      } as T;
    }

    case "workspace_read_loose_file_with_encoding": {
      const path = args?.path as string;
      const encoding = (args?.encoding as string) || "UTF-8";
      const file = await readStubWorkspaceEncodedFile(path, null, encoding);
      return {
        path: file.filePath,
        text: file.text,
        encoding: file.encoding,
        bom: file.bom,
        size: file.entry.size,
        mtime: file.entry.mtime,
        hash: await sha256Bytes(file.bytes),
      } as T;
    }

    case "workspace_write_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      if (expectedHash) {
        const current = await vfsReadText(target);
        const currentHash = await sha256Hex(current);
        if (currentHash !== expectedHash) {
          throw new Error(`hash-mismatch: File changed on disk; expected hash ${expectedHash}, found ${currentHash}`);
        }
      }
      const contents = (args?.contents as string) ?? "";
      await vfsWriteText(target, contents);
      const entry = await vfsStat(target);
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: contents.startsWith("\uFEFF") ? contents.slice(1) : contents,
        encoding: "UTF-8",
        bom: contents.startsWith("\uFEFF"),
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }

    case "workspace_write_loose_file": {
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      if (expectedHash) {
        const current = await vfsReadText(path);
        const currentHash = await sha256Hex(current);
        if (currentHash !== expectedHash) {
          throw new Error(`hash-mismatch: File changed on disk; expected hash ${expectedHash}, found ${currentHash}`);
        }
      }
      const contents = (args?.contents as string) ?? "";
      await vfsWriteText(path, contents);
      const entry = await vfsStat(path);
      return {
        path: entry.path,
        text: contents.startsWith("\uFEFF") ? contents.slice(1) : contents,
        encoding: "UTF-8",
        bom: contents.startsWith("\uFEFF"),
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }

    case "workspace_search_start": {
      // Browser-preview workspace search (ED-FIND-003): synchronous VFS grep
      // over roots inside the VFS jail. Proves panel routing, scope/mask
      // planning, preview, and cancel in browser mode; the native ripgrep
      // backend remains the production search path. Roots outside the VFS
      // are skipped (the browser cannot read host disk).
      const searchId = (args?.searchId as string) || "";
      const roots = (Array.isArray(args?.roots) ? args?.roots : []) as Array<{
        id?: unknown;
        name?: unknown;
        path?: unknown;
      }>;
      const query = (args?.query as string) ?? "";
      const options = (args?.options as Record<string, unknown> | null) ?? {};
      const cancelled = stubSearchCancelled(searchId);
      const emitSearch = (payload: Record<string, unknown>) => {
        if (cancelled()) return;
        void emit(`workspace-search-${searchId}`, payload);
      };
      void stubWorkspaceSearch(searchId, roots, query, options, cancelled, emitSearch);
      return searchId as T;
    }

    case "workspace_search_cancel": {
      stubSearchCancelIds.add((args?.searchId as string) || "");
      return true as T;
    }

    case "workspace_write_file_encoded":

    case "workspace_write_loose_file_encoded": {
      const isRoot = cmd === "workspace_write_file_encoded";
      const repoRoot = isRoot ? ((args?.repoRoot as string) || VFS_ROOT) : null;
      const path = args?.path as string;
      const target = repoRoot ? joinWorkspacePath(repoRoot, path) : path;
      assertWorkspaceWritablePath(path);
      // ED-PARITY-007 controlled write failure for the isolated fixture only.
      if (isRoot && parity007Enabled(target) && parity007WriteFailure(target)) {
        throw new Error("B-007 controlled write failure: the workspace file could not be written");
      }
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      const currentBytes = new Uint8Array(await vfsReadBytes(target));
      const oldHash = await sha256Bytes(currentBytes);
      if (expectedHash) {
        if (oldHash !== expectedHash) {
          throw new Error(`hash-mismatch: File changed on disk; expected hash ${expectedHash}, found ${oldHash}`);
        }
      }
      const encoding = (args?.encoding as string) || "UTF-8";
      const bytes = encodeStubText((args?.contents as string) ?? "", encoding, !!args?.bom);
      const writtenHash = await sha256Bytes(bytes);
      const storedBytes = new Uint8Array(bytes.byteLength);
      storedBytes.set(bytes);
      await vfsWriteBytes(target, storedBytes.buffer);
      const entry = await vfsStat(target);
      const decoded = decodeStubBytes(bytes, encoding);
      return {
        file: {
          path: repoRoot ? relativeWorkspacePath(repoRoot, entry.path) : entry.path,
          text: decoded.text,
          encoding: decoded.encoding,
          bom: decoded.bom,
          size: entry.size,
          mtime: entry.mtime,
          hash: writtenHash,
        },
        writtenHash,
        writtenByteLength: bytes.byteLength,
        intentHash: writtenHash,
        oldHash,
        atomicReplaceUsed: false,
      } as T;
    }

    case "workspace_create_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      await vfsStat(target)
        .then(() => {
          throw new Error(`Path already exists: ${target}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      const contents = (args?.contents as string | null | undefined) ?? "";
      await vfsWriteText(target, contents);
      const entry = await vfsStat(target);
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: contents.startsWith("\uFEFF") ? contents.slice(1) : contents,
        encoding: "UTF-8",
        bom: contents.startsWith("\uFEFF"),
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }

    case "workspace_create_dir": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      await vfsStat(target)
        .then(() => {
          throw new Error(`Path already exists: ${target}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      await vfsMkdir(target);
      return await workspaceEntryFromVfs(repoRoot, target) as T;
    }

    case "workspace_delete_path": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      if (relativeWorkspacePath(repoRoot, target) === "") {
        throw new Error("Cannot delete the workspace root");
      }
      await vfsRemove(target, !!args?.recursive);
      return undefined as T;
    }

    case "workspace_rename_path": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const fromPath = args?.fromPath as string;
      const toPath = args?.toPath as string;
      assertWorkspaceWritablePath(fromPath);
      assertWorkspaceWritablePath(toPath);
      const from = joinWorkspacePath(repoRoot, fromPath);
      const to = joinWorkspacePath(repoRoot, toPath);
      await vfsStat(to)
        .then(() => {
          throw new Error(`Path already exists: ${to}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      await vfsRename(from, to);
      return await workspaceEntryFromVfs(repoRoot, to) as T;
    }

    case "workspace_apply_resource_operation": {
      return await applyStubWorkspaceResourceOperation(
        (args?.repoRoot as string) || VFS_ROOT,
        args?.operation as StubWorkspaceResourceOperation,
      ) as T;
    }

    case "workspace_detect_tasks": {
      return [] as T;
    }

    case "workspace_java_run_targets": {
      return [] as T;
    }

    case "workspace_task_tree": {
      return [] as T;
    }

    case "workspace_dependency_tree": {
      return [] as T;
    }

    case "workspace_execution_model": {
      return {
        projects: [],
        buildTargets: [],
        runConfigurations: [],
        debugConfigurations: [],
        tools: [],
        diagnostics: [],
      } as T;
    }

    case "workspace_test_results": {
      // Browser preview has no desktop filesystem or JVM process. Keep the
      // structured protocol shape so TestsPanel can render an honest empty
      // result state without pretending that tests were executed.
      return {
        schema: "taomni.codeWorkspace.testResults",
        version: 1,
        source: "junit-xml",
        generatedAt: Date.now(),
        results: [],
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          errors: 0,
          durationMs: 0,
        },
        diagnostics: ["Structured test results are available only in the Taomni desktop app"],
      } as T;
    }
    default: throw new Error(`Unhandled workspace stub command: ${cmd}`);
  }
}
