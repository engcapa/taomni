/** Browser preview only: a VFS file-list clipboard, not the operating system's
 * native clipboard. Never persist stale file paths across preview sessions. */
let paths: string[] = [];
export function readFiles(): string[] { return [...paths]; }
export function writeFiles(next: string[]): void {
  if (!Array.isArray(next) || next.length > 256 || !next.every((path) => typeof path === "string" && path.startsWith("/") && !path.includes("\0"))) {
    throw new Error("Browser file clipboard expects at most 256 absolute VFS paths");
  }
  paths = [...new Set(next)];
}
export function clearFiles(): void { paths = []; }
