import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellResumeComposer, type ShellRestoreOutcome } from "./useShellResumeComposer";
import type { EntryOutcome, UseWelcomeSessionResumeResult } from "./useWelcomeSessionResume";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { useAppStore } from "../stores/appStore";
import { defaultShellLayout } from "../lib/shell/shellLayoutPersistence";
import type { CodeWorkspaceTabInfo } from "../types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function session(overrides: Partial<UseWelcomeSessionResumeResult> = {}): UseWelcomeSessionResumeResult {
  return { view: { state: "empty" }, outcomes: [], refresh: vi.fn(), startRestore: vi.fn(async () => []),
    retryFailed: vi.fn(async () => []), cancelRestore: vi.fn(), clearRecord: vi.fn(async () => {}),
    isIdentitySuppressed: () => false, ...overrides };
}

function seed(count = 2) {
  const layout = defaultShellLayout();
  for (let i = 0; i < count; i++) {
    const identity = `workspace:${i}`;
    layout.restoreSources[identity] = { kind: "workspace", workspaceInstanceId: String(i),
      workspace: { repoRoot: "/same", name: `Workspace ${i}`, workspaceId: "same-path", roots: [], looseFiles: [] } };
    layout.restoredTabs[identity] = { pinned: false, order: i };
  }
  layout.lastActiveRestoreRef = "workspace:0";
  useShellLayoutStore.setState({ layout });
}

function ready(workspace: CodeWorkspaceTabInfo): ShellRestoreOutcome {
  return { identity: "ignored-opener-key", name: workspace.name ?? "", status: "ready", tabId: `tab-${workspace.workspaceInstanceId}` };
}

describe("Shell working-set restoration", () => {
  it("preserves unavailable snapshots while independent workspaces restore and refresh permits recovery", async () => {
    const saved = session({ view: { state: "unavailable", reason: "schema", message: "Unsupported snapshot" } });
    const { result, rerender } = renderHook(() => useShellResumeComposer(saved, async (workspace) => ready(workspace)));
    expect(result.current.state).toBe("unavailable");
    expect(result.current.error).toBe("Unsupported snapshot");
    await act(async () => { await result.current.start(); });
    expect(result.current.outcomes).toHaveLength(2);
    expect(result.current.state).toBe("partial");
    expect(saved.startRestore).not.toHaveBeenCalled();
    act(() => result.current.refresh());
    expect(saved.refresh).toHaveBeenCalledOnce();
    saved.view = { state: "empty" }; rerender();
    expect(result.current.error).toBeNull();
    expect(result.current.state).toBe("available");
  });
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ tabs: [{ id: "welcome", type: "welcome", title: "Home", closable: false }], activeTabId: "welcome" });
    seed();
  });
  afterEach(cleanup);

  it("restores independent workspaces while authentication is pending and binds out-of-order readiness by instance", async () => {
    const auth = deferred<EntryOutcome[]>(), first = deferred<ShellRestoreOutcome>();
    const saved = session({ startRestore: vi.fn(() => auth.promise) });
    const open = vi.fn(async (workspace: CodeWorkspaceTabInfo) => {
      useAppStore.getState().addTab({ id: `tab-${workspace.workspaceInstanceId}`, type: "code-workspace", title: workspace.name!, closable: true, codeWorkspace: workspace });
      return workspace.workspaceInstanceId === "0" ? first.promise : ready(workspace);
    });
    const { result } = renderHook(() => useShellResumeComposer(saved, open));
    let run!: Promise<void>;
    await act(async () => { run = result.current.start(); });
    expect(open).toHaveBeenCalledTimes(2);
    expect(result.current.outcomes).toEqual([expect.objectContaining({ identity: "workspace:1", tabId: "tab-1", status: "ready" })]);
    expect(useAppStore.getState().activeTabId).toBe("welcome");
    await act(async () => {
      first.resolve({ identity: "wrong", name: "Workspace 0", tabId: "tab-0", status: "ready" });
      auth.resolve([]);
      await run;
    });
    expect(result.current.state).toBe("succeeded");
    expect(result.current.outcomes.map((entry) => entry.identity)).toEqual(["workspace:0", "workspace:1"]);
    expect(useAppStore.getState().activeTabId).toBe("tab-0");
    expect(useAppStore.getState().tabs.filter((tab) => tab.type === "code-workspace").map((tab) => tab.codeWorkspace?.workspaceInstanceId)).toEqual(["0", "1"]);
  });

  it("retries only failed entries while keeping a successful same-path instance", async () => {
    let failed = true;
    const open = vi.fn(async (workspace: CodeWorkspaceTabInfo) => {
      if (workspace.workspaceInstanceId === "0" && failed) throw new Error("permission denied");
      return ready(workspace);
    });
    const { result } = renderHook(() => useShellResumeComposer(session(), open));
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("partial");
    expect(result.current.outcomes[0].error).toContain("permission denied");
    failed = false;
    await act(async () => { await result.current.retry(); });
    expect(open.mock.calls.map(([workspace]) => workspace.workspaceInstanceId)).toEqual(["0", "1", "0"]);
    expect(result.current.state).toBe("succeeded");
    expect(result.current.outcomes).toHaveLength(2);
  });

  it("cancel wakes an owned authentication wait and preserves successful independent outcomes", async () => {
    const auth = deferred<EntryOutcome[]>();
    const saved = session({ startRestore: () => auth.promise, cancelRestore: vi.fn(() => auth.resolve([])) });
    const open = vi.fn((workspace: CodeWorkspaceTabInfo, signal: AbortSignal) => workspace.workspaceInstanceId === "0"
      ? new Promise<ShellRestoreOutcome>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))
      : Promise.resolve(ready(workspace)));
    const { result } = renderHook(() => useShellResumeComposer(saved, open));
    let run!: Promise<void>;
    await act(async () => { run = result.current.start(); });
    await act(async () => { result.current.cancel(); await run; });
    expect(saved.cancelRestore).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("partial");
    expect(result.current.outcomes.map((entry) => entry.status)).toEqual(["cancelled", "ready"]);
    expect(useAppStore.getState().activeTabId).toBe("welcome");
  });

  it("bounds independent opens to four and continues after a completed entry", async () => {
    seed(5);
    const waiting = Array.from({ length: 5 }, () => deferred<ShellRestoreOutcome>());
    const open = vi.fn((workspace: CodeWorkspaceTabInfo) => waiting[Number(workspace.workspaceInstanceId)].promise);
    const { result } = renderHook(() => useShellResumeComposer(session(), open));
    let run!: Promise<void>;
    await act(async () => { run = result.current.start(); });
    expect(open).toHaveBeenCalledTimes(4);
    await act(async () => { waiting[2].resolve({ identity: "2", name: "2", tabId: "tab-2", status: "ready" }); });
    expect(open).toHaveBeenCalledTimes(5);
    await act(async () => {
      waiting.forEach((entry, i) => entry.resolve({ identity: String(i), name: String(i), tabId: `tab-${i}`, status: "ready" }));
      await run;
    });
    expect(result.current.outcomes.map((entry) => entry.identity)).toEqual(["workspace:0", "workspace:1", "workspace:2", "workspace:3", "workspace:4"]);
  });

  it("keeps available workspaces when session storage fails", async () => {
    const { result } = renderHook(() => useShellResumeComposer(session({ startRestore: vi.fn(async () => { throw new Error("snapshot read failed"); }) }), vi.fn(async (workspace) => ready(workspace))));
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe("partial");
    expect(result.current.error).toContain("snapshot read failed");
    expect(result.current.outcomes.map((entry) => entry.status)).toEqual(["ready", "ready"]);
  });
});
