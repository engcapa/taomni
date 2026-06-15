import { create } from "zustand";
import {
  listSessions,
  saveSession,
  deleteSession,
  markSessionConnected,
  type SessionConfig,
  type SessionGroup,
  listSessionGroups,
  saveSessionGroup,
  deleteSessionGroup,
} from "../lib/ipc";
import {
  ancestorGroupPaths,
  collectFolderPaths,
  groupPathContains,
  leafGroupName,
  normalizeGroupPath,
  parentGroupPath,
  replaceGroupPathPrefix,
  resolveGroupPaths,
  toStoredGroupPath,
} from "../lib/sessionPaths";

interface SessionState {
  sessions: SessionConfig[];
  groups: SessionGroup[];
  loading: boolean;
  // Anchor selection (last clicked). Kept for single-selection consumers.
  selectedSessionId: string | null;
  // Full multi-selection. Always includes the anchor when non-empty.
  selectedSessionIds: string[];
  searchQuery: string;

  loadSessions: () => Promise<void>;
  addSession: (config: SessionConfig) => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  removeSessions: (ids: string[]) => Promise<void>;
  updateSession: (config: SessionConfig) => Promise<void>;
  duplicateSession: (id: string) => Promise<void>;
  duplicateSessions: (ids: string[]) => Promise<void>;
  markConnected: (id: string) => Promise<void>;
  addGroup: (name: string, parentId?: string | null) => Promise<void>;
  createFolderPath: (path: string) => Promise<void>;
  renameFolderPath: (oldPath: string, newPath: string) => Promise<void>;
  deleteFolderPath: (path: string) => Promise<void>;
  moveSessionToGroup: (id: string, groupPath: string | null) => Promise<void>;
  moveSessionsToGroup: (ids: string[], groupPath: string | null) => Promise<void>;
  importSessions: (configs: SessionConfig[]) => Promise<void>;
  setSelectedSession: (id: string | null) => void;
  setSelectedSessionIds: (ids: string[]) => void;
  toggleSessionSelection: (id: string) => void;
  clearSelection: () => void;
  setSearchQuery: (query: string) => void;
}

let pendingLoadSessions: Promise<void> | null = null;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function groupForPath(path: string): SessionGroup {
  return {
    id: path,
    name: leafGroupName(path),
    parent_id: parentGroupPath(path),
    sort_order: 0,
    icon: null,
  };
}

function pruneSelection(
  sessions: SessionConfig[],
  selectedSessionIds: string[],
  selectedSessionId: string | null,
): Pick<SessionState, "selectedSessionIds" | "selectedSessionId"> {
  const known = new Set(sessions.map((s) => s.id));
  const ids = selectedSessionIds.filter((id) => known.has(id));
  const anchor =
    selectedSessionId && known.has(selectedSessionId)
      ? selectedSessionId
      : ids[ids.length - 1] ?? null;
  return { selectedSessionIds: ids, selectedSessionId: anchor };
}

