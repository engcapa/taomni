export type WorkspaceTodoKind = "TODO" | "FIXME" | "XXX" | "HACK";

export interface WorkspaceTodoItem {
  key: string;
  fileKey: string;
  pathLabel: string;
  kind: WorkspaceTodoKind;
  line: number;
  character: number;
  text: string;
}

export interface WorkspaceBookmark {
  id: string;
  fileKey: string;
  pathLabel: string;
  line: number;
  character: number;
  label: string;
  createdAt: number;
}

const BOOKMARKS_PREFIX = "taomni.codeWorkspace.bookmarks.v1.";
const TODO_PATTERN = /\b(TODO|FIXME|XXX|HACK)\b(?:[:\s-]+(.*))?$/i;

export function scanTodosInText(
  fileKey: string,
  pathLabel: string,
  text: string,
): WorkspaceTodoItem[] {
  const lines = text.split("\n");
  const items: WorkspaceTodoItem[] = [];
  lines.forEach((lineText, index) => {
    const match = lineText.match(TODO_PATTERN);
    if (!match) return;
    const kind = match[1].toUpperCase() as WorkspaceTodoKind;
    const detail = (match[2] ?? "").trim();
    const character = Math.max(0, lineText.toUpperCase().indexOf(kind));
    items.push({
      key: `${fileKey}:${index}:${kind}`,
      fileKey,
      pathLabel,
      kind,
      line: index,
      character,
      text: detail || lineText.trim(),
    });
  });
  return items;
}

export function scanTodosInOpenFiles(
  files: Array<{ key: string; pathLabel: string; text: string }>,
): WorkspaceTodoItem[] {
  return files
    .flatMap((file) => scanTodosInText(file.key, file.pathLabel, file.text))
    .sort((left, right) => left.pathLabel.localeCompare(right.pathLabel)
      || left.line - right.line
      || left.character - right.character);
}

function bookmarksKey(workspaceInstanceId: string): string {
  return `${BOOKMARKS_PREFIX}${workspaceInstanceId}`;
}

export function readWorkspaceBookmarks(workspaceInstanceId: string): WorkspaceBookmark[] {
  if (!workspaceInstanceId || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(bookmarksKey(workspaceInstanceId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is WorkspaceBookmark => (
        !!item
        && typeof item === "object"
        && typeof item.id === "string"
        && typeof item.fileKey === "string"
        && typeof item.pathLabel === "string"
        && Number.isInteger(item.line)
        && item.line >= 0
        && Number.isInteger(item.character)
        && item.character >= 0
        && typeof item.label === "string"
        && typeof item.createdAt === "number"
      ))
      .slice(0, 200);
  } catch {
    return [];
  }
}

export function writeWorkspaceBookmarks(
  workspaceInstanceId: string,
  bookmarks: WorkspaceBookmark[],
): void {
  if (!workspaceInstanceId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(bookmarksKey(workspaceInstanceId), JSON.stringify(bookmarks.slice(0, 200)));
  } catch {
    // ignore storage failures
  }
}

export function toggleWorkspaceBookmark(
  workspaceInstanceId: string,
  candidate: Omit<WorkspaceBookmark, "id" | "createdAt">,
  current: WorkspaceBookmark[] = readWorkspaceBookmarks(workspaceInstanceId),
): WorkspaceBookmark[] {
  const existing = current.find((item) => (
    item.fileKey === candidate.fileKey && item.line === candidate.line
  ));
  const next = existing
    ? current.filter((item) => item.id !== existing.id)
    : [
        {
          id: `${candidate.fileKey}:${candidate.line}:${Date.now()}`,
          createdAt: Date.now(),
          ...candidate,
        },
        ...current,
      ].slice(0, 200);
  writeWorkspaceBookmarks(workspaceInstanceId, next);
  return next;
}
