import { beforeEach, describe, expect, it, vi } from "vitest";

// The IPC layer talks to Tauri; mock it so the store logic is tested in
// isolation.
vi.mock("../lib/sockscap", () => ({
  sockscap: {
    status: vi.fn(),
    listProfiles: vi.fn(),
    listRuleSources: vi.fn(),
    statsSnapshot: vi.fn(),
    upsertProfile: vi.fn(),
    deleteProfile: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    recover: vi.fn(),
    clearStats: vi.fn(),
  },
}));

import { useSockscapStore } from "./sockscapStore";
import { sockscap } from "../lib/sockscap";

const mocked = vi.mocked(sockscap);
const get = () => useSockscapStore.getState();

const capabilities = {
  platform: "windows",
  globalCapture: "requires-setup" as const,
  appCapture: "requires-setup" as const,
  pidCapture: "requires-setup" as const,
  childFollow: true,
  trayLeftClickToggle: true,
  requiresPrivilege: true,
  notes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  useSockscapStore.setState({
    status: null,
    capabilities: null,
    profiles: [],
    ruleSources: [],
    stats: null,
    loading: false,
    busy: false,
    error: null,
  });
});

describe("sockscapStore", () => {
  it("refreshAll populates status, profiles, sources and stats", async () => {
    mocked.status.mockResolvedValue({ state: { state: "disabled" }, capabilities });
    mocked.listProfiles.mockResolvedValue([]);
    mocked.listRuleSources.mockResolvedValue([]);
    mocked.statsSnapshot.mockResolvedValue({
      bytesUp: 0,
      bytesDown: 0,
      connections: 0,
      errors: 0,
      direct: 0,
      proxy: 0,
      block: 0,
    });

    await get().refreshAll();

    expect(get().status).toEqual({ state: "disabled" });
    expect(get().capabilities?.platform).toBe("windows");
    expect(get().loading).toBe(false);
    expect(get().error).toBeNull();
  });

  it("surfaces a start failure and re-reads status (fail-open, no fake active)", async () => {
    mocked.start.mockRejectedValue("capture backend not available");
    mocked.status.mockResolvedValue({ state: { state: "disabled" }, capabilities });

    await get().start();

    expect(get().error).toContain("backend not available");
    expect(mocked.status).toHaveBeenCalled();
    expect(get().busy).toBe(false);
  });

  it("saveProfile persists and refreshes the list", async () => {
    mocked.upsertProfile.mockResolvedValue(undefined);
    mocked.listProfiles.mockResolvedValue([
      { id: "p1" } as unknown as never,
    ]);

    await get().saveProfile({ id: "p1", name: "x" } as unknown as never);

    expect(mocked.upsertProfile).toHaveBeenCalled();
    expect(get().profiles).toHaveLength(1);
  });

  it("saveProfile rethrows a conflict so the editor can show it", async () => {
    mocked.upsertProfile.mockRejectedValue("profile conflict: two globals");
    await expect(
      get().saveProfile({ id: "g", name: "g" } as unknown as never),
    ).rejects.toBeDefined();
    expect(get().error).toContain("conflict");
  });
});
