/**
 * Fuzzy scoring for Go to File style pickers.
 *
 * Ranking model (highest first): exact file name, file-name prefix,
 * camelCase/separator initials (e.g. `cwt` -> CodeWorkspaceTab.tsx),
 * file-name substring, path substring, path subsequence. Score 0 means
 * no match.
 */

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function isSeparator(char: string): boolean {
  return char === "-" || char === "_" || char === "." || char === " " || char === "/";
}

function isUpper(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

export function nameInitials(name: string): string {
  let initials = "";
  for (let i = 0; i < name.length; i += 1) {
    const char = name[i];
    if (isSeparator(char)) continue;
    const prev = i > 0 ? name[i - 1] : "";
    const boundary =
      i === 0 ||
      isSeparator(prev) ||
      (isUpper(char) && !isUpper(prev)) ||
      (isDigit(char) && !isDigit(prev));
    if (boundary) initials += char.toLowerCase();
  }
  return initials;
}

function isSubsequence(query: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

export function fuzzyScore(query: string, path: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const lowerPath = path.toLowerCase();
  const name = baseName(lowerPath);

  if (name === q) return 1000;
  if (name.startsWith(q)) return 900 - Math.min(100, name.length - q.length);
  if (nameInitials(baseName(path)).startsWith(q)) return 800;
  const nameIndex = name.indexOf(q);
  if (nameIndex >= 0) return 600 - Math.min(100, nameIndex);
  const pathIndex = lowerPath.indexOf(q);
  if (pathIndex >= 0) return 400 - Math.min(100, pathIndex);
  if (isSubsequence(q, lowerPath)) return 50;
  return 0;
}

export interface FuzzyRanked<T> {
  item: T;
  score: number;
}

export function rankFuzzy<T>(
  query: string,
  items: T[],
  pathOf: (item: T) => string,
  limit: number,
): T[] {
  const ranked: FuzzyRanked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, pathOf(item));
    if (score > 0) ranked.push({ item, score });
  }
  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const pathA = pathOf(a.item);
    const pathB = pathOf(b.item);
    if (pathA.length !== pathB.length) return pathA.length - pathB.length;
    return pathA.localeCompare(pathB);
  });
  return ranked.slice(0, limit).map((entry) => entry.item);
}
