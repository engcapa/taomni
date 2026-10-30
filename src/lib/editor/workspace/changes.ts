/** Successful filesystem mutations, shared by workspace consumers in this window. */
export interface WorkspaceFileChange {
  paths: string[];
}

const changes = new EventTarget();

export function workspaceChangePath(root: string, path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") || /^[a-z]:\//i.test(normalized)
    ? normalized
    : `${root.replace(/\\/g, "/").replace(/\/+$/, "")}/${normalized}`;
  const clean = absolute.replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(clean) ? clean.toLowerCase() : clean;
}

export function notifyWorkspaceFilesChanged(root: string, paths: string[]): void {
  changes.dispatchEvent(new CustomEvent<WorkspaceFileChange>("change", {
    detail: { paths: paths.map((path) => workspaceChangePath(root, path)) },
  }));
}

export function subscribeWorkspaceFileChanges(listener: (change: WorkspaceFileChange) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<WorkspaceFileChange>).detail);
  changes.addEventListener("change", handler);
  return () => changes.removeEventListener("change", handler);
}
