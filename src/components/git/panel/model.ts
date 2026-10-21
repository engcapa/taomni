import { type ReactNode } from "react";
import { type GitBranch as GitBranchInfo,type GitChange,type GitOperationState,type GitRemote,type GitRepoSettings,type GitSnapshot,type GitTag } from "../../../lib/git";


export type WorkspaceSettingsAggregateView=ReactNode|((showCurrent: () => void) => ReactNode);


export type GitView="changes"|"log"|"branches"|"tags"|"stash"|"settings";


export const EMPTY_SETTINGS: GitRepoSettings={
  userName: null,
  userEmail: null,
  httpProxy: null,
  httpsProxy: null,
  pullRebase: null,
  pushDefault: null,
  coreAutocrlf: null,
  coreFilemode: null,
  commitGpgsign: null,
};


export function gitChangeMatchesSearch(change: GitChange,normalizedFilter: string): boolean {
  if(!normalizedFilter) return true;
  return (
    change.path.toLowerCase().includes(normalizedFilter)||
    (change.oldPath??"").toLowerCase().includes(normalizedFilter)||
    change.status.toLowerCase().includes(normalizedFilter)||
    (change.conflict? "conflict conflicted":"").includes(normalizedFilter)||
    (change.staged? "staged":"").includes(normalizedFilter)||
    (change.unstaged? "unstaged":"").includes(normalizedFilter)
  );
}


export function toggleSetValue<T>(current: Set<T>,value: T): Set<T> {
  const next=new Set(current);
  if(next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}


export function branchMatchesQuery(branch: GitBranchInfo,query: string): boolean {
  if(!query) return true;
  return (
    branch.name.toLowerCase().includes(query)||
    branch.fullName.toLowerCase().includes(query)||
    (branch.upstream??"").toLowerCase().includes(query)||
    (branch.subject??"").toLowerCase().includes(query)
  );
}


export function tagMatchesQuery(tag: GitTag,query: string): boolean {
  if(!query) return true;
  return (
    tag.name.toLowerCase().includes(query)||
    tag.oid.toLowerCase().includes(query)||
    (tag.subject??"").toLowerCase().includes(query)
  );
}


export interface RemoteDraft {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  username: string;
  token: string;
}


export function normalizeSettings(settings: GitRepoSettings|null|undefined): GitRepoSettings {
  return { ...EMPTY_SETTINGS,...(settings??{}) };
}


export function pullBranchForRemote(snapshot: GitSnapshot|null,remoteName: string): string|null {
  if(!snapshot?.currentBranch||!remoteName) return null;
  const prefix=`${remoteName}/`;
  if(snapshot.upstream?.startsWith(prefix)) {
    return snapshot.upstream.slice(prefix.length)||snapshot.currentBranch;
  }
  return snapshot.currentBranch;
}


export function buildRemoteDrafts(remotes: GitRemote[],current: Record<string,RemoteDraft>): Record<string,RemoteDraft> {
  const next: Record<string,RemoteDraft>={};
  for(const remote of remotes) {
    next[remote.name]=current[remote.name]??remoteDraft(remote);
  }
  return next;
}


export function remoteDraft(remote: GitRemote): RemoteDraft {
  return {
    name: remote.name,
    fetchUrl: remote.fetchUrl,
    pushUrl: remote.pushUrl??"",
    username: remote.username??"",
    token: "",
  };
}


export function emptyToNull(value: string): string|null {
  const trimmed=value.trim();
  return trimmed? trimmed:null;
}


export function errorMessage(error: unknown): string {
  if(error instanceof Error) return error.message;
  return typeof error==="string"? error:String(error);
}


export function operationLabel(operation: GitOperationState|null): string {
  switch(operation?.kind) {
    case "merge":
      return "Merge in progress.";
    case "cherryPick":
      return "Cherry-pick in progress.";
    case "revert":
      return "Revert in progress.";
    case "rebase":
      return "Rebase in progress.";
    default:
      return "Conflicts detected.";
  }
}
