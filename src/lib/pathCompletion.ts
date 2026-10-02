import { effectiveFileType, type FileEntry } from "./sftp";

export interface PathCompletionQuery {
  directory: string;
  prefix: string;
  separator: string;
  windows: boolean;
}

export interface PathSuggestion {
  name: string;
  value: string;
}

export function cleanPathInput(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export function isWindowsPath(value: string): boolean {
  return /^[a-z]:/i.test(value) || value.includes("\\");
}

/** Resolve against the pane, never against the application's process cwd. */
export function resolvePathInput(value: string, currentPath: string, homePath?: string | null, windows = false): string {
  const cleaned = cleanPathInput(value);
  if (!cleaned) return currentPath;
  // Windows OpenSSH exposes drive roots as /C:/, while copied OS paths use
  // C:/ or C:\. Keep those absolute when resolving in that remote namespace.
  if (!windows && (/^\/[a-z]:(?:\/|$)/i.test(currentPath) || /^\/[a-z]:(?:\/|$)/i.test(homePath ?? "")) && /^[a-z]:[\\/]/i.test(cleaned)) {
    return `/${cleaned.replace(/\\/g, "/")}`;
  }
  if (cleaned === "~" || cleaned.startsWith("~/") || (windows && cleaned.startsWith("~\\"))) {
    return homePath ? `${homePath.replace(/[\\/]$/, "")}${cleaned.slice(1) || (windows ? "\\" : "/")}` : cleaned;
  }
  if (windows) {
    if (/^[a-z]:$/i.test(cleaned)) return `${cleaned}\\`;
    if (/^[a-z]:[\\/]/i.test(cleaned) || cleaned.startsWith("\\\\") || cleaned.startsWith("//")) return cleaned;
    if (/^[\\/]/.test(cleaned)) return `${currentPath.match(/^[a-z]:/i)?.[0] ?? ""}${cleaned}`;
    const sep = cleaned.includes("/") || (!currentPath.includes("\\") && currentPath.includes("/")) ? "/" : "\\";
    return `${currentPath.replace(/[\\/]$/, "")}${sep}${cleaned}`;
  }
  if (cleaned.startsWith("/")) return cleaned;
  return `${currentPath.replace(/\/$/, "")}/${cleaned}`;
}

export function pathCompletionQuery(value: string, currentPath: string, homePath?: string | null, detectWindows?: boolean): PathCompletionQuery {
  const windows = detectWindows ?? (isWindowsPath(value) || isWindowsPath(currentPath));
  const cleaned = cleanPathInput(value);
  const resolved = resolvePathInput(value, currentPath, homePath, windows);
  const separator = windows && !cleaned.includes("/") && (cleaned.includes("\\") || !currentPath.includes("/")) ? "\\" : "/";
  if (resolved === "\\\\") return { directory: resolved, prefix: "", separator: "\\", windows: true };
  if (!cleaned || cleaned === "~") {
    return { directory: resolved, prefix: "", separator, windows };
  }
  const index = windows ? Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\")) : resolved.lastIndexOf("/");
  return {
    directory: index < 0 ? currentPath : resolved.slice(0, index + 1),
    prefix: resolved.slice(index + 1),
    separator,
    windows,
  };
}

export function pathSuggestions(entries: FileEntry[], query: PathCompletionQuery, showHidden = false): PathSuggestion[] {
  const match = (name: string) => query.windows
    ? name.toLowerCase().startsWith(query.prefix.toLowerCase())
    : name.startsWith(query.prefix);
  return entries
    .filter((entry) => effectiveFileType(entry) === "dir" && entry.name !== "." && entry.name !== ".."
      && (showHidden || !entry.isHidden || query.prefix.startsWith(".")) && match(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((entry) => {
      const path = query.windows ? entry.path.replace(/[\\/]/g, query.separator) : entry.path;
      return { name: entry.name, value: path.endsWith(query.separator) ? path : `${path}${query.separator}` };
    });
}

export function commonPathPrefix(suggestions: PathSuggestion[], windows = false): string {
  if (!suggestions.length) return "";
  let prefix = suggestions[0].value;
  for (const suggestion of suggestions.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < suggestion.value.length
      && (windows ? prefix[i].toLowerCase() === suggestion.value[i].toLowerCase() : prefix[i] === suggestion.value[i])) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
