import type { StoreApi } from "zustand";
import { inFlightAttaches } from "./lifetime";
import { inFlightLocalAttaches } from "./localLifetime";
import { errorMessage, isConnectionError, isSftpRefreshDirectorySignal, listingState, listSide, pushHistory } from "./listing";
import type { PaneSide, PaneState, SftpStoreState } from "./model";

const requests = new Map<string, number>();
let requestSequence = 0;
const keyFor = (id: string, side: PaneSide) => `${id}:${side}`;
function nextRequest(id: string, side: PaneSide) {
  const key = keyFor(id, side);
  const token = ++requestSequence;
  requests.set(key, token);
  return () => requests.get(key) === token;
}
export function invalidatePaneRequests(id: string) {
  requests.delete(keyFor(id, "local"));
  requests.delete(keyFor(id, "remote"));
}

type Set = StoreApi<SftpStoreState>["setState"];
type Get = StoreApi<SftpStoreState>["getState"];

/** One request owner for refresh, navigation and history; late reads cannot change a newer directory. */
export function createPaneNavigation(set: Set, get: Get): Pick<SftpStoreState,
  "refreshPane" | "navigate" | "navigateBack" | "navigateForward"> {
  const load = async (id: string, side: PaneSide, path: string, historyIndex?: number, refresh = false) => {
    const attaching = side === "remote" ? inFlightAttaches.get(id) : inFlightLocalAttaches.get(id);
    if (attaching) {
      try { await attaching; } catch { return; }
      if (!get().sessions[id]?.attached) return;
    }
    const session = refresh ? get().sessions[id] : get().ensureSession(id);
    if (!session) return;
    const previous = session[side];
    const isCurrent = nextRequest(id, side);
    const active = () => isCurrent() && !!get().sessions[id];
    set((state) => ({ sessions: { ...state.sessions, [id]: {
      ...state.sessions[id],
      [side]: {
        ...previous, loading: true, error: null,
        // Local navigation commits path/list/history together only after success.
        ...(!refresh && side === "remote" ? { path, entries: [], selection: [], skippedEntryCount: 0, entryDiagnostics: [] } : {}),
      },
    } } }));
    try {
      const listing = await listSide(id, side, path);
      if (!active()) return;
      set((state) => {
        const current = state.sessions[id];
        const pane = current[side];
        const alive = new Set(listing.entries.map((entry) => entry.path));
        let next: PaneState = {
          ...pane, path, ...listingState(listing), loading: false, error: null,
          selection: refresh ? pane.selection.filter((value) => alive.has(value)) : [],
        };
        if (!refresh) next = historyIndex === undefined ? pushHistory(next, path) : { ...next, historyIndex };
        return { sessions: { ...state.sessions, [id]: { ...current, [side]: next } } };
      });
    } catch (error) {
      if (!active()) return;
      let displayError = error;
      if (side === "remote" && isSftpRefreshDirectorySignal(error)) {
        try {
          const listing = await listSide(id, side, previous.path);
          if (!active()) return;
          set((state) => ({ sessions: { ...state.sessions, [id]: {
            ...state.sessions[id], [side]: { ...previous, ...listingState(listing), loading: false, error: null, selection: [] },
          } } }));
          return;
        } catch (refreshError) { displayError = refreshError; }
      }
      if (!active()) return;
      const message = errorMessage(displayError);
      set((state) => {
        const current = state.sessions[id];
        return { sessions: { ...state.sessions, [id]: {
          ...current, [side]: { ...previous, loading: false, error: message },
          ...(side === "remote" && isConnectionError(displayError) ? { attached: false, error: message } : {}),
        } } };
      });
    }
  };
  return {
    refreshPane: async (id, side) => {
      const pane = get().sessions[id]?.[side];
      if (pane) await load(id, side, pane.path, undefined, true);
    },
    navigate: (id, side, path) => load(id, side, path),
    navigateBack: async (id, side) => {
      const pane = get().sessions[id]?.[side];
      if (pane && pane.historyIndex > 0) await load(id, side, pane.history[pane.historyIndex - 1], pane.historyIndex - 1);
    },
    navigateForward: async (id, side) => {
      const pane = get().sessions[id]?.[side];
      if (pane && pane.historyIndex < pane.history.length - 1) await load(id, side, pane.history[pane.historyIndex + 1], pane.historyIndex + 1);
    },
  };
}
