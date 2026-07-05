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

export function retainWorkspaceChangeKeys(current: Set<string>, valid: Set<string>): Set<string> {
  const next = new Set([...current].filter((key) => valid.has(key)));
  if (next.size !== current.size) return next;
  for (const key of next) {
    if (!current.has(key)) return next;
  }
  return current;
}

export function workspacePathsByRepoFromKeys(keys: string[]): Record<string, string[]> {
  const byRepo: Record<string, string[]> = {};
  for (const key of keys) {
    const parsed = parseWorkspaceChangeKey(key);
    if (!parsed) continue;
    (byRepo[parsed.repoRoot] ??= []).push(parsed.path);
  }
  return byRepo;
}
