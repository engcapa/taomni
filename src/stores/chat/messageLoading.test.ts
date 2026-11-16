import "../tests/chatStore/harness";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, type ChatMessage } from "../chatStore";
import { invokeMock, makeThread } from "../tests/chatStore/harness";
import type { StreamEvent } from "./model";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const user: ChatMessage = {
  id: "user", thread_id: "thread-1", role: "user", content: "Reviewed handoff",
  created_at: 1, redacted: false, attachments: [],
};
const assistant: ChatMessage = {
  ...user, id: "assistant", role: "assistant", content: "Native agent result", created_at: 2,
};

describe("chat transcript loading during native handoff", () => {
  let onStream: EventCallback<StreamEvent>;

  beforeEach(() => {
    invokeMock.mockReset();
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      onStream = handler as EventCallback<StreamEvent>;
      return () => undefined;
    });
    useChatStore.setState({
      threads: [makeThread({ provider_id: "acp:qa-tao" })], messages: {},
      activeThreadId: "thread-1", sendingByThreadId: {}, sending: false,
      streamingId: {}, ccToolCards: {}, ccUsage: {}, sendQueues: {},
    });
  });

  function emit(payload: StreamEvent) {
    onStream({ event: "chat-stream:thread-1", id: 1, payload });
  }

  it("keeps a completed native reply when an earlier empty history read arrives late", async () => {
    const history = deferred<ChatMessage[]>();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "chat_list_messages") return history.promise;
      if (command === "chat_stream") {
        emit({ kind: "user_message", message: user });
        emit({ kind: "assistant_start", id: assistant.id, thread_id: user.thread_id, created_at: 2 });
        emit({ kind: "end", id: assistant.id, thread_id: user.thread_id, content: assistant.content, redacted_count: 0 });
        return;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const loading = useChatStore.getState().loadMessages("thread-1");
    await useChatStore.getState().sendMessage("thread-1", user.content);
    expect(useChatStore.getState().messages["thread-1"]).toEqual([user, assistant]);
    history.resolve([]);
    await loading;
    expect(useChatStore.getState().messages["thread-1"]).toEqual([user, assistant]);
  });

  it("applies the newest history request when reads finish in reverse order", async () => {
    const old = deferred<ChatMessage[]>();
    const current = deferred<ChatMessage[]>();
    invokeMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = useChatStore.getState().loadMessages("thread-1");
    const second = useChatStore.getState().loadMessages("thread-1");
    current.resolve([user, assistant]);
    await second;
    old.resolve([]);
    await first;
    expect(useChatStore.getState().messages["thread-1"]).toEqual([user, assistant]);
  });

  it("does not recreate a deleted transcript when a history request finishes late", async () => {
    const history = deferred<ChatMessage[]>();
    invokeMock.mockImplementation((command: string) => command === "chat_list_messages" ? history.promise : Promise.resolve());
    const loading = useChatStore.getState().loadMessages("thread-1");
    await useChatStore.getState().deleteThread("thread-1");
    history.resolve([user, assistant]);
    await loading;
    expect(useChatStore.getState().messages["thread-1"]).toBeUndefined();
    expect(useChatStore.getState().threads).toEqual([]);
  });

  it("initializes a newly created thread without needing an empty history query", async () => {
    const target = makeThread({ id: "new-handoff", provider_id: "acp:qa-tao" });
    invokeMock.mockResolvedValue(target);
    await useChatStore.getState().newThread("acp:qa-tao");
    expect(useChatStore.getState().activeThreadId).toBe(target.id);
    expect(useChatStore.getState().messages[target.id]).toEqual([]);
  });

  it("refreshes cached history from storage when no local messages change", async () => {
    useChatStore.setState({ messages: { "thread-1": [user] } });
    invokeMock.mockResolvedValue([user, assistant]);
    await useChatStore.getState().loadMessages("thread-1");
    expect(useChatStore.getState().messages["thread-1"]).toEqual([user, assistant]);
  });
});