async function reloadSessionState(setState: (state: Partial<SessionState>) => void) {
  const [sessions, groups] = await Promise.all([
    listSessions(),
    listSessionGroups(),
  ]);
  const { selectedSessionIds, selectedSessionId } = useSessionStore.getState();
  setState({ sessions, groups, ...pruneSelection(sessions, selectedSessionIds, selectedSessionId) });
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  groups: [],
  loading: false,
  selectedSessionId: null,
  selectedSessionIds: [],
  searchQuery: "",

  loadSessions: async () => {
    if (pendingLoadSessions) return pendingLoadSessions;

    set({ loading: true });
    pendingLoadSessions = (async () => {
      try {
        const [sessions, groups] = await Promise.all([
          listSessions(),
          listSessionGroups(),
        ]);
        const { selectedSessionIds, selectedSessionId } = useSessionStore.getState();
        set({ sessions, groups, loading: false, ...pruneSelection(sessions, selectedSessionIds, selectedSessionId) });
      } catch (err) {
        console.error("Failed to load sessions:", err);
        set({ loading: false });
      } finally {
        pendingLoadSessions = null;
      }
    })();

    return pendingLoadSessions;
  },

  addSession: async (config) => {
    await saveSession(config);
    const [sessions, groups] = await Promise.all([
      listSessions(),
      listSessionGroups(),
    ]);
    set({ sessions, groups, selectedSessionId: config.id, selectedSessionIds: [config.id] });
  },

  removeSession: async (id) => {
    await useSessionStore.getState().removeSessions([id]);
  },

  removeSessions: async (ids) => {
    const targets = [...new Set(ids)];
    if (targets.length === 0) return;
    for (const id of targets) {
      await deleteSession(id);
    }
    const removed = new Set(targets);
    set((s) => ({
      sessions: s.sessions.filter((x) => !removed.has(x.id)),
      selectedSessionIds: s.selectedSessionIds.filter((id) => !removed.has(id)),
      selectedSessionId: s.selectedSessionId && removed.has(s.selectedSessionId) ? null : s.selectedSessionId,
    }));
  },

  updateSession: async (config) => {
    await saveSession(config);
    await reloadSessionState(set);
  },

  duplicateSession: async (id) => {
    await useSessionStore.getState().duplicateSessions([id]);
  },

  duplicateSessions: async (ids) => {
    const targets = [...new Set(ids)];
    if (targets.length === 0) return;
    const sourceById = new Map(useSessionStore.getState().sessions.map((s) => [s.id, s]));
    const now = Math.floor(Date.now() / 1000);
    const copyIds: string[] = [];
    for (const id of targets) {
      const source = sourceById.get(id);
      if (!source) continue;
      const copy: SessionConfig = {
        ...source,
        id: crypto.randomUUID(),
        name: `${source.name} (copy)`,
        created_at: now,
        updated_at: now,
        last_connected_at: null,
      };
      await saveSession(copy);
      copyIds.push(copy.id);
    }
    const sessions = await listSessions();
    set({
      sessions,
      selectedSessionIds: copyIds,
      selectedSessionId: copyIds[copyIds.length - 1] ?? null,
    });
  },

  markConnected: async (id) => {
    if (!useSessionStore.getState().sessions.some((s) => s.id === id)) return;
    const ts = await markSessionConnected(id);
    set((s) => ({
      sessions: s.sessions.map((session) =>
        session.id === id ? { ...session, last_connected_at: ts } : session,
      ),
    }));
  },

  addGroup: async (name, parentId = null) => {
    const parentPath = parentId
      ? resolveGroupPaths(useSessionStore.getState().groups).find(({ group }) => group.id === parentId)?.path ?? parentId
      : null;
    const path = normalizeGroupPath(parentPath ? `${parentPath} / ${name}` : name);
    if (!path) return;
    await useSessionStore.getState().createFolderPath(path);
  },

  createFolderPath: async (path) => {
    const normalized = normalizeGroupPath(path);
    if (!normalized) return;

    const knownPaths = new Set(collectFolderPaths(
      useSessionStore.getState().sessions,
      useSessionStore.getState().groups,
    ));

    for (const ancestor of ancestorGroupPaths(normalized)) {
      if (knownPaths.has(ancestor)) continue;
      await saveSessionGroup(groupForPath(ancestor));
      knownPaths.add(ancestor);
    }

    await reloadSessionState(set);
  },

  renameFolderPath: async (oldPath, newPath) => {
    const oldNormalized = normalizeGroupPath(oldPath);
    const newNormalized = normalizeGroupPath(newPath);
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) return;

    const state = useSessionStore.getState();
    const groupPaths = resolveGroupPaths(state.groups);
    const affectedGroups = groupPaths
      .filter(({ path }) => groupPathContains(oldNormalized, path))
      .sort((a, b) => b.path.length - a.path.length);
    const affectedSessions = state.sessions.filter((session) =>
      groupPathContains(oldNormalized, session.group_path),
    );

    for (const ancestor of ancestorGroupPaths(newNormalized)) {
      await saveSessionGroup(groupForPath(ancestor));
    }

    for (const { group } of affectedGroups) {
      await deleteSessionGroup(group.id);
    }

    const replacementGroupPaths = new Set<string>();
    for (const { path } of affectedGroups) {
      const replaced = replaceGroupPathPrefix(path, oldNormalized, newNormalized);
      if (replaced) {
        for (const ancestor of ancestorGroupPaths(replaced)) {
          replacementGroupPaths.add(ancestor);
        }
      }
    }

    for (const path of [...replacementGroupPaths].sort((a, b) => a.length - b.length)) {
      await saveSessionGroup(groupForPath(path));
    }

    for (const session of affectedSessions) {
      const replaced = replaceGroupPathPrefix(session.group_path, oldNormalized, newNormalized);
      await saveSession({
        ...session,
        group_path: toStoredGroupPath(replaced),
        updated_at: nowSeconds(),
      });
    }

    await reloadSessionState(set);
  },

  deleteFolderPath: async (path) => {
    const normalized = normalizeGroupPath(path);
    if (!normalized) return;

    const state = useSessionStore.getState();
    const affectedGroups = resolveGroupPaths(state.groups)
      .filter(({ path: groupPath }) => groupPathContains(normalized, groupPath))
      .sort((a, b) => b.path.length - a.path.length);
    const affectedSessions = state.sessions.filter((session) =>
      groupPathContains(normalized, session.group_path),
    );

    for (const session of affectedSessions) {
      await deleteSession(session.id);
    }
    for (const { group } of affectedGroups) {
      await deleteSessionGroup(group.id);
    }

    await reloadSessionState(set);
  },

  moveSessionToGroup: async (id, groupPath) => {
    await useSessionStore.getState().moveSessionsToGroup([id], groupPath);
  },

  moveSessionsToGroup: async (ids, groupPath) => {
    const targets = new Set(ids);
    if (targets.size === 0) return;
    const sessions = useSessionStore.getState().sessions.filter((s) => targets.has(s.id));
    if (sessions.length === 0) return;

    const normalized = normalizeGroupPath(groupPath);
    if (normalized) {
      await useSessionStore.getState().createFolderPath(normalized);
    }

    const storedGroupPath = toStoredGroupPath(normalized);
    for (const session of sessions) {
      await saveSession({
        ...session,
        group_path: storedGroupPath,
        updated_at: nowSeconds(),
      });
    }
    await reloadSessionState(set);
  },

  importSessions: async (configs) => {
    for (const config of configs) {
      if (config.group_path) {
        const normalized = normalizeGroupPath(config.group_path);
        if (normalized) {
          for (const ancestor of ancestorGroupPaths(normalized)) {
            await saveSessionGroup(groupForPath(ancestor));
          }
        }
      }
      await saveSession(config);
    }
    await reloadSessionState(set);
  },

  setSelectedSession: (id) => set({ selectedSessionId: id, selectedSessionIds: id ? [id] : [] }),
  setSelectedSessionIds: (ids) => {
    const unique = [...new Set(ids)];
    set({ selectedSessionIds: unique, selectedSessionId: unique[unique.length - 1] ?? null });
  },
  toggleSessionSelection: (id) =>
    set((s) => {
      if (s.selectedSessionIds.includes(id)) {
        const next = s.selectedSessionIds.filter((x) => x !== id);
        return {
          selectedSessionIds: next,
          selectedSessionId: s.selectedSessionId === id ? next[next.length - 1] ?? null : s.selectedSessionId,
        };
      }
      return { selectedSessionIds: [...s.selectedSessionIds, id], selectedSessionId: id };
    }),
  clearSelection: () => set({ selectedSessionId: null, selectedSessionIds: [] }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}));
