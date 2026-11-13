/** Local Windows and POSIX paths, without treating a Unix filename's backslash as a separator. */
function windowsPath(path: string) { return /^[a-z]:|^\\\\|^\/\//i.test(path); }
export function joinPath(base: string, name: string): string {
  if (!base) return name;
  if (base === "/") return `/${name}`;
  if (base.endsWith("/") || (windowsPath(base) && base.endsWith("\\"))) return `${base}${name}`;
  const separator = windowsPath(base) && (base.includes("\\") || /^[a-z]:$/i.test(base)) ? "\\" : "/";
  return `${base}${separator}${name}`;
}
export function parentPath(path: string): string {
  if (!path || path === "/") return path || "/";
  if (windowsPath(path)) {
    const separator = path.includes("\\") ? "\\" : "/";
    const clean = path.replace(/[\\/]+$/, "");
    const normalized = clean.replace(/\\/g, "/");
    if (/^[a-z]:$/i.test(normalized)) return `${clean}${separator}`;
    if (/^\/\/[^/]+\/[^/]+$/.test(normalized) || normalized === "") return clean || path;
    const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
    if (index === 2 && /^[a-z]:/i.test(clean)) return `${clean.slice(0, 2)}${separator}`;
    return index < 0 ? clean : clean.slice(0, index) || path;
  }
  const clean = path.replace(/\/+$/, "");
  const index = clean.lastIndexOf("/");
  return index <= 0 ? "/" : clean.slice(0, index);
}
export function basename(path: string): string {
  if (!path) return "";
  const clean = windowsPath(path) ? path.replace(/[\\/]+$/, "") : path.replace(/\/+$/, "");
  const index = windowsPath(path) ? Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) : clean.lastIndexOf("/");
  return index < 0 ? clean : clean.slice(index + 1);
}
