import type { GitWorkspaceRootInfo } from "../../../types";
import { type RepoScope } from "./model";


export const WORKSPACE_SCOPE_KEY="taomni.git.workspace.scope.v1";


export function workspaceRootsKey(roots: readonly GitWorkspaceRootInfo[]): string {
  return roots.map((root) => root.repoRoot).sort((a,b) => a.localeCompare(b)).join("\n");
}


export function initialRepoScope(roots: readonly GitWorkspaceRootInfo[],activeRepoRoot?: string|null): RepoScope {
  if(roots.length===0) return { mode: "all" };
  if(roots.length===1) return { mode: "single",repoRoot: roots[0].repoRoot };
  if(activeRepoRoot&&!roots.some((root) => root.repoRoot===activeRepoRoot)) {
    return { mode: "all" };
  }
  return { mode: "all" };
}


export function loadRepoScope(key: string,roots: readonly GitWorkspaceRootInfo[]): RepoScope|null {
  if(!key) return null;
  try {
    const raw=localStorage.getItem(WORKSPACE_SCOPE_KEY);
    if(!raw) return null;
    const map=JSON.parse(raw) as Record<string,RepoScope>;
    const saved=map[key];
    return saved? normalizeRepoScope(saved,roots):null;
  } catch {
    return null;
  }
}


export function saveRepoScope(key: string,scope: RepoScope,roots: readonly GitWorkspaceRootInfo[]): void {
  if(!key) return;
  try {
    const raw=localStorage.getItem(WORKSPACE_SCOPE_KEY);
    const map=raw? (JSON.parse(raw) as Record<string,RepoScope>):{};
    const normalized=normalizeRepoScope(scope,roots);
    if(normalized.mode==="all") delete map[key];
    else map[key]=normalized;
    localStorage.setItem(WORKSPACE_SCOPE_KEY,JSON.stringify(map));
  } catch {
    /* ignore */
  }
}


export function normalizeRepoScope(
  scope: RepoScope,
  roots: readonly GitWorkspaceRootInfo[],
  fallbackRepoRoot?: string|null,
): RepoScope {
  if(roots.length===0) return { mode: "all" };
  const validRoots=new Set(roots.map((root) => root.repoRoot));
  if(scope.mode==="all") return scope;
  if(scope.mode==="single"&&validRoots.has(scope.repoRoot)) return scope;
  if(scope.mode==="custom") {
    const ordered=orderedRepoRoots(scope.repoRoots,roots);
    if(ordered.length===roots.length) return { mode: "all" };
    if(ordered.length===1) return { mode: "single",repoRoot: ordered[0] };
    if(ordered.length>1&&sameStringArray(ordered,scope.repoRoots)) return scope;
    if(ordered.length>1) return { mode: "custom",repoRoots: ordered };
  }
  if(fallbackRepoRoot&&validRoots.has(fallbackRepoRoot)) {
    return { mode: "single",repoRoot: fallbackRepoRoot };
  }
  return roots.length>1? { mode: "all" }:{ mode: "single",repoRoot: roots[0].repoRoot };
}


export function rootsForScope(roots: readonly GitWorkspaceRootInfo[],scope: RepoScope): GitWorkspaceRootInfo[] {
  if(scope.mode==="all") return [...roots];
  if(scope.mode==="single") return roots.filter((root) => root.repoRoot===scope.repoRoot);
  const selected=new Set(scope.repoRoots);
  return roots.filter((root) => selected.has(root.repoRoot));
}


export function scopeFromRepoRoots(repoRoots: Iterable<string>,roots: readonly GitWorkspaceRootInfo[]): RepoScope {
  const ordered=orderedRepoRoots([...repoRoots],roots);
  if(ordered.length===0) return initialRepoScope(roots);
  if(ordered.length===roots.length) return { mode: "all" };
  if(ordered.length===1) return { mode: "single",repoRoot: ordered[0] };
  return { mode: "custom",repoRoots: ordered };
}


export function orderedRepoRoots(repoRoots: readonly string[],roots: readonly GitWorkspaceRootInfo[]): string[] {
  const selected=new Set(repoRoots);
  return roots.filter((root) => selected.has(root.repoRoot)).map((root) => root.repoRoot);
}


export function sameStringArray(a: readonly string[],b: readonly string[]): boolean {
  return a.length===b.length&&a.every((entry,index) => entry===b[index]);
}


export function repoScopeLabel(
  scope: RepoScope,
  scopedRoots: readonly GitWorkspaceRootInfo[],
  selectedRoot: GitWorkspaceRootInfo|null,
  totalRoots: number,
): string {
  if(scope.mode==="all") return `All Repositories (${totalRoots})`;
  if(scope.mode==="single") return scopedRoots[0]?.name??selectedRoot?.name??"Repository";
  const first=scopedRoots[0]?.name??"Repositories";
  return scopedRoots.length>1? `${first} +${scopedRoots.length-1}`:first;
}
