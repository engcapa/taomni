import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  status: vi.fn(),
  listProfiles: vi.fn(),
  listRuleSources: vi.fn(),
  statsSnapshot: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  recover: vi.fn(),
  clearStats: vi.fn(),
  listEgressSessions: vi.fn(),
}));

vi.mock("../../lib/sockscap", () => ({
  sockscap: ipc,
}));

import { SockscapWindow } from "./SockscapWindow";
import { useSockscapStore } from "../../stores/sockscapStore";

const caps = {
  platform: "linux",
  globalCapture: "requires-setup" as const,
  appCapture: "degraded" as const,
  pidCapture: "unsupported" as const,
  childFollow: false,
  trayLeftClickToggle: false,
  requiresPrivilege: true,
  notes: ["cgroup v2 not detected; PID attach unavailable"],
};

const zeroStats = {
  bytesUp: 0,
  bytesDown: 0,
  connections: 0,
  errors: 0,
  direct: 0,
  proxy: 0,
  block: 0,
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
  ipc.status.mockResolvedValue({ state: { state: "disabled" }, capabilities: caps });
  ipc.listProfiles.mockResolvedValue([]);
  ipc.listRuleSources.mockResolvedValue([]);
  ipc.statsSnapshot.mockResolvedValue(zeroStats);
  ipc.listEgressSessions.mockResolvedValue([]);
});

afterEach(cleanup);

describe("SockscapWindow", () => {
  it("renders the status bar and honest capability banner", async () => {
    render(<SockscapWindow />);
    await waitFor(() => expect(ipc.status).toHaveBeenCalled());
    expect(screen.getByText("Sockscap")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    // Capability banner surfaces the degraded/unsupported scopes honestly.
    await waitFor(() =>
      expect(screen.getByText(/pid:\s*unsupported/i)).toBeInTheDocument(),
    );
  });

  it("shows Start when disabled and surfaces a fail-open backend error", async () => {
    ipc.start.mockRejectedValue("capture backend not available");
    render(<SockscapWindow />);
    await waitFor(() => expect(screen.getByText("Start")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Start"));
    await waitFor(() =>
      expect(screen.getByText(/backend not available/i)).toBeInTheDocument(),
    );
    // Still Disabled — never a fake Active.
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("shows Stop when the engine is active", async () => {
    ipc.status.mockResolvedValue({ state: { state: "active" }, capabilities: caps });
    render(<SockscapWindow />);
    await waitFor(() => expect(screen.getByText("Active")).toBeInTheDocument());
    expect(screen.getByText("Stop")).toBeInTheDocument();
  });
});
