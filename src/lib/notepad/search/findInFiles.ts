import { invoke } from "@tauri-apps/api/core";
import {
  newWorkspaceSearchId,
  subscribeWorkspaceSearch,
  workspaceSearchCancel,
  workspaceSearchStart,
  type WorkspaceSearchMatch,
} from "../../editor/workspaceSearch";
import type { NotepadSearchResultHit } from "../../../stores/notepadStore";
import { hasCatastrophicBacktrackingRisk, replaceAllInText } from "./engine";
import type { NotepadSearchMode } from "../transforms/escape";

export interface FindInFilesOptions {
  directory: string;
  query: string;
  filter: string;
  mode: NotepadSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  dotAll: boolean;
}

export interface FindInFilesResult {
  searchId: string;
  hits: NotepadSearchResultHit[];
  filesScanned: number;
  truncated: boolean;
  cancelled: boolean;
  error?: string;
}

function parseGlobFilters(raw: string): string[] {
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*.*" && s !== "*");
}

function toNotepadHit(m: WorkspaceSearchMatch): NotepadSearchResultHit {
  const name = m.path.split(/[\\/]/).pop() || m.path;
  return {
    filePath: m.path,
    name,
    line: Math.max(0, m.lineNumber - 1),
    column: Math.max(0, m.column - 1),
    from: m.matchStart,
    to: m.matchEnd,
    lineText: m.lineText,
    matchLength: Math.max(0, m.matchEnd - m.matchStart),
  };
}

let activeSearchId: string | null = null;

export async function cancelActiveFindInFiles(): Promise<void> {
  if (!activeSearchId) return;
  const id = activeSearchId;
  activeSearchId = null;
  await workspaceSearchCancel(id).catch(() => false);
}

export async function runFindInFiles(
  opts: FindInFilesOptions,
  onProgress?: (hits: NotepadSearchResultHit[], filesScanned: number) => void,
): Promise<FindInFilesResult> {
  if (!opts.directory.trim()) {
    return {
      searchId: "",
      hits: [],
      filesScanned: 0,
      truncated: false,
      cancelled: false,
      error: "Please specify a search folder.",
    };
  }
  if (opts.mode === "re" && hasCatastrophicBacktrackingRisk(opts.query)) {
    return {
      searchId: "",
      hits: [],
      filesScanned: 0,
      truncated: false,
      cancelled: false,
      error: "Regular expression rejected: nested quantifiers may cause catastrophic backtracking.",
    };
  }

  await cancelActiveFindInFiles();
  const searchId = newWorkspaceSearchId();
  activeSearchId = searchId;
  const hits: NotepadSearchResultHit[] = [];

  return await new Promise<FindInFilesResult>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;

    const finish = (result: FindInFilesResult) => {
      if (settled) return;
      settled = true;
      if (activeSearchId === searchId) activeSearchId = null;
      unlisten?.();
      resolve(result);
    };

    subscribeWorkspaceSearch(searchId, (ev) => {
      if (ev.matches.length > 0) {
        for (const m of ev.matches) hits.push(toNotepadHit(m));
        onProgress?.([...hits], ev.filesScanned);
      }
      if (ev.kind === "done" || ev.kind === "error") {
        finish({
          searchId,
          hits,
          filesScanned: ev.filesScanned,
          truncated: ev.truncated,
          cancelled: ev.cancelled,
          error: ev.error ?? undefined,
        });
      }
    })
      .then((fn) => {
        unlisten = fn;
        const effectiveQuery =
          opts.mode === "ext"
            ? opts.query.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\")
            : opts.query;
        return workspaceSearchStart(
          searchId,
          [{ id: "notepad-dir", name: opts.directory, path: opts.directory }],
          effectiveQuery,
          {
            caseSensitive: opts.caseSensitive,
            wholeWord: opts.wholeWord,
            regexp: opts.mode === "re",
            includeGlobs: parseGlobFilters(opts.filter),
            maxTotalMatches: 5000,
          },
        );
      })
      .catch((err) => {
        finish({
          searchId,
          hits,
          filesScanned: 0,
          truncated: false,
          cancelled: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  });
}

export async function replaceInDiskFiles(
  paths: string[],
  opts: Omit<FindInFilesOptions, "directory" | "filter"> & { replace: string },
): Promise<{ updatedFiles: number; totalReplacements: number; errors: string[] }> {
  let updatedFiles = 0;
  let totalReplacements = 0;
  const errors: string[] = [];

  for (const path of [...new Set(paths)]) {
    try {
      const read = await invoke<{ content: string; hash: string; encoding: string; bom: boolean; eol: string; truncated: boolean }>(
        "viewer_read_text",
        { path },
      );
      if (read.truncated) {
        errors.push(`${path}: skipped file larger than chunked preview limit`);
        continue;
      }
      const next = replaceAllInText(read.content, {
        ...opts,
        wrapAround: false,
        backward: false,
        inSelection: false,
      });
      if (next.error) {
        errors.push(`${path}: ${next.error}`);
        continue;
      }
      if (next.count > 0 && next.text !== read.content) {
        await invoke("viewer_write_text", {
          path,
          content: next.text,
          expectedHash: read.hash,
          encoding: read.encoding,
          bom: read.bom,
          eol: read.eol,
        });
        updatedFiles += 1;
        totalReplacements += next.count;
      }
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { updatedFiles, totalReplacements, errors };
}
