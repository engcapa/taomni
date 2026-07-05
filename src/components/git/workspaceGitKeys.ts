const WORKSPACE_CHANGE_KEY_SEPARATOR = "\0";

export function workspaceChangeKey(repoRoot: string, path: string): string {
  return `${repoRoot}${WORKSPACE_CHANGE_KEY_SEPARATOR}${path}`;
}

export function parseWorkspaceChangeKey(key: string): { repoRoot: string; path: string } | null {
  const index = key.indexOf(WORKSPACE_CHANGE_KEY_SEPARATOR);
  if (index === -1) return null;
  return {
    repoRoot: key.slice(0, index),
    path: key.slice(index + WORKSPACE_CHANGE_KEY_SEPARATOR.length),
  };
}
