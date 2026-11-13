/** Normalize dot components before listing so operation paths never retain '..'. */
export function normalizeExplorerInput(path: string): string {
  const windows = /^[a-z]:|^[\\/]{2}/i.test(path);
  const separator = windows && path.includes("\\") ? "\\" : "/";
  const normalized = windows ? path.replace(/\\/g, "/") : path;
  const unc = normalized.match(/^\/\/[^/]+\/[^/]+/);
  const drive = normalized.match(/^[a-z]:\//i);
  const root = unc ? unc[0] : drive ? drive[0] : normalized.startsWith("/") ? "/" : "";
  if (!root) return path;
  const tail = normalized.slice(root.length).split("/");
  const parts: string[] = [];
  for (const part of tail) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  const result = root.replace(/\/$/, "") + (parts.length ? "/" + parts.join("/") : "");
  if (!result) return "/";
  if (/^[a-z]:$/i.test(result)) return `${result}${separator}`;
  return windows ? result.replace(/\//g, separator) : result;
}
