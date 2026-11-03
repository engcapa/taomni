import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../../../../lib/ipc/orchestration";
import { useOrchestrationStore } from "../../../../stores/orchestrationStore";
import { AgentsPlatformView } from "../../AgentsPlatformView";
import { deferred, resetOrchestrationHarness, runFixture } from "./harness";

vi.mock("../../../../lib/ipc/orchestration");
beforeEach(resetOrchestrationHarness);
afterEach(cleanup);
const partial = () => runFixture({ status: "partial", artifacts: [{ id: "design", itemId: "design", name: "design.md", format: "markdown", content: "# Real preserved candidate\nDo not replace me", hash: "saved-hash", status: "candidate" }], requestCount: 1, error: "Missing tests frame" });
async function selectPartial() {
  const run = partial();
  vi.mocked(ipc.listAgentRuns).mockResolvedValue([run]);
  vi.mocked(ipc.getAgentRun).mockResolvedValue(run);
  render(<AgentsPlatformView />);
  fireEvent.click(await screen.findByTestId("orch-run-run-1"));
  await screen.findByTestId("orch-partial");
}

describe("read-only sources and explicit one-request recovery", () => {
  it("loads actual context on demand with no model request and renders full source text", async () => {
    render(<AgentsPlatformView />);
    await waitFor(() => expect(screen.getByTestId("orch-composer-settings")).toHaveTextContent("Daily development"));
    expect(ipc.previewAgentContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("orch-show-sources"));
    const source = await screen.findByTestId("orch-source-rules");
    expect(source).toHaveTextContent("AGENTS.md");
    expect(source).toHaveTextContent("Preserve existing IPC contracts.");
    expect(screen.getByTestId("orch-context-estimate")).toHaveTextContent("25 tokens");
    expect(ipc.previewAgentContext).toHaveBeenCalledWith("/project", []);
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("orch-inspector-close"));
    expect(screen.queryByTestId("orch-inspector")).not.toBeInTheDocument();
  });

  it("ignores stale context results after changing selected source paths", async () => {
    const first = deferred<ipc.AgentContextPreview>();
    vi.mocked(ipc.previewAgentContext).mockReturnValueOnce(first.promise).mockResolvedValueOnce({ sources: [{ id: "new", path: "new.ts", content: "Current context", hash: "new-hash" }], estimatedInputTokens: 10, estimateMethod: "fixture", warnings: [] });
    render(<AgentsPlatformView />);
    await waitFor(() => expect(screen.getByTestId("orch-composer-settings")).toHaveTextContent("Daily development"));
    fireEvent.click(screen.getByTestId("orch-show-sources"));
    fireEvent.click(screen.getByTestId("orch-attach"));
    fireEvent.change(screen.getByTestId("orch-source-paths"), { target: { value: "new.ts" } });
    expect(await screen.findByTestId("orch-source-new")).toHaveTextContent("Current context");
    await act(async () => { first.resolve({ sources: runFixture().sources, estimatedInputTokens: 25, estimateMethod: "stale", warnings: [] }); await first.promise; });
    expect(screen.queryByTestId("orch-source-rules")).not.toBeInTheDocument();
    expect(screen.getByTestId("orch-source-new")).toBeInTheDocument();
  });

  it("shows preview errors and retries without hiding missing context", async () => {
    vi.mocked(ipc.previewAgentContext).mockRejectedValueOnce(new Error("Required source missing"));
    render(<AgentsPlatformView />);
    await waitFor(() => expect(screen.getByTestId("orch-composer-settings")).toHaveTextContent("Daily development"));
    fireEvent.click(screen.getByTestId("orch-show-sources"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Required source missing");
    fireEvent.click(screen.getByTestId("orch-preview-retry"));
    await screen.findByTestId("orch-source-rules");
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
  });

  it("restores partial candidates, uses frozen context and opens an actual artifact without fake diffs", async () => {
    await selectPartial();
    expect(screen.getByTestId("orch-partial")).toHaveTextContent("Partial results are preserved");
    expect(screen.getByTestId("orch-run-error")).toHaveTextContent("Missing tests frame");
    expect(ipc.recoverAgentRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("orch-partial-artifact-design"));
    expect(screen.getByTestId("orch-artifact-content")).toHaveTextContent("Real preserved candidate");
    expect(screen.getByTestId("orch-artifacts-panel")).toHaveTextContent("not accepted, applied, merged");
    fireEvent.click(screen.getByTestId("orch-inspector-sources"));
    expect(screen.getByTestId("orch-source-rules")).toHaveTextContent("Preserve existing IPC contracts");
    expect(ipc.previewAgentContext).not.toHaveBeenCalled();
    expect(screen.queryByTestId("orch-approve-plan")).not.toBeInTheDocument();
  });

  it("requires explicit recovery consent, shows original settings and unknown cost, and dismisses without a request", async () => {
    await selectPartial();
    fireEvent.click(screen.getByTestId("orch-recovery-open"));
    expect(screen.getByTestId("orch-recovery-dialog")).toHaveTextContent("Daily development · revision 3");
    expect(screen.getByTestId("orch-recovery-dialog")).toHaveTextContent("Exact cost is unknown");
    fireEvent.click(screen.getByTestId("orch-recovery-dismiss"));
    expect(ipc.recoverAgentRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("orch-recovery-open"));
    fireEvent.click(screen.getByTestId("orch-recovery-confirm"));
    await waitFor(() => expect(screen.queryByTestId("orch-recovery-dialog")).not.toBeInTheDocument());
    expect(ipc.recoverAgentRun).toHaveBeenCalledTimes(1);
    expect(ipc.recoverAgentRun).toHaveBeenCalledWith("run-1", 2);
    expect(screen.getByTestId("orch-running")).toBeInTheDocument();
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
  });

  it("keeps candidates and the recovery dialog intact after a failed request", async () => {
    vi.mocked(ipc.recoverAgentRun).mockRejectedValue(new Error("Configured proxy unavailable"));
    await selectPartial();
    fireEvent.click(screen.getByTestId("orch-recovery-open"));
    fireEvent.click(screen.getByTestId("orch-recovery-confirm"));
    expect(await screen.findByTestId("orch-recovery-error")).toHaveTextContent("Configured proxy unavailable");
    expect(useOrchestrationStore.getState().runs[0].artifacts[0].hash).toBe("saved-hash");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("orch-recovery-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("orch-partial-artifact-design")).toBeInTheDocument();
  });

  it("does not offer another recovery once the one-request allowance was consumed", async () => {
    vi.mocked(ipc.listAgentRuns).mockResolvedValue([partial()]);
    vi.mocked(ipc.getAgentRun).mockResolvedValue({ ...partial(), recoveryCount: 1, revision: 3 });
    render(<AgentsPlatformView />);
    fireEvent.click(await screen.findByTestId("orch-run-run-1"));
    await screen.findByTestId("orch-recovery-used");
    expect(screen.queryByTestId("orch-recovery-open")).not.toBeInTheDocument();
    expect(ipc.recoverAgentRun).not.toHaveBeenCalled();
  });
});
