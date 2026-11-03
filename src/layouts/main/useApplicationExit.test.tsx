import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApplicationExit } from "./useApplicationExit";
import { agentActiveRuns } from "../../lib/ipc/orchestration";
import { exitApp } from "../../lib/ipc";

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => vi.fn()) }) }));
vi.mock("../../lib/ipc/orchestration", () => ({ agentActiveRuns: vi.fn(async () => 0) }));
vi.mock("../../lib/ipc", () => ({ exitApp: vi.fn(async () => undefined) }));
vi.mock("../../lib/queryRegistry", () => ({ listQueryTabs: () => [] }));
vi.mock("../../stores/backupSettingsStore", () => ({ saveBackupSettingsBeforeExit: vi.fn(async () => true) }));
vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));

function harness(confirm = vi.fn(async () => true)) {
  const inFlight = { current: false };
  const hook = renderHook(() => useApplicationExit({
    tabsRef: { current: [] }, exitRequestInFlightRef: inFlight, confirmAppExit: confirm,
  }));
  return { ...hook, confirm, inFlight };
}

describe("application exit with backend-owned agent tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(agentActiveRuns).mockResolvedValue(0);
    vi.mocked(exitApp).mockResolvedValue(undefined);
  });

  it("asks before stopping active tasks even with no closable tabs", async () => {
    vi.mocked(agentActiveRuns).mockResolvedValue(2);
    const { result, confirm, inFlight } = harness(vi.fn(async () => false));
    act(() => result.current.requestAppExit());
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "exit.agentTasks" })));
    await waitFor(() => expect(inFlight.current).toBe(false));
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("confirmed exit delegates cleanup to backend exactly once", async () => {
    vi.mocked(agentActiveRuns).mockResolvedValue(1);
    const { result } = harness();
    act(() => { result.current.requestAppExit(); result.current.requestAppExit(); });
    await waitFor(() => expect(exitApp).toHaveBeenCalledTimes(1));
    expect(agentActiveRuns).toHaveBeenCalledTimes(1);
  });

  it("cannot silently exit if authoritative task state is unavailable", async () => {
    vi.mocked(agentActiveRuns).mockRejectedValueOnce("database unavailable");
    const { result, confirm, inFlight } = harness(vi.fn(async () => false));
    act(() => result.current.requestAppExit());
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "exit.cleanupFailedTitle" })));
    await waitFor(() => expect(inFlight.current).toBe(false));
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("allows authoritative state retry without sending duplicate exits", async () => {
    vi.mocked(agentActiveRuns).mockRejectedValueOnce("temporary database issue").mockResolvedValueOnce(0);
    const { result } = harness();
    act(() => result.current.requestAppExit());
    await waitFor(() => expect(exitApp).toHaveBeenCalledTimes(1));
    expect(agentActiveRuns).toHaveBeenCalledTimes(2);
  });
});
