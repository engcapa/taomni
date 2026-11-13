import { create } from "zustand";
import { parentPath } from "../lib/filePaths";
import { sftpAttach, sftpDetach, sftpLocalHome, sftpRealpath } from "../lib/sftp";
import { inFlightAttaches, sessionRefCounts } from "./sftp/lifetime";
import {
  emptyListing,
  emptyPane,
  errorMessage,
  freshSession,
  listingState,
  listSide,
  loadInitialListing,
  WINDOWS_DRIVES_ROOT,
} from "./sftp/listing";
import { type SftpStoreState } from "./sftp/model";
import { createLocalAttachment } from "./sftp/localAttachment";
import { createPaneNavigation, invalidatePaneRequests } from "./sftp/navigation";

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
    invalidatePaneRequests(sessionId);
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

  ...createLocalAttachment(set, get),

  listPath: async (sessionId, side, path) => (await listSide(sessionId, side, path)).entries,

  ...createPaneNavigation(set, get),

  navigateUp: async (sessionId, side) => {
    const sess = get().sessions[sessionId];
    if (!sess) return;
    const path = sess[side].path;
    if (!path || path === "/" || path === WINDOWS_DRIVES_ROOT) return;
    // Drive roots go to This PC; an UNC share root cannot go above its share.
    if (side === "local" && /^[A-Z]:[\\/]?$/i.test(path)) {
      await get().navigate(sessionId, side, WINDOWS_DRIVES_ROOT);
      return;
    }
    const parent = parentPath(path);
    if (parent === path) return;
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
