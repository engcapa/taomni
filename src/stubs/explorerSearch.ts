import type { ExplorerSearchEntry, ExplorerSearchResults, OperationFailure } from "../lib/explorer";
import { vfsList, vfsStat } from "./localVfs";
import { emit } from "./tauri-event";

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|\\]/g, "\\$&");
}

export function explorerGlobRegex(query: string): RegExp | null {
  const normalized = query.trim().replace(/\\/g, "/");
  if (!/[*?\[]/.test(normalized) && !normalized.includes("/")) return null;
  let source = "^";
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index++;
        if (normalized[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += "[^/]*";
    } else if (character === "?") source += "[^/]";
    else if (character === "[") {
      const end = normalized.indexOf("]", index + 1);
      if (end < 0) throw new Error("invalid_query: Unclosed character class");
      const content = normalized.slice(index + 1, end);
      if (!content) throw new Error("invalid_query: Empty character class");
      source += `[${content.startsWith("!") ? `^${escapeRegex(content.slice(1))}` : content.replace(/\\/g, "\\\\")}]`;
      index = end;
    } else source += escapeRegex(character);
  }
  return new RegExp(`${source}$`, "i");
}

class Cancelled extends Error {}

export async function searchVfs(root: string, query: string, recursive: boolean, includeHidden: boolean, operationId: string, isCancelled: () => boolean): Promise<ExplorerSearchResults> {
  const normalizedRoot = (await vfsStat(root)).path;
  const glob = explorerGlobRegex(query);
  const pathGlob = query.replace(/\\/g, "/").includes("/");
  const plain = query.trim().toLowerCase();
  const entries: ExplorerSearchEntry[] = [];
  const failed: OperationFailure[] = [];
  const result: ExplorerSearchResults = { entries, scanned: 0, truncated: false, cancelled: false, failed };
  const delay = Math.max(0, Math.min(250, Number(localStorage.getItem("taomni.explorer.stubSearchDelayMs")) || 0));
  const check = async () => {
    if (isCancelled()) throw new Cancelled();
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (isCancelled()) throw new Cancelled();
  };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await vfsList(directory, true)) {
      await check();
      const relativePath = entry.path.slice(normalizedRoot.length).replace(/^\//, "");
      if (entry.isHidden && !includeHidden) continue;
      result.scanned++;
      if (result.scanned % 100 === 0) await emit("explorer:progress", { operationId, items: result.scanned, bytes: 0, path: entry.path });
      const matches = glob
        ? glob.test(pathGlob ? relativePath : entry.name)
        : entry.name.toLowerCase().includes(plain) || relativePath.toLowerCase().includes(plain);
      if (matches) entries.push({ ...entry, relativePath });
      if (entries.length >= 1000) {
        result.truncated = true;
        return;
      }
      if (recursive && entry.fileType === "dir") await walk(entry.path);
      if (result.truncated) return;
    }
  };
  try {
    await walk(normalizedRoot);
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    result.cancelled = true;
  }
  return result;
}
