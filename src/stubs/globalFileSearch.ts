import { validFileQuery, type GlobalFileMatch, type GlobalFileResults } from "../lib/explorer/globalFileSearch";
import { basenameOf, VFS_ROOT, visitVfsNames } from "./localVfs";

function matchRank(name: string, needle: string): number | undefined {
  const lower = name.toLowerCase();
  if (lower === needle) return 0;
  if (lower.startsWith(needle)) return 1;
  if (lower.includes(needle)) return 2;
  let offset = 0;
  for (const letter of needle) {
    const next = lower.indexOf(letter, offset);
    if (next < 0) return undefined;
    offset = next + letter.length;
  }
  return 3;
}

export async function searchVfsNames(query: string, cancelled: () => boolean): Promise<GlobalFileResults> {
  if (!validFileQuery(query)) throw new Error("invalid_query: Expected 2–96 characters");
  const needle = query.trim().toLowerCase();
  const matches: { rank: number; entry: GlobalFileMatch }[] = [];
  let truncated = false;
  let visited = 0;
  const start = performance.now();
  await visitVfsNames((path, isDirectory) => {
    if (cancelled()) return false;
    if (++visited > 16_000 || performance.now() - start > 1_000) {
      truncated = true;
      return false;
    }
    if (path === VFS_ROOT || path.split("/").some((part) => part.startsWith("."))) return true;
    const name = basenameOf(path);
    const rank = matchRank(name, needle);
    if (rank !== undefined) matches.push({ rank, entry: { name, path, isDirectory } });
    return true;
  });
  if (cancelled()) throw new Error("cancelled: File search stopped");
  matches.sort((a, b) => a.rank - b.rank || a.entry.name.localeCompare(b.entry.name) || a.entry.path.localeCompare(b.entry.path));
  return { entries: matches.slice(0, 100).map((item) => item.entry), provider: "boundedScan", scannedRoots: [VFS_ROOT], truncated: truncated || matches.length > 100 };
}
