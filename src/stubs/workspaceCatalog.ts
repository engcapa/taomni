import type { Workspace } from "../types/workspace";

const KEY = "taomni.stub.workspaces.v1";
/** Browser stub only; native always goes through the application SQLite connection. */
export function workspaceCatalogInvoke(command: string, args: Record<string, any>, sessionIds: string[]) {
  const workspaces: Workspace[] = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  if (command === "list_workspaces") return workspaces;
  const id = args.workspace?.id ?? args.id ?? args.membership?.workspaceId;
  const existing = workspaces.find((w) => w.id === id);
  if (command === "get_workspace") {
    if (!existing) throw new Error("Workspace unavailable");
    return existing;
  }
  if (command === "list_workspace_memberships") return existing?.memberships ?? [];
  if ((existing?.revision ?? 0) !== (args.workspace?.revision ?? args.revision)) throw new Error("workspace revision conflict");
  if (command === "delete_workspace") {
    localStorage.setItem(KEY, JSON.stringify(workspaces.filter((w) => w.id !== id)));
    return;
  }
  const workspace: Workspace = structuredClone(args.workspace ?? existing);
  if (!workspace) throw new Error("Workspace unavailable");
  if (command === "save_workspace_navigation") { workspace.navigation = args.navigation; workspace.lastOpenedAt = args.lastOpenedAt; }
  if (command === "remove_workspace_membership") workspace.memberships = workspace.memberships.filter((m) => m.sessionId !== args.sessionId);
  if (command === "upsert_workspace_membership") workspace.memberships = [...workspace.memberships.filter((m) => m.sessionId !== args.membership.sessionId), args.membership];
  if (!workspace.id || !workspace.name.trim()) throw new Error("workspace id and name are required");
  const seen = new Set<string>();
  for (const member of workspace.memberships) {
    if (member.workspaceId !== id || seen.has(member.sessionId)) throw new Error("invalid or duplicate workspace membership");
    if (!sessionIds.includes(member.sessionId) && !existing?.memberships.some((m) => m.sessionId === member.sessionId)) throw new Error("missing canonical session");
    seen.add(member.sessionId);
  }
  workspace.revision++;
  localStorage.setItem(KEY, JSON.stringify([...workspaces.filter((w) => w.id !== id), workspace]));
  return workspace;
}
