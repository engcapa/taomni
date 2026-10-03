export interface GitShellSnapshot { commitMessage: string; targetBranch: string; selectedChangeKeys: string[]; uncheckedChangeKeys: string[]; focusedChangeKey: string | null; treeMode: boolean }
interface GitShellController { snapshot(): GitShellSnapshot; restore(snapshot: GitShellSnapshot): void }
const controllers = new Map<string, GitShellController>();
export function registerGitShellController(id: string, controller: GitShellController) { controllers.set(id, controller); return () => { if (controllers.get(id) === controller) controllers.delete(id); }; }
export function getGitShellController(id: string) { return controllers.get(id); }
export function validateGitShellSnapshot(value: unknown): GitShellSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const s = value as GitShellSnapshot;
  if (typeof s.commitMessage !== "string" || typeof s.targetBranch !== "string" || typeof s.treeMode !== "boolean" || (s.focusedChangeKey !== null && typeof s.focusedChangeKey !== "string")) return null;
  if (!Array.isArray(s.selectedChangeKeys) || !Array.isArray(s.uncheckedChangeKeys) || ![...s.selectedChangeKeys, ...s.uncheckedChangeKeys].every((key) => typeof key === "string")) return null;
  return { commitMessage: s.commitMessage, targetBranch: s.targetBranch, treeMode: s.treeMode, focusedChangeKey: s.focusedChangeKey, selectedChangeKeys: s.selectedChangeKeys, uncheckedChangeKeys: s.uncheckedChangeKeys };
}
