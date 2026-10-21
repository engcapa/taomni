import { gitRepoName,type GitBlobPair,type GitBranch as GitBranchInfo,type GitSnapshot,type GitTag } from "../../../lib/git";
import type { GitWorkspaceRootInfo } from "../../../types";


export interface RepoSnapshotState {
  snapshot: GitSnapshot|null;
  loading: boolean;
  error: string|null;
}


export type BatchResult="completed"|"skipped";


/**
 * A diff pair tagged with the request identity that produced it. The pane only
 * renders a pair whose key matches the focused change, so a response for a
 * previous repository/file can never appear under the current title
 * (ED-PARITY-008).
 */
export interface FocusedPairState {
  key: string;
  repoRoot: string;
  pair: GitBlobPair|null;
}


export type RepoScope=
  |{ mode: "all"; }
  |{ mode: "single"; repoRoot: string; }
  |{ mode: "custom"; repoRoots: string[]; };


export type WorkspaceBranchRow={ root: GitWorkspaceRootInfo; branch: GitBranchInfo; };

export type WorkspaceTagRow={ root: GitWorkspaceRootInfo; tag: GitTag; };


export function workspaceBranchRowKey(row: WorkspaceBranchRow): string {
  return `${row.root.repoRoot}\0${row.branch.fullName}`;
}


export function workspaceTagRowKey(row: WorkspaceTagRow): string {
  return `${row.root.repoRoot}\0${row.tag.name}`;
}


export function sortWorkspaceBranchRows(rows: WorkspaceBranchRow[]): WorkspaceBranchRow[] {
  return [...rows].sort((a,b) => {
    const dateDelta=(b.branch.date? Date.parse(b.branch.date)||0:0)
      -(a.branch.date? Date.parse(a.branch.date)||0:0);
    if(dateDelta!==0) return dateDelta;
    const nameCmp=a.branch.name.localeCompare(b.branch.name,undefined,{ sensitivity: "base" });
    if(nameCmp!==0) return nameCmp;
    return a.root.name.localeCompare(b.root.name);
  });
}


export function sortWorkspaceTagRows(rows: WorkspaceTagRow[]): WorkspaceTagRow[] {
  return [...rows].sort((a,b) => {
    const dateDelta=(b.tag.date? Date.parse(b.tag.date)||0:0)
      -(a.tag.date? Date.parse(a.tag.date)||0:0);
    if(dateDelta!==0) return dateDelta;
    const nameCmp=a.tag.name.localeCompare(b.tag.name,undefined,{ sensitivity: "base" });
    if(nameCmp!==0) return nameCmp;
    return a.root.name.localeCompare(b.root.name);
  });
}


export function workspaceRemoteSummary(snapshot: GitSnapshot): string {
  if(snapshot.remotes.length===0) return "No remotes";
  return snapshot.remotes.map((remote) => {
    const push=remote.pushUrl? ` -> ${remote.pushUrl}`:"";
    const auth=remote.tokenRef? " (token stored)":remote.username? ` (${remote.username})`:"";
    return `${remote.name}: ${remote.fetchUrl}${push}${auth}`;
  }).join(" | ");
}


export function workspaceBranchMatchesQuery(
  root: GitWorkspaceRootInfo,
  branch: GitSnapshot["branches"][number],
  query: string,
): boolean {
  if(!query) return true;
  return (
    root.name.toLowerCase().includes(query)||
    root.repoRoot.toLowerCase().includes(query)||
    branch.name.toLowerCase().includes(query)||
    branch.fullName.toLowerCase().includes(query)||
    (branch.upstream??"").toLowerCase().includes(query)||
    (branch.subject??"").toLowerCase().includes(query)
  );
}


export function workspaceTagMatchesQuery(
  root: GitWorkspaceRootInfo,
  tag: GitSnapshot["tags"][number],
  query: string,
): boolean {
  if(!query) return true;
  return (
    root.name.toLowerCase().includes(query)||
    root.repoRoot.toLowerCase().includes(query)||
    tag.name.toLowerCase().includes(query)||
    tag.oid.toLowerCase().includes(query)||
    (tag.subject??"").toLowerCase().includes(query)
  );
}


export function normalizePath(path: string): string {
  return path.replace(/\\/g,"/").replace(/\/+$/,"");
}


export interface RailGroup {
  key: string;
  name: string;
  rows: Array<{ root: GitWorkspaceRootInfo; depth: number; }>;
}


export function buildRailGroups(roots: readonly GitWorkspaceRootInfo[]): RailGroup[] {
  const byGroup=new Map<string,GitWorkspaceRootInfo[]>();
  for(const root of roots) {
    const key=normalizePath(root.path)||normalizePath(root.repoRoot);
    const list=byGroup.get(key);
    if(list) list.push(root);
    else byGroup.set(key,[root]);
  }
  const groups: RailGroup[]=[];
  for(const [key,repos] of byGroup) {
    const sorted=[...repos].sort((a,b) => a.repoRoot.localeCompare(b.repoRoot));
    const rows=sorted.map((root) => {
      const repoPath=normalizePath(root.repoRoot);
      const depth=sorted.filter((other) => (
        other!==root&&repoPath.startsWith(`${normalizePath(other.repoRoot)}/`)
      )).length;
      return { root,depth };
    });
    groups.push({ key,name: lastPathSegment(key),rows });
  }
  return groups.sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}


export function lastPathSegment(path: string): string {
  const parts=normalizePath(path).split("/").filter(Boolean);
  return parts[parts.length-1]??path;
}


export function dedupeRoots(roots: GitWorkspaceRootInfo[]): GitWorkspaceRootInfo[] {
  const seen=new Set<string>();
  const next: GitWorkspaceRootInfo[]=[];
  for(const root of roots) {
    const repoRoot=root.repoRoot.trim();
    if(!repoRoot||seen.has(repoRoot)) continue;
    seen.add(repoRoot);
    next.push({
      ...root,
      repoRoot,
      name: root.name||gitRepoName(repoRoot),
    });
  }
  return next.sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}


export function pullBranchForRemote(snapshot: GitSnapshot,remoteName: string): string|null {
  if(!snapshot.currentBranch||!remoteName) return null;
  const prefix=`${remoteName}/`;
  if(snapshot.upstream?.startsWith(prefix)) {
    return snapshot.upstream.slice(prefix.length)||snapshot.currentBranch;
  }
  return snapshot.currentBranch;
}


export function branchSummary(snapshot: GitSnapshot): string {
  if(snapshot.detached) return `detached ${snapshot.headOid??""}`.trim();
  return snapshot.currentBranch??"No branch";
}


export function summarizePaths(paths: string[]): string {
  const shown=paths.slice(0,4).join(", ");
  const remaining=paths.length-4;
  return remaining>0? `${shown}, +${remaining} more`:shown;
}


export function errorMessage(err: unknown): string {
  return err instanceof Error? err.message:String(err);
}
