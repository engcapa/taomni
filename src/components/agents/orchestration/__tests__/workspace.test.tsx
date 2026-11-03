import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "../../../../lib/ipc/orchestration";
import { setLocale } from "../../../../lib/i18n";
import { useOrchestrationStore } from "../../../../stores/orchestrationStore";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../../../stores/workspacePlatformStore";
import { AgentsPlatformView } from "../../AgentsPlatformView";
import { deferred, resetOrchestrationHarness, runFixture } from "./harness";

vi.mock("../../../../lib/ipc/orchestration");

beforeEach(resetOrchestrationHarness);
afterEach(() => { cleanup(); vi.useRealTimers(); });
const ready = () => waitFor(() => expect(screen.getByTestId("orch-composer-settings")).toHaveTextContent("Daily development"));

describe("approved development Agent workspace", () => {
  it("starts with real project, shared defaults, suggestions and a collapsed inspector", async () => {
    render(<StrictMode><AgentsPlatformView /></StrictMode>); await ready();
    expect(screen.getByTestId("orch-empty-state")).toHaveTextContent("Start developing in project");
    expect(screen.getByTestId("orch-project-select")).toHaveValue("/project");
    expect(screen.queryByTestId("orch-inspector")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agents-coming-soon")).not.toBeInTheDocument();
    expect(ipc.getAgentSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("orch-suggest-plan"));
    expect(screen.getByTestId("orch-intent")).toHaveValue("plan");
    expect((screen.getByTestId("orch-prompt") as HTMLTextAreaElement).value).toContain("architecture");
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
  });

  it("blocks creation without a local workspace root, without inventing a project path", async () => {
    const workspace = useWorkspacePlatformStore.getState().getWorkspace()!;
    useWorkspacePlatformStore.getState().removeRootFolder(DEFAULT_WORKSPACE_ID, workspace.rootFolders[0].id);
    render(<AgentsPlatformView />); await ready();
    expect(screen.getByTestId("orch-project-blocked")).toHaveTextContent("Add a local project folder");
    expect(screen.getByTestId("orch-prompt")).toBeDisabled();
    expect(screen.getByTestId("orch-send")).toBeDisabled();
    expect(screen.getByTestId("orch-project-select")).toHaveValue("");
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
  });

  it("adds an explicit project through the shared workspace folder dialog", async () => {
    const workspace = useWorkspacePlatformStore.getState().getWorkspace()!;
    useWorkspacePlatformStore.getState().removeRootFolder(DEFAULT_WORKSPACE_ID, workspace.rootFolders[0].id);
    render(<AgentsPlatformView />); await ready();
    fireEvent.click(screen.getByTestId("orch-project-add"));
    expect(screen.getByTestId("workspace-fs-modal")).toHaveAttribute("data-kind", "root");
    expect(screen.getByTestId("workspace-fs-modal-input")).toHaveValue("");
    fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "/chosen/project" } });
    fireEvent.click(screen.getByTestId("workspace-fs-modal-confirm"));
    await waitFor(() => expect(screen.queryByTestId("workspace-fs-modal")).not.toBeInTheDocument());
    expect(screen.getByTestId("orch-project-select")).toHaveValue("/chosen/project");
    expect(screen.getByTestId("orch-prompt")).not.toBeDisabled();
    expect(useWorkspacePlatformStore.getState().getWorkspace()?.rootFolders[0].path).toBe("/chosen/project");
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
  });

  it("creates a planned run, starts only after approval, and renders actual events", async () => {
    render(<AgentsPlatformView />); await ready();
    fireEvent.change(screen.getByTestId("orch-prompt"), { target: { value: "Implement project settings" } });
    fireEvent.change(screen.getByTestId("orch-intent"), { target: { value: "plan" } });
    fireEvent.click(screen.getByTestId("orch-attach"));
    fireEvent.change(screen.getByTestId("orch-source-paths"), { target: { value: "src/config.ts\nAGENTS.md" } });
    fireEvent.click(screen.getByTestId("orch-send"));
    await screen.findByTestId("orch-approve-plan");
    expect(ipc.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ projectPath: "/project", intent: "plan", goal: "Implement project settings", sourcePaths: ["src/config.ts", "AGENTS.md"], expectedSettingsRevision: 3 }));
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
    expect(screen.getByTestId("orch-step-design")).toHaveTextContent("Design the change");
    vi.mocked(ipc.startAgentRun).mockResolvedValue(runFixture({ revision: 3, status: "running", events: [{ sequence: 1, kind: "started", message: "Worker started in isolated worktree", createdAt: 2 }] }));
    fireEvent.click(screen.getByTestId("orch-approve-plan"));
    await screen.findByTestId("orch-running");
    expect(screen.getByTestId("orch-event")).toHaveTextContent("Worker started in isolated worktree");
    expect(screen.queryByTestId("orch-approve-plan")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("orch-cancel-run"));
    await waitFor(() => expect(screen.getByTestId("orch-run-status")).toHaveAttribute("data-status", "stopping"));
    expect(screen.getByTestId("orch-cancel-run")).toBeDisabled();
  });

  it("restores a selected persisted run and only polls while a native task is live", async () => {
    vi.useFakeTimers();
    const running = runFixture({ status: "running", revision: 4 });
    vi.mocked(ipc.listAgentRuns).mockResolvedValue([running]);
    vi.mocked(ipc.getAgentRun).mockResolvedValue(running);
    localStorage.setItem("taomni.orchestration.selection.v1", JSON.stringify({ "/project": "run-1" }));
    const view = render(<StrictMode><AgentsPlatformView /></StrictMode>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("orch-conversation")).toHaveAttribute("data-run-id", "run-1");
    expect(screen.getByTestId("orch-run-status")).toHaveAttribute("data-status", "running");
    const initialCalls = vi.mocked(ipc.listAgentRuns).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
    expect(ipc.listAgentRuns).toHaveBeenCalledTimes(initialCalls + 1);
    vi.mocked(ipc.listAgentRuns).mockResolvedValue([runFixture({ status: "candidate", revision: 5 })]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
    expect(screen.getByTestId("orch-run-status")).toHaveAttribute("data-status", "candidate");
    const terminalCalls = vi.mocked(ipc.listAgentRuns).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(ipc.listAgentRuns).toHaveBeenCalledTimes(terminalCalls);
    view.unmount();
    expect(ipc.cancelAgentRun).not.toHaveBeenCalled();
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overlap slow polls and removes live timers on unmount without cancelling work", async () => {
    vi.useFakeTimers();
    vi.mocked(ipc.listAgentRuns).mockResolvedValue([runFixture({ status: "running" })]);
    const view = render(<AgentsPlatformView />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const response = deferred<ipc.AgentRun[]>();
    vi.mocked(ipc.listAgentRuns).mockReturnValue(response.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(ipc.listAgentRuns).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { response.resolve([runFixture({ status: "running", revision: 3 })]); await Promise.resolve(); });
    expect(vi.getTimerCount()).toBe(0);
    expect(ipc.cancelAgentRun).not.toHaveBeenCalled();
  });

  it("reconnects on focus without sending or starting another task", async () => {
    render(<AgentsPlatformView />); await ready();
    vi.mocked(ipc.listAgentRuns).mockResolvedValue([runFixture({ status: "partial" })]);
    fireEvent.focus(window);
    await screen.findByTestId("orch-run-run-1");
    expect(ipc.createAgentRun).not.toHaveBeenCalled();
    expect(ipc.startAgentRun).not.toHaveBeenCalled();
  });

  it("shows backend failures, allows retry, and never substitutes a simulated run", async () => {
    vi.mocked(ipc.getAgentSettings).mockRejectedValue(new Error("IPC unavailable"));
    render(<AgentsPlatformView />);
    expect(await screen.findByTestId("orch-error")).toHaveTextContent("IPC unavailable");
    expect(screen.getByTestId("orch-send")).toBeDisabled();
    expect(screen.queryByTestId("orch-conversation")).not.toBeInTheDocument();
    vi.mocked(ipc.getAgentSettings).mockResolvedValue(runFixture().settingsSnapshot);
    fireEvent.click(screen.getByTestId("orch-refresh")); await ready();
    expect(screen.queryByTestId("orch-error")).not.toBeInTheDocument();
  });

  it("uses active workspace roots and isolates selection and draft when switching projects", async () => {
    const second = useWorkspacePlatformStore.getState().createWorkspace({ name: "Other", rootPath: "/other" });
    useWorkspacePlatformStore.getState().setActiveWorkspace(DEFAULT_WORKSPACE_ID);
    render(<AgentsPlatformView />); await ready();
    fireEvent.change(screen.getByTestId("orch-prompt"), { target: { value: "Project one draft" } });
    act(() => useWorkspacePlatformStore.getState().setActiveWorkspace(second.id));
    await waitFor(() => expect(screen.getByTestId("orch-project-select")).toHaveValue("/other"));
    expect(screen.getByTestId("orch-prompt")).toHaveValue("");
    expect(useOrchestrationStore.getState().projectPath).toBe("/other");
  });

  it("updates the scoped translations with the application locale", async () => {
    render(<AgentsPlatformView />); await ready();
    act(() => setLocale("zh-CN"));
    expect(screen.getByTestId("orch-new-task")).toHaveTextContent("新任务");
    expect(screen.getByTestId("orch-empty-state")).toHaveTextContent("在 project 中开始开发");
    expect(screen.getByTestId("orch-send")).toHaveAccessibleName("创建任务");
  });
});
