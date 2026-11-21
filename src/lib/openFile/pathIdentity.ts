export const UNTITLED_KEY_PREFIX = "untitled:";

export function isUntitledKey(path: string): boolean {
  return path.startsWith(UNTITLED_KEY_PREFIX);
}

/** Preserve untitled keys and Unix spelling; match Explorer's Windows/UNC lexical identity. */
export function documentPathKey(path: string): string {
  if (isUntitledKey(path)) return path;
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path)) {
    return path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "")
      .replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return path.replace(/\/+$/, "") || "/";
}
