import { useState, useEffect, useMemo } from "react";
import { type SessionConfig } from "../../lib/ipc";
import type { RecentWorkspace } from "../../types";
import { sessionTypeLabel } from "../../lib/terminalProfile";
import { type RecentSessionSort } from "./types";
import { compareRecentSessions } from "./sessionModel";


export interface UseWelcomeHistoryContext {
  recentSessions: SessionConfig[];
  recentWorkspaces: RecentWorkspace[];
}

export function useWelcomeHistory(context: UseWelcomeHistoryContext) {
  const { recentSessions, recentWorkspaces } = context;

  const [recentQuery, setRecentQuery] = useState("");
  const [recentType, setRecentType] = useState("all");
  const [recentSort, setRecentSort] = useState<RecentSessionSort>("last-desc");
  const [selectedRecentIds, setSelectedRecentIds] = useState<string[]>([]);
  const [workspaceQuery, setWorkspaceQuery] = useState("");


  const recentTypeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of recentSessions) {
      const label = sessionTypeLabel(session.session_type, session.options_json);
      if (!seen.has(label)) seen.set(label, label);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [recentSessions]);

  const filteredRecentSessions = useMemo(() => {
    const q = recentQuery.trim().toLowerCase();
    const filtered = recentSessions.filter((session) => {
      const label = sessionTypeLabel(session.session_type, session.options_json);
      if (recentType !== "all" && label !== recentType) return false;
      if (!q) return true;
      return [
        session.name,
        session.host,
        session.username ?? "",
        session.group_path ?? "",
        session.session_type,
        label,
        String(session.port ?? ""),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
    return filtered.sort((a, b) => compareRecentSessions(a, b, recentSort));
  }, [recentQuery, recentSessions, recentSort, recentType]);

  const filteredRecentWorkspaces = useMemo(() => {
    const q = workspaceQuery.trim().toLowerCase();
    return recentWorkspaces
      .filter((workspace) => {
        if (!q) return true;
        return [
          workspace.name,
          ...workspace.roots.flatMap((root) => [root.name, root.path, root.kind]),
          ...workspace.looseFiles.flatMap((file) => [file.name, file.path]),
          workspace.isGitRepo ? "git" : "folder",
        ]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .slice()
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }, [recentWorkspaces, workspaceQuery]);

  useEffect(() => {
    const known = new Set(recentSessions.map((session) => session.id));
    setSelectedRecentIds((ids) => {
      const next = ids.filter((id) => known.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [recentSessions]);

  useEffect(() => {
    if (recentType === "all") return;
    if (!recentTypeOptions.some((option) => option.value === recentType)) {
      setRecentType("all");
    }
  }, [recentType, recentTypeOptions]);

  const selectedRecentSet = useMemo(() => new Set(selectedRecentIds), [selectedRecentIds]);
  const selectedRecentSessions = useMemo(
    () => {
      const byId = new Map(recentSessions.map((session) => [session.id, session]));
      return selectedRecentIds.flatMap((id) => {
        const session = byId.get(id);
        return session ? [session] : [];
      });
    },
    [recentSessions, selectedRecentIds],
  );
  return { filteredRecentWorkspaces, filteredRecentSessions, recentTypeOptions, selectedRecentSet, selectedRecentSessions, recentQuery, setRecentQuery, recentType, setRecentType, recentSort, setRecentSort, selectedRecentIds, setSelectedRecentIds, workspaceQuery, setWorkspaceQuery };
}
