import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "./tauri-core";
import { listen } from "./tauri-event";

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

it("streams through renderer events, preserves attachments, and reloads two complete turns without resending", async () => {
  const thread = await invoke<{ id: string }>("chat_new_thread", { providerId: "qa-loopback" });
  const events: { kind: string; content?: string; message?: { content: string } }[] = [];
  const stop = await listen(`chat-stream:${thread.id}`, (event) => { events.push(event.payload as typeof events[number]); });
  try {
    const attachment = { id: "qa-context", kind: "text", path: "/qa/input", name: "input", size: 12, text: "retained context" };
    for (const content of ["第一条", "background turn"]) {
      const pending = invoke("chat_stream", { req: { thread_id: thread.id, content, attachments: [attachment] } });
      await vi.advanceTimersByTimeAsync(1000);
      await pending;
    }
    expect(events.filter((e) => e.kind === "user_message").map((e) => e.message?.content)).toEqual(["第一条", "background turn"]);
    expect(events.filter((e) => e.kind === "end")).toHaveLength(2);
    expect(events.filter((e) => e.kind === "token").map((e) => e.content).join("")).toBe("Browser preview stub: connect a desktop AI provider to get a real response.".repeat(2));
    const stored = await invoke<{ role: string; content: string; attachments?: unknown[] }[]>("chat_list_messages", { threadId: thread.id });
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(stored[0].attachments).toEqual([attachment]);
    const before = events.length;
    expect(await invoke("chat_list_messages", { threadId: thread.id })).toEqual(stored);
    expect(events).toHaveLength(before);
  } finally {
    stop();
  }
});
