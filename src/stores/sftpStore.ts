import { create } from "zustand";
import { sftpAttach, sftpDetach, sftpLocalHome, sftpRealpath } from "../lib/sftp";
import { inFlightAttaches, sessionRefCounts } from "./sftp/lifetime";
import {
  emptyListing,
  emptyPane,
  errorMessage,
  freshSession,
  isConnectionError,
  isSftpRefreshDirectorySignal,
  listingState,
  listSide,
  loadInitialListing,
  pushHistory,
  WINDOWS_DRIVES_ROOT,
} from "./sftp/listing";
import { type SftpStoreState } from "./sftp/model";

export const useSftpStore = create<SftpStoreState>((set, get) => ({
  sessions: {},

  ensureSession: (sessionId) => {
    const existing = get().sessions[sessionId];
    if (existing) return existing;
    const next = freshSession(sessionId);
    set((state) => ({ sessions: { ...state.sessions, [sessionId]: next } }));
    return next;
  },

  attach: async (opts) => {
    const sid = opts.sessionId;
    // Record this consumer up front so a concurrent unmount cleanup can't
    // race ahead and tear the session down before we finish attaching.
    sessionRefCounts.set(sid, (sessionRefCounts.get(sid) ?? 0) + 1);

    // If a backend attach is already in flight (another consumer kicked
    // it off and we got here while it was awaiting), join the same
    // promise instead of issuing a duplicate `sftpAttach`. This keeps
    // backend channel count at exactly one per session id even under
    // racing mounts and StrictMode.
    const inFlight = inFlightAttaches.get(sid);
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // The original attach failed; mirror that to this caller too.
        const remaining = (sessionRefCounts.get(sid) ?? 1) - 1;
        if (remaining > 0) sessionRefCounts.set(sid, remaining);
        else sessionRefCounts.delete(sid);
        const existingErr = get().sessions[sid]?.error;
        throw new Error(existingErr ?? "SFTP attach failed");
      }
      return;
    }

    // If the channel is already attached (another consumer brought it up
    // first and we're past the in-flight phase), don't re-issue the
    // backend attach — just inherit the live session. The unconditional
    // backend re-attach was wasteful and would also blow away pane state
    // for the existing consumer.
    const existing = get().sessions[sid];
    if (existing?.attached) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [sid]: {
          ...(state.sessions[sid] ?? freshSession(sid)),
          attaching: true,
          error: null,
          connectionOpts: opts,
        },
      },
    }));

    const attachPromise = (async () => {
      try {
        const result = await sftpAttach(opts);
        const home = result.homeDir || "/";
        let realHome = home;
        try {
          realHome = await sftpRealpath(sid, home);
        } catch {
          /* keep home as-is */
        }
        let localHome = "";
        let localHomeError: string | null = null;
        try {
          localHome = await sftpLocalHome();
        } catch (error) {
          localHomeError = errorMessage(error);
        }
        const [remoteLoad, localLoad] = await Promise.all([
          loadInitialListing(sid, "remote", realHome),
          localHomeError
            ? Promise.resolve({ listing: emptyListing(), error: localHomeError })
            : loadInitialListing(sid, "local", localHome),
        ]);
        set((state) => {
          const current = state.sessions[sid] ?? freshSession(sid);
          const remoteAlreadyNavigated = Boolean(
            current.remote.path &&
            current.remote.path !== realHome &&
            current.remote.path !== home,
          );
          const localAlreadyNavigated = Boolean(
            current.local.path &&
            current.local.path !== localHome,
          );
          return {
            sessions: {
              ...state.sessions,
              [sid]: {
                ...current,
                attached: true,
                attaching: false,
                homeDir: realHome,
                remote: remoteAlreadyNavigated
                  ? current.remote
                  : {
                    ...emptyPane(),
                    path: realHome,
                    ...listingState(remoteLoad.listing),
                    error: remoteLoad.error,
                    history: [realHome],
                    historyIndex: 0,
                  },
                local: localAlreadyNavigated
                  ? current.local
                  : {
                    ...emptyPane(),
                    path: localHome,
                    ...listingState(localLoad.listing),
                    error: localLoad.error,
                    history: localHome ? [localHome] : [],
                    historyIndex: localHome ? 0 : -1,
                  },
              },
            },
          };
        });
        // The session is officially up. If the refcount fell to zero
        // while we were awaiting (last consumer unmounted mid-attach),
        // tear the channel back down to honour their detach intent.
        if ((sessionRefCounts.get(sid) ?? 0) === 0) {
          try {
            await sftpDetach(sid);
          } catch (err) {
            console.warn("[sftp-store] post-attach cleanup detach failed:", err);
          }
          set((state) => {
            const next = { ...state.sessions };
            delete next[sid];
            return { sessions: next };
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sid]: {
              ...(state.sessions[sid] ?? freshSession(sid)),
              attaching: false,
              error: message,
            },
          },
        }));
        throw err;
      }
    })();
    inFlightAttaches.set(sid, attachPromise);

    try {
      await attachPromise;
    } catch (err) {
      // Roll back the refcount so a follow-up retry can attempt attach
      // again without leaking a phantom consumer.
      const remaining = (sessionRefCounts.get(sid) ?? 1) - 1;
      if (remaining > 0) sessionRefCounts.set(sid, remaining);
      else sessionRefCounts.delete(sid);
      throw err;
    } finally {
      // Always clear the in-flight slot; future attaches either inherit
      // the now-attached state or, if attach failed, kick off a fresh one.
      if (inFlightAttaches.get(sid) === attachPromise) {
        inFlightAttaches.delete(sid);
      }
    }
  },

  detach: async (sessionId) => {
    // Refcount-aware teardown: one detach call cancels one attach call.
    // The actual backend channel + store entry only go away when the
    // last consumer releases its reference, so a StrictMode cleanup
    // followed by a remount attach is safe (count goes 1 → 0 → 1 with
    // no backend side effect).
    const remaining = (sessionRefCounts.get(sessionId) ?? 0) - 1;
    if (remaining > 0) {
      sessionRefCounts.set(sessionId, remaining);
      return;
    }
    sessionRefCounts.delete(sessionId);
    // If a backend attach is mid-flight, defer to its post-attach
    // cleanup branch which will detect the zero refcount and tear down.
    // Calling sftpDetach here would race the still-running sftpAttach
    // and could leave the backend in an undefined state.
    if (inFlightAttaches.has(sessionId)) {
      return;
    }
    try {
      await sftpDetach(sessionId);
    } catch (err) {
      console.warn("[sftp-store] detach failed:", err);
    }
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    });
  },

  attachLocalOnly: async (sessionId, initialPath) => {
    // Set up store state for a session that only uses the local pane —
    // no backend SFTP channel is opened. The remote pane stays empty and
    // unused. Refcount mirrors `attach` so the matching `detachLocalOnly`
    // tears the entry down on the last consumer.
    sessionRefCounts.set(sessionId, (sessionRefCounts.get(sessionId) ?? 0) + 1);
    if (get().sessions[sessionId]?.attached) return;

    let path = initialPath?.trim() || "";
    let homeError: string | null = null;
    if (!path) {
      try {
        path = await sftpLocalHome();
      } catch (error) {
        homeError = errorMessage(error);
      }
    }
    const load = homeError
      ? { listing: emptyListing(), error: homeError }
      : await loadInitialListing(sessionId, "local", path);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...(state.sessions[sessionId] ?? freshSession(sessionId)),
          attached: true,
          attaching: false,
          homeDir: null,
          error: null,
          remote: emptyPane(),
          local: {
            ...emptyPane(),
            path,
            ...listingState(load.listing),
            error: load.error,
            history: path ? [path] : [],
            historyIndex: path ? 0 : -1,
          },
        },
      },
    }));
  },

  detachLocalOnly: (sessionId) => {
    const remaining = (sessionRefCounts.get(sessionId) ?? 0) - 1;
    if (remaining > 0) {
      sessionRefCounts.set(sessionId, remaining);
      return;
    }
    sessionRefCounts.delete(sessionId);
    set((state) => {
      const next = { ...state.sessions };
      delete next[sessionId];
      return { sessions: next };
    });
  },

  listPath: async (sessionId, side, path) => (await listSide(sessionId, side, path)).entries,

  refreshPane: async (sessionId, side) => {
    const session = get().sessions[sessionId];
    if (!session) return;
    const pane = session[side];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          [side]: { ...pane, loading: true, error: null },
        },
      },
    }));
    try {
      const listing = await listSide(sessionId, side, pane.path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const nextEntries = listing.entries;
        const alive = new Set(nextEntries.map((e) => e.path));
        const prunedSelection = cur[side].selection.filter((p) => alive.has(p));
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: {
                ...cur[side],
                ...listingState(listing),
                selection: prunedSelection,
                loading: false,
                error: null,
              },
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const nextSession = {
          ...cur,
          [side]: { ...cur[side], loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(err)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
          },
        };
      });
    }
  },

  navigate: async (sessionId, side, path) => {
    // The pane mounts before the SFTP channel has finished attaching. A path
    // submitted during that interval must wait for the channel and initial
    // listing, otherwise it fails with "not attached" or is overwritten.
    if (side === "remote") {
      const attaching = inFlightAttaches.get(sessionId);
      if (attaching) {
        try {
          await attaching;
        } catch {
          return; // attach already published the connection error
        }
        if (!get().sessions[sessionId]?.attached) return;
      }
    }
    const sess = get().ensureSession(sessionId);
    const prev = sess[side];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          [side]: {
            ...prev,
            path,
            entries: [],
            selection: [],
            skippedEntryCount: 0,
            entryDiagnostics: [],
            loading: true,
            error: null,
          },
        },
      },
    }));
    try {
      const listing = await listSide(sessionId, side, path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const after = pushHistory(
          {
            ...cur[side],
            path,
            ...listingState(listing),
            loading: false,
            error: null,
            selection: [],
          },
          path,
        );
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...cur, [side]: after },
          },
        };
      });
    } catch (err) {
      let displayErr = err;
      if (side === "remote" && isSftpRefreshDirectorySignal(err)) {
        try {
          const listing = await listSide(sessionId, side, prev.path);
          set((state) => {
            const cur = state.sessions[sessionId];
            if (!cur) return state;
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...cur,
                  [side]: {
                    ...prev,
                    ...listingState(listing),
                    loading: false,
                    error: null,
                    selection: [],
                  },
                },
              },
            };
          });
          return;
        } catch (refreshErr) {
          displayErr = refreshErr;
        }
      }
      const message = errorMessage(displayErr);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const nextSession = {
          ...cur,
          [side]: { ...prev, loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(displayErr)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
          },
        };
      });
    }
  },

  navigateBack: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const pane = sess[side];
    if (pane.historyIndex <= 0) return;
    const idx = pane.historyIndex - 1;
    const path = pane.history[idx];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...sess,
          [side]: {
            ...pane,
            historyIndex: idx,
            path,
            entries: [],
            selection: [],
            skippedEntryCount: 0,
            entryDiagnostics: [],
            loading: true,
            error: null,
          },
        },
      },
    }));
    try {
      const listing = await listSide(sessionId, side, path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: {
                ...cur[side],
                ...listingState(listing),
                loading: false,
                error: null,
                selection: [],
              },
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const nextSession = {
          ...cur,
          [side]: { ...pane, loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(err)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
          },
        };
      });
    }
  },

  navigateForward: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const pane = sess[side];
    if (pane.historyIndex >= pane.history.length - 1) return;
    const idx = pane.historyIndex + 1;
    const path = pane.history[idx];
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...sess,
          [side]: {
            ...pane,
            historyIndex: idx,
            path,
            entries: [],
            selection: [],
            skippedEntryCount: 0,
            entryDiagnostics: [],
            loading: true,
            error: null,
          },
        },
      },
    }));
    try {
      const listing = await listSide(sessionId, side, path);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...cur,
              [side]: {
                ...cur[side],
                ...listingState(listing),
                loading: false,
                error: null,
                selection: [],
              },
            },
          },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => {
        const cur = state.sessions[sessionId];
        if (!cur) return state;
        const nextSession = {
          ...cur,
          [side]: { ...pane, loading: false, error: message },
        };
        if (side === "remote" && isConnectionError(err)) {
          nextSession.attached = false;
          nextSession.error = message;
        }
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: nextSession,
          },
        };
      });
    }
  },

  navigateUp: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const path = sess[side].path;
    if (!path || path === "/" || path === WINDOWS_DRIVES_ROOT) return;
    const isWin = path.includes("\\");
    // Going "up" from a drive root on the local Windows pane lands on
    // the synthetic drives root so the user sees C:, D:, … as folders.
    if (side === "local" && /^[A-Z]:\\?$/i.test(path)) {
      await get().navigate(sessionId, side, WINDOWS_DRIVES_ROOT);
      return;
    }
    const sep = isWin ? "\\" : "/";
    const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
    const idx = trimmed.lastIndexOf(sep);
    let parent: string;
    if (idx <= 0) {
      parent = isWin ? path.slice(0, 3) : "/";
    } else {
      parent = trimmed.slice(0, idx);
    }
    await get().navigate(sessionId, side, parent);
  },

  navigateHome: async (sessionId, side) => {
    if (side === "remote") {
      const sess = get().sessions[sessionId];
      if (!sess?.homeDir) return;
      await get().navigate(sessionId, side, sess.homeDir);
    } else {
      const home = await sftpLocalHome().catch(() => "");
      if (home) await get().navigate(sessionId, side, home);
    }
  },

  setSelection: (sessionId, side, selection) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, [side]: { ...cur[side], selection } },
        },
      };
    });
  },

  toggleHidden: (sessionId, side) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...cur,
            [side]: { ...cur[side], showHidden: !cur[side].showHidden },
          },
        },
      };
    });
  },

  setError: (sessionId, error) => {
    set((state) => {
      const cur = state.sessions[sessionId];
      if (!cur) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...cur, error },
        },
      };
    });
  },

  reconnect: async (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session || !session.connectionOpts) {
      throw new Error("No connection credentials cached for this session");
    }
    await get().detach(sessionId).catch(() => { });
    await get().attach(session.connectionOpts);
  },
}));

export { type FilePanelSession, type FilePanelStore, type FilePanelStoreHook, type PaneSide, type PaneState, type SftpSessionState } from "./sftp/model";

export { isConnectionError, WINDOWS_DRIVES_ROOT } from "./sftp/listing";
