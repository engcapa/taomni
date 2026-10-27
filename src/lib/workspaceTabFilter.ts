import type { WorkspaceIsolatedTab } from "../stores/workspacePlatformStore";
import type { SessionTabCategory } from "./tabFilter";

export type WorkspaceTabCategory = SessionTabCategory | "files";
export interface WorkspaceTabFilter {
  category: WorkspaceTabCategory;
  query: string;
}

export const EMPTY_WORKSPACE_TAB_FILTER: WorkspaceTabFilter = { category: "all", query: "" };
export const WORKSPACE_TAB_CATEGORIES: readonly WorkspaceTabCategory[] = [
  "all", "files", "ssh", "database", "sftp", "remote", "local", "other",
];

export function workspaceTabCategory(tab: WorkspaceIsolatedTab): WorkspaceTabCategory {
  if (tab.kind === "file" || tab.kind === "code") return "files";
  if (tab.kind === "database") return "database";
  if (tab.kind === "sftp") return "sftp";
  if (tab.kind === "rdp" || tab.kind === "vnc") return "remote";
  if (tab.kind === "terminal") {
    const protocol = (tab.protocol ?? tab.sessionType ?? "").toUpperCase();
    if (protocol === "SSH") return "ssh";
    if (!tab.sessionId || protocol === "LOCAL" || protocol === "LOCALSHELL") return "local";
  }
  return "other";
}

export function filterWorkspaceTabs(tabs: readonly WorkspaceIsolatedTab[], filter: WorkspaceTabFilter): WorkspaceIsolatedTab[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return tabs.filter((tab) => (
    (filter.category === "all" || workspaceTabCategory(tab) === filter.category)
    && (!query || [tab.title, tab.filePath, tab.host, tab.username, tab.protocol, tab.sessionType]
      .some((value) => value?.toLocaleLowerCase().includes(query)))
  ));
}

export function hasWorkspaceTabFilter(filter: WorkspaceTabFilter): boolean {
  return filter.category !== "all" || Boolean(filter.query.trim());
}
