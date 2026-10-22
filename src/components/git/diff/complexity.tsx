import type { GitBlobPair } from "../../../lib/git";

export const MAX_AUTO_RENDER_CHARS = 300_000;

export const MAX_AUTO_RENDER_LINES = 12_000;


export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}


export function diffComplexity(pair: GitBlobPair): { tooLarge: boolean; maxLines: number } {
  const oldText = pair.oldText ?? "";
  const newText = pair.newText ?? "";
  const maxChars = Math.max(oldText.length, newText.length);
  const maxLines = Math.max(countLines(oldText), countLines(newText));
  return {
    tooLarge: maxChars > MAX_AUTO_RENDER_CHARS || maxLines > MAX_AUTO_RENDER_LINES,
    maxLines,
  };
}


export function countLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}


export function formatLines(n: number): string {
  return `${n.toLocaleString()} line${n === 1 ? "" : "s"}`;
}
