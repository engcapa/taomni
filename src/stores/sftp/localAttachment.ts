import type { StoreApi } from "zustand";
import { sftpLocalHome } from "../../lib/sftp";
import { sessionRefCounts } from "./lifetime";
import { inFlightLocalAttaches } from "./localLifetime";
import { emptyListing, emptyPane, errorMessage, freshSession, listingState, loadInitialListing } from "./listing";
import { invalidatePaneRequests } from "./navigation";
import type { SftpStoreState } from "./model";

export function createLocalAttachment(set: StoreApi<SftpStoreState>["setState"], get: StoreApi<SftpStoreState>["getState"]):
  Pick<SftpStoreState, "attachLocalOnly" | "detachLocalOnly"> {
  return {
    attachLocalOnly: async (id, initialPath) => {
      sessionRefCounts.set(id, (sessionRefCounts.get(id) ?? 0) + 1);
      if (get().sessions[id]?.attached) return;
      const pending = inFlightLocalAttaches.get(id);
      if (pending) return pending;
      const before = get().sessions[id] ?? freshSession(id);
      set((state) => ({ sessions: { ...state.sessions, [id]: { ...before, attaching: true } } }));
      const promise = Promise.resolve().then(async () => {
        let path = initialPath?.trim() ?? "";
        let homeError: string | null = null;
        if (!path) {
          try { path = await sftpLocalHome(); } catch (error) { homeError = errorMessage(error); }
        }
        const result = homeError ? { listing: emptyListing(), error: homeError } : await loadInitialListing(id, "local", path);
        if (inFlightLocalAttaches.get(id) !== promise || !(sessionRefCounts.get(id) ?? 0)) return;
        set((state) => ({ sessions: { ...state.sessions, [id]: {
          ...(state.sessions[id] ?? freshSession(id)), attached: true, attaching: false, error: null,
          local: { ...emptyPane(), path, ...listingState(result.listing), error: result.error,
            history: path ? [path] : [], historyIndex: path ? 0 : -1 },
        } } }));
      }).finally(() => { if (inFlightLocalAttaches.get(id) === promise) inFlightLocalAttaches.delete(id); });
      inFlightLocalAttaches.set(id, promise);
      return promise;
    },
    detachLocalOnly: (id) => {
      const remaining = (sessionRefCounts.get(id) ?? 0) - 1;
      if (remaining > 0) { sessionRefCounts.set(id, remaining); return; }
      sessionRefCounts.delete(id);
      inFlightLocalAttaches.delete(id);
      invalidatePaneRequests(id);
      set((state) => {
        const next = { ...state.sessions };
        delete next[id];
        return { sessions: next };
      });
    },
  };
}
