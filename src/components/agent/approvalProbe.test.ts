import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listen, type Event } from "@tauri-apps/api/event";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  APPROVAL_PROBE_FOREIGN_LABEL,
  APPROVAL_PROBE_LAST_KEY,
  APPROVAL_PROBE_MODE_KEY,
  APPROVAL_PROBE_RESULT_KEY,
  APPROVAL_PROBE_THREAD_KEY,
  installApprovalProbe,
  runApprovalProbe,
  uninstallApprovalProbe,
} from "./approvalProbe";

vi.mock("@tauri-apps/api/event", () => import("../../stubs/tauri-event"));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ delivery: "target:detached-1", decision: "allow" })),
}));

type TauriGlobal = { __TAURI_INTERNALS__?: unknown };

function setWindowLabel(label: string | null): void {
  const target = window as unknown as TauriGlobal;
  if (label === null) delete target.__TAURI_INTERNALS__;
  else target.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
}

function seed(mode: string, threadId = "thread-869"): void {
  localStorage.setItem(APPROVAL_PROBE_MODE_KEY, mode);
  localStorage.setItem(APPROVAL_PROBE_THREAD_KEY, threadId);
}

/** The QA `seed_storage` verb stores valid JSON, so cases seed quoted strings. */
function seedJson(mode: string, threadId = "thread-869"): void {
  localStorage.setItem(APPROVAL_PROBE_MODE_KEY, JSON.stringify(mode));
  localStorage.setItem(APPROVAL_PROBE_THREAD_KEY, JSON.stringify(threadId));
}

function lastProbeResult(): Record<string, unknown> | null {
  const raw = localStorage.getItem(APPROVAL_PROBE_RESULT_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

function lastPrompt(): { payload: Record<string, unknown> } | null {
  const raw = localStorage.getItem(APPROVAL_PROBE_LAST_KEY);
  return raw ? (JSON.parse(raw) as { payload: Record<string, unknown> }) : null;
}

const unlisteners: Array<() => void> = [];
const events: Array<Event<unknown>> = [];

function capture(eventName: string): void {
  void listen<unknown>(eventName, (event) => {
    events.push(event);
  }).then((unlisten) => unlisteners.push(unlisten));
}

function captured(eventName: string): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.event === eventName)
    .map((event) => event.payload as Record<string, unknown>);
}

beforeEach(() => {
  localStorage.clear();
  events.length = 0;
  setWindowLabel("main");
  capture("agent-cc-permission");
  capture("agent-cc-permission-resolved");
  capture("agent-acp-permission");
  capture("agent-acp-permission-dismissed");
});

afterEach(() => {
  uninstallApprovalProbe();
  while (unlisteners.length) unlisteners.pop()?.();
  localStorage.clear();
  setWindowLabel(null);
  vi.clearAllMocks();
});

