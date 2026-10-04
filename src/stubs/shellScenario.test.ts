import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellScenarioBefore, shellScenarioInvoke } from "./shellScenario";
import { listen } from "./tauri-event";
import { buildLocalZshCwdIntegration, buildSshCwdIntegration, CWD_INTEGRATION_DONE_MARKER } from "../lib/terminalShellIntegration";
import { createOscMarkerBlankingSuppressor } from "../lib/terminalOutputFilter";

const faultKey = "taomni.qa.shell.fault";
function hold(once = false) {
  localStorage.setItem(faultKey, JSON.stringify({ command: "workspace_list_dir", owner: "/repo", mode: "hold", once }));
}

describe("controlled Shell backend readiness", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("taomni.qa.shell.enabled", "true");
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

  it("stops only the selected held turn, saves its user text, and lets the next turn finish", async () => {
    localStorage.setItem(faultKey, JSON.stringify({ command: "chat_stream", mode: "hold" }));
    const events: { kind: string; message?: string }[] = [];
    const unlisten = await listen("chat-stream:stop-test", (event) => { events.push(event.payload as typeof events[number]); });
    try {
      const pending = shellScenarioInvoke("chat_stream", { req: { thread_id: "stop-test", content: "stop this" } });
      await vi.advanceTimersByTimeAsync(0);
      await shellScenarioInvoke("chat_stop_stream", { threadId: "another-thread" });
      await vi.advanceTimersByTimeAsync(25);
      expect(events.some((event) => event.kind === "error" || event.kind === "end")).toBe(false);
      await shellScenarioInvoke("chat_stop_stream", { threadId: "stop-test" });
      await vi.advanceTimersByTimeAsync(25);
      await pending;
      expect(events.filter((event) => event.kind === "error")).toEqual([expect.objectContaining({ message: "Stream stopped by user" })]);
      expect(events.some((event) => event.kind === "end")).toBe(false);
      const stored = () => JSON.parse(localStorage.getItem("taomni.stub.chatMessages.v1")!)["stop-test"] as { role: string; content: string }[];
      expect(stored().map(({ role, content }) => [role, content])).toEqual([["user", "stop this"]]);
      localStorage.removeItem(faultKey);
      await shellScenarioInvoke("chat_stream", { req: { thread_id: "stop-test", content: "next turn" } });
      expect(events.filter((event) => event.kind === "end")).toHaveLength(1);
      expect(stored().map(({ role, content }) => [role, content])).toEqual([["user", "stop this"], ["user", "next turn"], ["assistant", "QA fixture reply: next turn"]]);
    } finally {
      unlisten();
    }
  });

  it("holds only the first matching workspace so a second same-path instance can finish first", async () => {
    hold(true);
    let firstReady = false;
    const first = shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" }).then(() => { firstReady = true; });
    await shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" });
    await vi.advanceTimersByTimeAsync(100);
    expect(firstReady).toBe(false);
    const observations = JSON.parse(localStorage.getItem("taomni.qa.shell.observations")!);
    expect(observations.filter((row: { status: string }) => row.status === "held")).toHaveLength(1);
    localStorage.removeItem(faultKey);
    await vi.advanceTimersByTimeAsync(25);
    await first;
    expect(firstReady).toBe(true);
  });

  it("does not consume a one-shot hold for a different owner or command", async () => {
    hold(true);
    await shellScenarioBefore("workspace_list_dir", { repoRoot: "/other" });
    await shellScenarioBefore("notes_list", { repoRoot: "/repo" });
    expect(JSON.parse(localStorage.getItem(faultKey)!).claimed).toBeUndefined();
    const pending = shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo/child" });
    expect(JSON.parse(localStorage.getItem(faultKey)!).claimed).toBe(true);
    localStorage.removeItem(faultKey);
    await vi.advanceTimersByTimeAsync(25);
    await pending;
  });

  it("reports the preparation deadline instead of acknowledging an unreleased hold", async () => {
    hold(true);
    const outcome = shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await outcome).toMatchObject({ message: "QA fixture held workspace_list_dir beyond preparation deadline" });
  });

  it("rejects one matching request and leaves retry and disabled fixtures working", async () => {
    localStorage.setItem(faultKey, JSON.stringify({ command: "workspace_list_dir", mode: "fail-next" }));
    await expect(shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" })).rejects.toThrow("QA fixture rejected");
    await expect(shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" })).resolves.toBeUndefined();
    hold();
    localStorage.removeItem("taomni.qa.shell.enabled");
    await expect(shellScenarioBefore("workspace_list_dir", { repoRoot: "/repo" })).resolves.toBeUndefined();
  });

  it.each([buildSshCwdIntegration(), buildLocalZshCwdIntegration()])("completes the real cwd setup protocol and preserves subsequent command output (%#)", async (command) => {
    const chunks: Uint8Array[] = [];
    const onmessage = (data: number[]) => chunks.push(Uint8Array.from(data));
    await shellScenarioInvoke("create_ssh_terminal", { sessionId: "protocol-test", host: "qa.invalid", onOutput: { onmessage } });
    await vi.advanceTimersByTimeAsync(0);
    chunks.length = 0;
    const suppressor = createOscMarkerBlankingSuppressor(CWD_INTEGRATION_DONE_MARKER, 4000);
    await shellScenarioInvoke("write_terminal", { sessionId: "protocol-test", data: btoa(`${command}\r`) });
    const visible = chunks.map((chunk) => new TextDecoder().decode(suppressor.filter(chunk))).join("");
    expect(suppressor.done).toBe(true);
    expect(visible).toContain(`${CWD_INTEGRATION_DONE_MARKER}$ `);
    expect(visible).not.toContain("__taomni_osc7");
    chunks.length = 0;
    await shellScenarioInvoke("write_terminal", { sessionId: "protocol-test", data: btoa("echo SHELL_BROADCAST_1\r") });
    expect(chunks.map((chunk) => new TextDecoder().decode(suppressor.filter(chunk))).join("")).toContain("\r\nSHELL_BROADCAST_1\r\n");
    await shellScenarioInvoke("close_terminal", { sessionId: "protocol-test" });
  });

  it("reports the actual initial cwd from the injected setup without interpreting ordinary echo as setup", async () => {
    const chunks: string[] = [];
    await shellScenarioInvoke("create_ssh_terminal", { sessionId: "cwd-test", host: "qa.invalid", onOutput: { onmessage: (data: number[]) => chunks.push(new TextDecoder().decode(Uint8Array.from(data))) } });
    await vi.advanceTimersByTimeAsync(0);
    chunks.length = 0;
    await shellScenarioInvoke("write_terminal", { sessionId: "cwd-test", data: btoa(`${buildSshCwdIntegration("/preview/it's a dir")}\r`) });
    expect(chunks.join("")).toContain("\x1b]7;file://qa/preview/it's%20a%20dir\x1b\\");
    chunks.length = 0;
    await shellScenarioInvoke("write_terminal", { sessionId: "cwd-test", data: btoa("echo TaomniCwdIntegrationDone\r") });
    expect(chunks.join("")).toContain("\r\nTaomniCwdIntegrationDone\r\n");
    expect(chunks.join("")).not.toContain(CWD_INTEGRATION_DONE_MARKER);
    await shellScenarioInvoke("close_terminal", { sessionId: "cwd-test" });
  });
});
