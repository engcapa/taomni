export interface ExplorerCrumb { name: string; path: string }

/** Keep UNC shares and drive roots atomic instead of treating them as POSIX slashes. */
export function explorerCrumbs(path: string): ExplorerCrumb[] {
  if (!path) return [];
  const normalized = path.replace(/\\/g, "/");
  const unc = normalized.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
  if (unc) {
    const prefix = `\\\\${unc[1]}\\${unc[2]}`;
    let current = prefix;
    return [{ name: `\\\\${unc[1]}\\${unc[2]}`, path: prefix }, ...(unc[3] ?? "").split("/").filter(Boolean).map((name) => {
      current += `\\${name}`;
      return { name, path: current };
    })];
  }
  const drive = normalized.match(/^([a-z]:)(?:\/(.*))?$/i);
  if (drive) {
    const separator = path.includes("\\") ? "\\" : "/";
    let current = `${drive[1]}${separator}`;
    return [{ name: drive[1], path: current }, ...(drive[2] ?? "").split("/").filter(Boolean).map((name) => {
      current = `${current.replace(/[\\/]$/, "")}${separator}${name}`;
      return { name, path: current };
    })];
  }
  if (normalized === "//") return [{ name: "This PC", path: "\\\\" }];
  let current = "";
  return [{ name: "/", path: "/" }, ...normalized.split("/").filter(Boolean).map((name) => {
    current += `/${name}`;
    return { name, path: current };
  })];
}

export function sameExplorerPath(a: string, b: string) {
  const windows = /^[a-z]:|^[\\/]{2}/i.test(a) || /^[a-z]:|^[\\/]{2}/i.test(b);
  const key = (path: string) => {
    const clean = (windows ? path.replace(/\\/g, "/") : path).replace(/\/+$/, "") || "/";
    return windows ? clean.toLowerCase() : clean;
  };
  return key(a) === key(b);
}
