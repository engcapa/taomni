export type GitShellView = "changes" | "log" | "branches" | "tags" | "stash" | "settings";
export type GitRepositoryScope = { mode: "all" } | { mode: "single"; repoRoot: string } | { mode: "custom"; repoRoots: string[] };
export interface GitShellSnapshot {
  commitMessage: string; targetBranch: string; selectedChangeKeys: string[]; uncheckedChangeKeys: string[]; focusedChangeKey: string | null; treeMode: boolean;
  view?: GitShellView;
  workspace?: { selectedRepoRoot: string; repoScope: GitRepositoryScope; repoRemoteNames: Record<string, string> };
}
interface GitShellController { snapshot(): GitShellSnapshot; restore(snapshot: GitShellSnapshot): void }
const controllers = new Map<string, GitShellController>();
const listeners = new Map<string, Set<() => void>>();
export function notifyGitShellViewChanged(id: string) { for (const listener of listeners.get(id) ?? []) listener(); }
export function subscribeGitShellView(id: string, listener: () => void) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(listener);
  return () => { const group = listeners.get(id); group?.delete(listener); if (!group?.size) listeners.delete(id); };
}
export function registerGitShellController(id: string, controller: GitShellController) { controllers.set(id, controller); return () => { if (controllers.get(id) === controller) controllers.delete(id); }; }
export function getGitShellController(id: string) { return controllers.get(id); }
export function validateGitShellSnapshot(value: unknown): GitShellSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const s = value as GitShellSnapshot;
  if (typeof s.commitMessage !== "string" || typeof s.targetBranch !== "string" || typeof s.treeMode !== "boolean" || (s.focusedChangeKey !== null && typeof s.focusedChangeKey !== "string")) return null;
  if (!Array.isArray(s.selectedChangeKeys) || !Array.isArray(s.uncheckedChangeKeys) || ![...s.selectedChangeKeys, ...s.uncheckedChangeKeys].every((key) => typeof key === "string")) return null;
  if (s.view !== undefined && !["changes", "log", "branches", "tags", "stash", "settings"].includes(s.view)) return null;
  let workspace: GitShellSnapshot["workspace"];
  if (s.workspace !== undefined) {
    const w = s.workspace, scope = w?.repoScope;
    if (!w || typeof w.selectedRepoRoot !== "string" || !scope || !["all", "single", "custom"].includes(scope.mode)) return null;
    if (scope.mode === "single" && typeof scope.repoRoot !== "string") return null;
    if (scope.mode === "custom" && (!Array.isArray(scope.repoRoots) || !scope.repoRoots.every((root) => typeof root === "string"))) return null;
    if (!w.repoRemoteNames || typeof w.repoRemoteNames !== "object" || Array.isArray(w.repoRemoteNames) || !Object.values(w.repoRemoteNames).every((name) => typeof name === "string")) return null;
    workspace = { selectedRepoRoot: w.selectedRepoRoot, repoScope: scope.mode === "all" ? { mode: "all" } : scope.mode === "single" ? { mode: "single", repoRoot: scope.repoRoot } : { mode: "custom", repoRoots: [...scope.repoRoots] }, repoRemoteNames: { ...w.repoRemoteNames } };
  }
  return { commitMessage: s.commitMessage, targetBranch: s.targetBranch, treeMode: s.treeMode, focusedChangeKey: s.focusedChangeKey, selectedChangeKeys: [...s.selectedChangeKeys], uncheckedChangeKeys: [...s.uncheckedChangeKeys], ...(s.view ? { view: s.view } : {}), ...(workspace ? { workspace } : {}) };
}
