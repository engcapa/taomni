import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./sessionStore";
import type { SessionConfig, SessionGroup } from "../lib/ipc";

const ipcMocks = vi.hoisted(() => ({
  listSessions: vi.fn<() => Promise<SessionConfig[]>>(async () => []),
  listSessionGroups: vi.fn<() => Promise<SessionGroup[]>>(async () => []),
  saveSession: vi.fn<(cfg: SessionConfig) => Promise<void>>(async () => undefined),
  deleteSession: vi.fn<(id: string) => Promise<void>>(async () => undefined),
  saveSessionGroup: vi.fn(async () => undefined),
  deleteSessionGroup: vi.fn(async () => undefined),
  markSessionConnected: vi.fn(async () => 0),
}));

vi.mock("../lib/ipc", () => ipcMocks);

function makeSession(id: string, name: string, groupPath: string | null): SessionConfig {
  return {
    id,
    name,
    session_type: "SSH",
    group_path: groupPath,
    host: `${id}.example.test`,
    port: 22,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: null,
    sort_order: 0,
  };
}

const a = makeSession("a", "Alpha", "User sessions / ipy");
const b = makeSession("b", "Bravo", "User sessions / ipy");
const c = makeSession("c", "Charlie", "User sessions / person");

function seed(selectedIds: string[] = []) {
  useSessionStore.setState({
    sessions: [a, b, c],
    groups: [],
    loading: false,
    selectedSessionId: selectedIds[selectedIds.length - 1] ?? null,
    selectedSessionIds: selectedIds,
    searchQuery: "",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  ipcMocks.listSessions.mockResolvedValue([a, b, c]);
  ipcMocks.listSessionGroups.mockResolvedValue([]);
  seed();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("sessionStore selection model", () => {
  it("setSelectedSessionIds dedupes and tracks the last id as the anchor", () => {
    useSessionStore.getState().setSelectedSessionIds(["a", "b", "a"]);
    const s = useSessionStore.getState();
    expect(s.selectedSessionIds).toEqual(["a", "b"]);
    expect(s.selectedSessionId).toBe("b");
  });

  it("toggleSessionSelection adds then removes an id and re-anchors", () => {
    const { toggleSessionSelection } = useSessionStore.getState();
    toggleSessionSelection("a");
    toggleSessionSelection("b");
    expect(useSessionStore.getState().selectedSessionIds).toEqual(["a", "b"]);
    expect(useSessionStore.getState().selectedSessionId).toBe("b");
    toggleSessionSelection("b");
    expect(useSessionStore.getState().selectedSessionIds).toEqual(["a"]);
    expect(useSessionStore.getState().selectedSessionId).toBe("a");
  });

  it("clearSelection empties both the anchor and the set", () => {
    seed(["a", "b"]);
    useSessionStore.getState().clearSelection();
    expect(useSessionStore.getState().selectedSessionIds).toEqual([]);
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });
});
describe("sessionStore batch operations", () => {
  it("removeSessions deletes each id and prunes the selection", async () => {
    seed(["a", "b", "c"]);
    await useSessionStore.getState().removeSessions(["a", "b"]);
    expect(ipcMocks.deleteSession).toHaveBeenCalledTimes(2);
    expect(ipcMocks.deleteSession.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    const s = useSessionStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(["c"]);
    expect(s.selectedSessionIds).toEqual(["c"]);
  });

  it("removeSessions ignores duplicate ids and empty input", async () => {
    seed(["a"]);
    await useSessionStore.getState().removeSessions([]);
    expect(ipcMocks.deleteSession).not.toHaveBeenCalled();
    await useSessionStore.getState().removeSessions(["a", "a"]);
    expect(ipcMocks.deleteSession).toHaveBeenCalledTimes(1);
  });

  it("duplicateSessions saves a copy per source and selects the copies", async () => {
    const saved: SessionConfig[] = [];
    ipcMocks.saveSession.mockImplementation(async (cfg: SessionConfig) => {
      saved.push(cfg);
    });
    await useSessionStore.getState().duplicateSessions(["a", "c"]);
    expect(saved).toHaveLength(2);
    expect(saved.map((x) => x.name)).toEqual(["Alpha (copy)", "Charlie (copy)"]);
    expect(saved[0].id).not.toBe("a");
    expect(saved[0].group_path).toBe("User sessions / ipy");
    const s = useSessionStore.getState();
    expect(s.selectedSessionIds).toEqual(saved.map((x) => x.id));
    expect(s.selectedSessionId).toBe(saved[1].id);
  });

  it("moveSessionsToGroup writes the stored group path for every target", async () => {
    const saved: SessionConfig[] = [];
    ipcMocks.saveSession.mockImplementation(async (cfg: SessionConfig) => {
      saved.push(cfg);
    });
    await useSessionStore.getState().moveSessionsToGroup(["a", "b"], "Favorites");
    expect(saved.map((x) => x.id).sort()).toEqual(["a", "b"]);
    for (const cfg of saved) {
      expect(cfg.group_path).toBe("User sessions / Favorites");
    }
  });

  it("moveSessionsToGroup to the root clears the stored group path", async () => {
    const saved: SessionConfig[] = [];
    ipcMocks.saveSession.mockImplementation(async (cfg: SessionConfig) => {
      saved.push(cfg);
    });
    await useSessionStore.getState().moveSessionsToGroup(["c"], null);
    expect(saved).toHaveLength(1);
    expect(saved[0].group_path).toBeNull();
  });

  it("updateSessionsTerminalTheme writes terminal profiles and skips non-terminal sessions", async () => {
    const ssh: SessionConfig = {
      ...a,
      options_json: JSON.stringify({
        description: "keep me",
        terminalProfile: {
          ...JSON.parse(a.options_json || "{}").terminalProfile,
          fontSize: 18,
          theme: "classic",
        },
      }),
    };
    const mail: SessionConfig = {
      ...makeSession("mail", "Mail", null),
      session_type: "Mail",
      options_json: JSON.stringify({
        mailCacheEnabled: true,
        terminalProfile: { theme: "system" },
      }),
    };
    const sftp: SessionConfig = {
      ...makeSession("sftp", "SFTP", null),
      session_type: "SFTP",
      options_json: JSON.stringify({
        terminalProfile: { theme: "classic" },
      }),
    };
    useSessionStore.setState({
      sessions: [ssh, mail, sftp],
      groups: [],
      loading: false,
      selectedSessionId: null,
      selectedSessionIds: [],
      searchQuery: "",
    });
    const saved: SessionConfig[] = [];
    ipcMocks.saveSession.mockImplementation(async (cfg: SessionConfig) => {
      saved.push(cfg);
    });

    const count = await useSessionStore.getState().updateSessionsTerminalTheme(["a", "mail", "sftp"], "kanagawa-wave");

    expect(count).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("a");
    const options = JSON.parse(saved[0].options_json);
    expect(options.description).toBe("keep me");
    expect(options.terminalProfile.theme).toBe("kanagawa-wave");
    expect(options.terminalProfile.fontSize).toBe(18);
  });

  it("updateSessionsTerminalAppearance writes font settings and skips non-terminal sessions", async () => {
    const ssh: SessionConfig = {
      ...a,
      options_json: JSON.stringify({
        description: "keep me",
        terminalProfile: {
          ...JSON.parse(a.options_json || "{}").terminalProfile,
          theme: "classic",
          fontSize: 18,
        },
      }),
    };
    const mail: SessionConfig = {
      ...makeSession("mail", "Mail", null),
      session_type: "Mail",
      options_json: JSON.stringify({
        terminalProfile: { theme: "system" },
      }),
    };
    const rdp: SessionConfig = {
      ...makeSession("rdp", "RDP", null),
      session_type: "RDP",
      options_json: JSON.stringify({
        terminalProfile: { theme: "classic" },
      }),
    };
    useSessionStore.setState({
      sessions: [ssh, mail, rdp],
      groups: [],
      loading: false,
      selectedSessionId: null,
      selectedSessionIds: [],
      searchQuery: "",
    });
    const saved: SessionConfig[] = [];
    ipcMocks.saveSession.mockImplementation(async (cfg: SessionConfig) => {
      saved.push(cfg);
    });

    const count = await useSessionStore.getState().updateSessionsTerminalAppearance(["a", "mail", "rdp"], {
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 16,
    });

    expect(count).toBe(1);
    expect(saved).toHaveLength(1);
    const options = JSON.parse(saved[0].options_json);
    expect(options.description).toBe("keep me");
    expect(options.terminalProfile.theme).toBe("classic");
    expect(options.terminalProfile.fontFamily).toContain("JetBrains Mono");
    expect(options.terminalProfile.fontSize).toBe(16);
  });
});
