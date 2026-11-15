/** Preserve Unix spelling; match Explorer's Windows/UNC lexical identity. */
export function documentPathKey(path: string): string {
  if (/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(path)) {
    return path.replace(/^\\\\\?\\UNC\\/i, "//").replace(/^\\\\\?\\/, "")
      .replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return path.replace(/\/+$/, "") || "/";
}
