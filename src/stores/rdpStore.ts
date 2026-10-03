import { create } from "zustand";

export type RdpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface RdpConnectionState {
  status: RdpConnectionStatus;
  sessionId: string | null;
  wsPort: number | null;
  width: number;
  height: number;
  protocol: string;
  serverName: string;
  error: string | null;
  /** Free-form status text from the relay (e.g. "awaiting-session"). */
  stage: string | null;
}

interface RdpStore {
  connections: Record<string, RdpConnectionState>;

  initConnection: (tabId: string) => void;
  setConnecting: (tabId: string, sessionId: string, wsPort: number) => void;
  setConnected: (
    tabId: string,
    width: number,
    height: number,
    protocol: string,
    serverName: string,
  ) => void;
  setStage: (tabId: string, stage: string) => void;
  setDisconnected: (tabId: string, reason?: string) => void;
  removeConnection: (tabId: string) => void;
}

const EMPTY: RdpConnectionState = {
  status: "disconnected",
  sessionId: null,
  wsPort: null,
  width: 0,
  height: 0,
  protocol: "",
  serverName: "",
  error: null,
  stage: null,
};

export const useRdpStore = create<RdpStore>((set) => ({
  connections: {},

  initConnection(tabId) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: { ...EMPTY, status: "connecting" },
      },
    }));
  },

  setConnecting(tabId, sessionId, wsPort) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? EMPTY),
          status: "connecting",
          sessionId,
          wsPort,
          error: null,
        },
      },
    }));
  },

  setConnected(tabId, width, height, protocol, serverName) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? EMPTY),
          status: "connected",
          width,
          height,
          protocol,
          serverName,
          error: null,
        },
      },
    }));
  },

  setStage(tabId, stage) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? EMPTY),
          stage,
        },
      },
    }));
  },

  setDisconnected(tabId, reason) {
    set((s) => ({
      connections: {
        ...s.connections,
        [tabId]: {
          ...(s.connections[tabId] ?? EMPTY),
          status: reason ? "error" : "disconnected",
          error: reason ?? null,
        },
      },
    }));
  },

  removeConnection(tabId) {
    set((s) => {
      const next = { ...s.connections };
      delete next[tabId];
      return { connections: next };
    });
  },
}));
