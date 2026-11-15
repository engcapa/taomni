export interface FilePathLink { path: string; line?: number; }

/** Explicit local file paths only: never turn a URL, shell command or prose into a file. */
export function parseFilePathLink(value: string, cwd?: string | null): FilePathLink | null {
  const quoted = /^([`"'])(.*)\1$/.test(value.trim());
  let text = value.trim().replace(/^([`"'])(.*)\1$/, "$2");
  if (!text || /[\r\n\0]/.test(text)) return null;
  if (/^file:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.username || url.password || url.search) return null;
      if (url.hostname && url.hostname !== "localhost") return null;
      text = decodeURIComponent(url.pathname) + url.hash;
      if (/^\/[a-z]:\//i.test(text)) text = text.slice(1);
    } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return null;
  const location = /:(\d+)(?::\d+)?$/.exec(text) ?? /#L(\d+)(?:C\d+)?$/i.exec(text);
  const line = location ? Number(location[1]) : undefined;
  if (location) text = text.slice(0, location.index);
  const absolute = /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(text);
  // A filename must have an extension; directories keep their reveal/navigation contract.
  if (!/[^\\/]+\.[a-z0-9_+-]{1,16}$/i.test(text) || /[<>|"`]/.test(text)) return null;
  if (!absolute && (!cwd || /^[-~]/.test(text) || /\s/.test(text) && !quoted)) return null;
  if (!absolute) text = `${cwd!.replace(/[\\/]+$/, "")}/${text}`;
  const normalized = text.replace(/\\/g, "/");
  const prefix = normalized.startsWith("//") ? "//" : normalized.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length || /^[a-z]:$/i.test(parts.at(-1)!)) return null;
      parts.pop();
    } else parts.push(part);
  }
  return { path: prefix + parts.join("/"), ...(line && Number.isSafeInteger(line) ? { line } : {}) };
}

export function findFilePathLinks(text: string, cwd?: string | null): Array<FilePathLink & { start: number; end: number; text: string }> {
  const result: Array<FilePathLink & { start: number; end: number; text: string }> = [];
  const tokens = /"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|[^\s<>"'`()\[\]{},;]+/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0].replace(/[.)]+$/, "");
    const link = parseFilePathLink(token, cwd);
    if (link) result.push({ ...link, start: match.index!, end: match.index! + token.length, text: token });
  }
  return result;
}
