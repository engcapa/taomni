import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionConfig } from "../../../lib/ipc";
import { startCustomDrag } from "../../../lib/customDnD";
import { ancestorGroupPaths, collectFolderPaths } from "../../../lib/sessionPaths";
import { filterSessions, buildSessionTree, type FolderNode, folderKey, cssAttributeValue, SESSION_DRAG_MIME, type SessionDragPayload } from "./model";


export interface UseSessionTreeNavigationContext {
  selectedSessionId: string | null;
  sessions: SessionConfig[];
  searchQuery: string;
  groups: import("../../../lib/ipc").SessionGroup[];
  selectedSessionIds: string[];
  setSelectedSession: (id: string | null) => void;
  setSelectedSessionIds: (ids: string[]) => void;
  toggleSessionSelection: (id: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
  setDragOverGroup: import("react").Dispatch<import("react").SetStateAction<string | null>>;
}

export function useSessionTreeNavigation(context: UseSessionTreeNavigationContext) {
  const {
    selectedSessionId,
    sessions,
    searchQuery,
    groups,
    selectedSessionIds,
    setSelectedSession,
    setSelectedSessionIds,
    toggleSessionSelection,
    t,
  } = context;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ root: true });
  const rangeAnchorRef = useRef(selectedSessionId);

  const filteredSessions = useMemo(
    () => filterSessions(sessions, searchQuery),
    [sessions, searchQuery],
  );
  const tree = useMemo(
    () => buildSessionTree(filteredSessions, searchQuery ? [] : groups),
    [filteredSessions, groups, searchQuery],
  );
  const folderPaths = useMemo(
    () => collectFolderPaths(sessions, groups),
    [sessions, groups],
  );
  const effectiveSelectedSessionIds = useMemo(
    () => new Set(selectedSessionIds),
    [selectedSessionIds],
  );
  const visibleSessionIds = useMemo(() => {
    const ids: string[] = [];
    const visit = (node: FolderNode) => {
      for (const folder of node.folders) {
        if (searchQuery || expanded[folderKey(folder.path)]) visit(folder);
      }
      ids.push(...node.sessions.map((session) => session.id));
    };
    if (expanded.root !== false) visit(tree);
    return ids;
  }, [tree, expanded, searchQuery]);

  useEffect(() => {
    if (!rangeAnchorRef.current || !effectiveSelectedSessionIds.has(rangeAnchorRef.current)) {
      rangeAnchorRef.current = selectedSessionId;
    }
  }, [effectiveSelectedSessionIds, selectedSessionId]);

  const toggle = (key: string) =>
    setExpanded((e) => ({ ...e, [key]: !e[key] }));

  const expandPath = (path: string | null | undefined) => {
    setExpanded((state) => {
      const next: Record<string, boolean> = { ...state, root: true };
      for (const ancestor of ancestorGroupPaths(path)) {
        next[folderKey(ancestor)] = true;
      }
      return next;
    });
  };

  useEffect(() => {
    if (!selectedSessionId) return;
    const selectedSession = sessions.find((session) => session.id === selectedSessionId);
    if (!selectedSession) return;
    expandPath(selectedSession.group_path);

    const timer = window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="session-tree-item"][data-session-id="${cssAttributeValue(selectedSessionId)}"]`,
      );
      if (typeof row?.scrollIntoView === "function") {
        row.scrollIntoView({ block: "nearest" });
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [selectedSessionId, sessions]);

  const selectSingleSession = (session: SessionConfig) => {
    rangeAnchorRef.current = session.id;
    setSelectedSession(session.id);
  };

  const handleSessionClick = (event: React.MouseEvent, session: SessionConfig) => {
    if (event.shiftKey) {
      event.preventDefault();
      const anchorIndex = visibleSessionIds.indexOf(rangeAnchorRef.current ?? "");
      const targetIndex = visibleSessionIds.indexOf(session.id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const range = visibleSessionIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1);
        const ids = event.ctrlKey || event.metaKey ? [...selectedSessionIds, ...range] : range;
        // Single-selection consumers and scrolling follow the clicked end of the range.
        setSelectedSessionIds([...ids.filter((id) => id !== session.id), session.id]);
        return;
      }
      selectSingleSession(session);
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      rangeAnchorRef.current = session.id;
      toggleSessionSelection(session.id);
      return;
    }
    selectSingleSession(session);
  };

  const handleSessionPointerDown = (event: React.PointerEvent<HTMLDivElement>, session: SessionConfig) => {
    if (event.button !== 0) return;
    // Stop the WebView's text-selection gesture before our drag threshold is crossed.
    event.preventDefault();
    const sessionIds = effectiveSelectedSessionIds.has(session.id) ? selectedSessionIds : [session.id];
    startCustomDrag({
      event,
      data: { mime: SESSION_DRAG_MIME, payload: { sessionIds } satisfies SessionDragPayload },
      ghostText: sessionIds.length > 1 ? t("sessionTree.dragSelectedCount", { count: sessionIds.length }) : session.name,
      onActivate: () => {
        if (!effectiveSelectedSessionIds.has(session.id)) selectSingleSession(session);
      },
      onEnd: () => context.setDragOverGroup(null),
    });
  };
  return { expandPath, effectiveSelectedSessionIds, selectSingleSession, folderPaths, tree, expanded, toggle, handleSessionClick, handleSessionPointerDown, filteredSessions };
}
