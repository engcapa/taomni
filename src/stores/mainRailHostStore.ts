import { create } from "zustand";

/**
 * ED-PARITY-027 B: the collapsed sidebar rail publishes a host element; the
 * active tab portals its tool window buttons into it so the window keeps a
 * single tool window bar.
 */
interface MainRailHostState {
  host: HTMLElement | null;
  setHost: (host: HTMLElement | null) => void;
}

export const useMainRailHostStore = create<MainRailHostState>((set) => ({
  host: null,
  setHost: (host) => set((state) => (state.host === host ? state : { host })),
}));
