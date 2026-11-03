import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../lib/ipc/orchestration";
import { useOrchestrationStore } from "./orchestrationStore";
import { deferred, resetOrchestrationHarness, runFixture, settingsFixture } from "../components/agents/orchestration/__tests__/harness";

vi.mock("../lib/ipc/orchestration");

beforeEach(resetOrchestrationHarness);
afterEach(() => { vi.restoreAllMocks(); });
const state = () => useOrchestrationStore.getState();
const input = { projectPath: "/project", goal: "  Build feature  ", intent: "develop" as const, sourcePaths: ["src/config.ts"] };

describe("orchestration projection and command ownership", () => {
  it("deduplicates StrictMode loads and surfaces unavailable IPC without fake settings", async () => {
    const response = deferred<ipc.AgentSettings>();
    vi.mocked(ipc.getAgentSettings).mockReturnValue(response.promise);
    const first = state().load();
    const second = state().load();
    expect(first).toBe(second);
    expect(ipc.getAgentSettings).toHaveBeenCalledTimes(1);
    response.reject(new Error("Backend unavailable"));
    await first;
    expect(state().settings).toBeNull();
    expect(state().error).toContain("Backend unavailable");
    expect(state().loading).toBe(false);
  });

  it("requires real shared settings, project and goal before submission", async () => {
    expect(await state().submit(input)).toBeNull();
    await state().load();
    expect(await state().submit({ ...input, projectPath: "" })).toBeNull();
    expect(await state().submit({ ...input, goal: " " })).toBeNull();
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
    state().setProject("/project");
    await state().submit(input);
    expect(ipc.createAgentRun).toHaveBeenCalledWith({ ...input, goal: "Build feature", commandId: expect.any(String), expectedSettingsRevision: 3 });
    expect(state().selectedRunId).toBe("run-1");
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
  });

  it("reuses the idempotency key after an ambiguous creation failure", async () => {
    await state().load(); state().setProject("/project");
    vi.mocked(ipc.createAgentRun).mockRejectedValueOnce(new Error("Transport disconnected"));
    expect(await state().submit(input)).toBeNull();
    await state().submit(input);
    const calls = vi.mocked(ipc.createAgentRun).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].commandId).toBe(calls[1][0].commandId);
    expect(state().runs).toHaveLength(1);
  });

  it("deduplicates submission and does not steal selection from another project", async () => {
    await state().load(); state().setProject("/project");
    const response = deferred<ipc.AgentRun>();
    vi.mocked(ipc.createAgentRun).mockReturnValue(response.promise);
    const first = state().submit(input);
    expect(await state().submit(input)).toBeNull();
    state().setProject("/other");
    response.resolve(runFixture()); await first;
    expect(ipc.createAgentRun).toHaveBeenCalledTimes(1);
    expect(state().selectedRunId).toBeNull();
    expect(state().runs).toHaveLength(1);
  });

  it("does not steal selection when another task is selected during creation", async () => {
    await state().load(); state().setProject("/project");
    useOrchestrationStore.setState({ runs: [runFixture({ id: "existing" })] });
    const response = deferred<ipc.AgentRun>();
    vi.mocked(ipc.createAgentRun).mockReturnValue(response.promise);
    const submission = state().submit(input);
    state().selectRun("existing");
    response.resolve(runFixture()); await submission;
    expect(state().selectedRunId).toBe("existing");
    expect(state().runs).toHaveLength(2);
  });

  it("restores project-scoped selection without replaying a paid request", async () => {
    useOrchestrationStore.setState({ runs: [runFixture()] });
    state().setProject("/project"); state().selectRun("run-1");
    state().setProject("/other"); expect(state().selectedRunId).toBeNull();
    state().setProject("/project"); expect(state().selectedRunId).toBe("run-1");
    useOrchestrationStore.setState({ projectPath: "", selectedRunId: null, runs: [] });
    state().setProject("/project"); await state().refreshRun("run-1");
    expect(state().selectedRunId).toBe("run-1");
    expect(state().runs[0].goal).toBe("Implement project settings");
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
  });

  it("selects and restores canonical Windows tasks from display-path projects", async () => {
    useOrchestrationStore.setState({ runs: [runFixture({ projectPath: "\\\\?\\C:\\Users\\QA\\project" })] });
    state().setProject("C:/Users/QA/project");
    state().selectRun("run-1");
    expect(state().selectedRunId).toBe("run-1");
    state().setProject("D:/other");
    state().setProject("c:/users/qa/project/");
    expect(state().selectedRunId).toBe("run-1");
  });

  it("rejects stale snapshots arriving after an action, deduplicating snapshot reads", async () => {
    useOrchestrationStore.setState({ runs: [runFixture()] });
    const response = deferred<ipc.AgentRun>();
    vi.mocked(ipc.getAgentRun).mockReturnValue(response.promise);
    const first = state().refreshRun("run-1");
    const second = state().refreshRun("run-1");
    await state().start("run-1");
    response.resolve(runFixture({ revision: 2 })); await Promise.all([first, second]);
    expect(ipc.getAgentRun).toHaveBeenCalledTimes(1);
    expect(ipc.startAgentRun).toHaveBeenCalledWith("run-1", 2);
    expect(state().runs[0].status).toBe("running");
    expect(state().runs[0].revision).toBe(3);
  });

  it("saves shared defaults with CAS and keeps historical snapshots immutable", async () => {
    const original = runFixture();
    useOrchestrationStore.setState({ settings: settingsFixture(), runs: [original] });
    await state().saveSettings({ ...settingsFixture(), name: "New defaults" });
    expect(ipc.saveAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ name: "New defaults" }), 3);
    expect(state().settings?.revision).toBe(4);
    expect(state().runs[0].settingsSnapshot.name).toBe("Daily development");
    expect(state().runs[0]).toBe(original);
    vi.mocked(ipc.saveAgentSettings).mockRejectedValue(new Error("Revision conflict"));
    await expect(state().saveSettings(settingsFixture())).rejects.toThrow("Revision conflict");
    expect(state().settings?.name).toBe("New defaults");
    expect(state().saving).toBe(false);
  });

  it("shows cancellation acknowledgement instead of inventing a cancelled terminal state", async () => {
    useOrchestrationStore.setState({ runs: [runFixture({ status: "running" })] });
    await state().cancel("run-1");
    expect(ipc.cancelAgentRun).toHaveBeenCalledWith("run-1");
    expect(state().runs[0].status).toBe("stopping");
  });

  it("preserves partial artifacts on failed recovery and uses the task revision", async () => {
    const partial = runFixture({ status: "partial", artifacts: [{ id: "design", itemId: "design", name: "design.md", format: "markdown", content: "Saved design", hash: "hash", status: "candidate" }] });
    useOrchestrationStore.setState({ runs: [partial] });
    vi.mocked(ipc.recoverAgentRun).mockRejectedValue(new Error("Proxy connection failed"));
    await expect(state().recover("run-1")).rejects.toThrow("Proxy connection failed");
    expect(ipc.recoverAgentRun).toHaveBeenCalledWith("run-1", 2);
    expect(state().runs[0].artifacts[0].content).toBe("Saved design");
    expect(state().error).toContain("Proxy connection failed");
    expect(state().pending).toBeNull();
  });
});