describe("approval probe (browser preview)", () => {
  it("accepts JSON-quoted case seeds written by the QA seed_storage verb", async () => {
    seedJson("own", "qa-869-thread");
    await runApprovalProbe();

    const prompts = captured("agent-cc-permission");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ threadId: "qa-869-thread", windowLabel: "main" });
    expect(lastProbeResult()).toMatchObject({ mode: "own", result: "emitted" });
  });

  it("emits an own-window prompt addressed to the current window", async () => {
    seed("own");
    await runApprovalProbe();

    const prompts = captured("agent-cc-permission");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      threadId: "thread-869",
      tool: "Bash",
      trust: "manual",
      windowLabel: "main",
    });
    expect(prompts[0].callId).toMatch(/^qa-cc-/);
    expect(lastProbeResult()).toMatchObject({ mode: "own", result: "emitted" });
  });

  it("emits an unlabelled broadcast prompt for the fallback scenario", async () => {
    seed("fallback");
    await runApprovalProbe();

    const prompts = captured("agent-cc-permission");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toHaveProperty("windowLabel");
    expect(prompts[0].threadId).toBe("thread-869");
  });

  it("emits a prompt addressed to another window for the negative case", async () => {
    seed("foreign");
    await runApprovalProbe();

    const prompts = captured("agent-cc-permission");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].windowLabel).toBe(APPROVAL_PROBE_FOREIGN_LABEL);
  });

  it("re-emits the exact previous prompt for the duplicate-emit case", async () => {
    seed("own");
    await runApprovalProbe();
    seed("duplicate");
    await runApprovalProbe();

    const prompts = captured("agent-cc-permission");
    expect(prompts).toHaveLength(2);
    expect(prompts[1].callId).toBe(prompts[0].callId);
  });

  it("resolves the previous prompt by call id", async () => {
    seed("own");
    await runApprovalProbe();
    const callId = lastPrompt()?.payload.callId;
    seed("resolved");
    await runApprovalProbe();

    const resolved = captured("agent-cc-permission-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ callId, threadId: "thread-869" });
  });

  it("emits an ACP card with the standard option kinds and this window's label", async () => {
    seed("acp");
    await runApprovalProbe();

    const prompts = captured("agent-acp-permission");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].windowLabel).toBe("main");
    expect(prompts[0].options).toEqual([
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "reject-always", kind: "reject_always" },
    ]);
  });

  it("emits the ACP dismissed broadcast", async () => {
    seed("acp");
    await runApprovalProbe();
    seed("acp-dismiss");
    await runApprovalProbe();

    const dismissed = captured("agent-acp-permission-dismissed");
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toMatchObject({ threadId: "thread-869", callId: null });
  });

  it("reports an unsupported mode instead of emitting a half prompt", async () => {
    seed("not-a-mode");
    await runApprovalProbe();

    expect(captured("agent-cc-permission")).toHaveLength(0);
    expect(lastProbeResult()).toMatchObject({ mode: "not-a-mode" });
    expect(String(lastProbeResult()?.error)).toContain("unsupported browser mode");
  });

  it("invokes the QA-gated backend command in a desktop webview", async () => {
    const internals = window as unknown as TauriGlobal;
    internals.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "terminal-abc" } },
      invoke: () => undefined,
    };
    seed("own");
    await runApprovalProbe();

    expect(tauriInvoke).toHaveBeenCalledWith("qa_agent_approval_probe", {
      threadId: "thread-869",
      mode: "own",
    });
    // The card comes from the backend here, so the probe must not emit one.
    expect(captured("agent-cc-permission")).toHaveLength(0);
    expect(lastProbeResult()).toMatchObject({
      mode: "own",
      delivery: "target:detached-1",
      decision: "allow",
    });
  });
});

describe("approval probe chord", () => {
  it("starts a probe on Ctrl+Alt+Shift+F9 and ignores other chords", async () => {
    seed("own");
    const uninstall = installApprovalProbe();
    try {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "F9",
          key: "F9",
          ctrlKey: true,
          altKey: true,
          shiftKey: false,
        }),
      );
      await Promise.resolve();
      expect(captured("agent-cc-permission")).toHaveLength(0);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "F9",
          key: "F9",
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(captured("agent-cc-permission")).toHaveLength(1);
      });
    } finally {
      uninstall();
    }
  });

  it("ignores a second chord while a probe is still in flight", async () => {
    seed("own");
    setWindowLabel("terminal-abc");
    (window as unknown as TauriGlobal).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "terminal-abc" } },
      invoke: () => undefined,
    };
    // The desktop invoke resolves immediately in this mock; hold it so the first
    // probe stays in flight while the second chord is delivered.
    const { invoke } = await import("@tauri-apps/api/core");
    const gate: { release?: () => void } = {};
    vi.mocked(invoke).mockImplementationOnce(
      () => new Promise((resolve) => {
        gate.release = () => resolve({ delivery: "target:terminal-abc", decision: "allow" });
      }),
    );

    const first = runApprovalProbe();
    const second = runApprovalProbe();
    gate.release?.();
    await Promise.all([first, second]);

    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("does not double-install the chord", async () => {
    seed("own");
    const first = installApprovalProbe();
    const second = installApprovalProbe();
    try {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "F9",
          key: "F9",
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          cancelable: true,
        }),
      );
      await vi.waitFor(() => {
        expect(captured("agent-cc-permission")).toHaveLength(1);
      });
    } finally {
      second();
      first();
    }
  });
});
