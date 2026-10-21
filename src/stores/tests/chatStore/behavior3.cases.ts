import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_SENDS, useChatStore } from "../../chatStore";
import { attachment, invokeMock, makeThread } from "./harness";

export function registerchatStoreBehavior3Cases() {

  describe("chatStore send queue", () => {
    /**
     * A `sendMessage` stand-in the test controls the timing of: it flips the
     * thread's sending flag the way the real one does, then parks until the test
     * resolves it. That makes "a turn is in flight" a state the test can hold
     * open, which is the only condition under which queueing happens at all.
     */
    function controllableSendMessage(options: { throwOn?: string[]; } = {}) {
      const throwOn = new Set(options.throwOn ?? []);
      const calls: string[] = [];
      // One release per in-flight turn, so nested turns started by the queue
      // executor can each be settled in order.
      const releases: Array<() => void> = [];

      const sendMessage = vi.fn(async (threadId: string, content: string) => {
        calls.push(content);
        useChatStore.setState((s) => ({
          sendingByThreadId: { ...s.sendingByThreadId, [threadId]: true },
          sending: true,
        }));
        try {
          await new Promise<void>((resolve) => releases.push(resolve));
        } finally {
          // Mirrors the real sendMessage, which clears its thread's flag in a
          // finally block whether the turn succeeded or threw.
          useChatStore.setState((s) => {
            const next = { ...s.sendingByThreadId };
            delete next[threadId];
            return { sendingByThreadId: next, sending: Object.values(next).some(Boolean) };
          });
        }
        if (throwOn.has(content)) throw new Error(`provider exploded on ${content}`);
      });

      useChatStore.setState({ sendMessage });

      /** Settle the oldest in-flight turn and let the executor pick up the next. */
      const finishTurn = async () => {
        releases.shift()?.();
        // Several microtask hops: the release resolves the awaited promise, the
        // finally block runs, the next item is dequeued, and its sendMessage
        // reaches its own await.
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      };
      return { sendMessage, calls, finishTurn };
    }

    beforeEach(() => {
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(null);
      vi.mocked(listen).mockResolvedValue(() => undefined);
      useChatStore.setState({
        threads: [makeThread({ id: "t1" }), makeThread({ id: "t2" })],
        threadsLoaded: true,
        activeThreadId: "t1",
        messages: {},
        streamingId: {},
        ccToolCards: {},
        ccUsage: {},
        sendingByThreadId: {},
        sendQueues: {},
        sending: false,
        composerDrafts: {},
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("sends immediately when the thread is idle", async () => {
      const { calls } = controllableSendMessage();

      const result = await useChatStore.getState().enqueueMessage("t1", "first");

      expect(result).toEqual({ status: "sent" });
      expect(calls).toEqual(["first"]);
      expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
    });

    it("queues a send that arrives while a turn is in flight", async () => {
      const { calls } = controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "first");

      const result = await useChatStore.getState().enqueueMessage("t1", "second");

      expect(result).toEqual({ status: "queued", position: 1 });
      // Still only the first turn has reached sendMessage.
      expect(calls).toEqual(["first"]);
      expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["second"]);
    });

    it("drains the queue in FIFO order as each turn finishes", async () => {
      const { calls, finishTurn } = controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "first");
      await useChatStore.getState().enqueueMessage("t1", "second");
      await useChatStore.getState().enqueueMessage("t1", "third");

      expect(calls).toEqual(["first"]);

      await finishTurn();
      expect(calls).toEqual(["first", "second"]);
      expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["third"]);

      await finishTurn();
      expect(calls).toEqual(["first", "second", "third"]);
      expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
    });

    it("rejects the send that would exceed the limit, without storing it", async () => {
      const { calls } = controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "in-flight");
      for (let i = 1; i <= MAX_QUEUED_SENDS; i += 1) {
        const queued = await useChatStore.getState().enqueueMessage("t1", `queued-${i}`);
        expect(queued).toEqual({ status: "queued", position: i });
      }

      const rejected = await useChatStore.getState().enqueueMessage("t1", "one too many");

      expect(rejected).toEqual({ status: "rejected", limit: MAX_QUEUED_SENDS });
      expect(useChatStore.getState().sendQueues.t1).toHaveLength(MAX_QUEUED_SENDS);
      expect(
        useChatStore.getState().sendQueues.t1?.some((i) => i.content === "one too many"),
      ).toBe(false);
      expect(calls).toEqual(["in-flight"]);
    });

    it("keeps queues independent per thread", async () => {
      const { calls } = controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "t1-first");
      await useChatStore.getState().enqueueMessage("t1", "t1-queued");

      // A different thread is idle, so its send goes out rather than queueing
      // behind the unrelated conversation.
      const result = await useChatStore.getState().enqueueMessage("t2", "t2-first");

      expect(result).toEqual({ status: "sent" });
      expect(calls).toEqual(["t1-first", "t2-first"]);
      expect(useChatStore.getState().sendQueues.t2).toBeUndefined();
    });

    it("keeps draining after Stop — stopping skips one answer, not the queue", async () => {
      const { calls, finishTurn } = controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "first");
      await useChatStore.getState().enqueueMessage("t1", "second");

      await useChatStore.getState().stopSending("t1");

      // Stop must not discard what is parked behind the turn it cancelled.
      expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["second"]);

      // In production `chat_stop_stream` ends the backend stream, so the real
      // sendMessage returns and its executor advances. Settle the stopped turn to
      // stand in for that, and the queued send must actually go out.
      await finishTurn();
      expect(calls).toEqual(["first", "second"]);
      expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
    });

    it("drops one queued send by id", async () => {
      controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "first");
      await useChatStore.getState().enqueueMessage("t1", "keep");
      await useChatStore.getState().enqueueMessage("t1", "drop");

      const target = useChatStore.getState().sendQueues.t1?.find((i) => i.content === "drop");
      useChatStore.getState().dequeueSend("t1", target!.id);

      expect(useChatStore.getState().sendQueues.t1?.map((i) => i.content)).toEqual(["keep"]);
    });

    it("removes the queue key once it empties", async () => {
      controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "first");
      await useChatStore.getState().enqueueMessage("t1", "only");

      const target = useChatStore.getState().sendQueues.t1![0];
      useChatStore.getState().dequeueSend("t1", target.id);

      expect("t1" in useChatStore.getState().sendQueues).toBe(false);
    });

    it("clears a whole queue without touching the running turn", async () => {
      const { calls } = controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "first");
      await useChatStore.getState().enqueueMessage("t1", "a");
      await useChatStore.getState().enqueueMessage("t1", "b");

      useChatStore.getState().clearQueue("t1");

      expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
      expect(useChatStore.getState().sendingByThreadId.t1).toBe(true);
      expect(calls).toEqual(["first"]);
    });

    it("skips a blank or thread-less send", async () => {
      const { calls } = controllableSendMessage();

      expect(await useChatStore.getState().enqueueMessage("t1", "   \n ")).toEqual({ status: "skipped" });
      expect(await useChatStore.getState().enqueueMessage("", "hello")).toEqual({ status: "skipped" });
      expect(calls).toEqual([]);
    });

    it("trims content before sending", async () => {
      const { calls } = controllableSendMessage();

      await useChatStore.getState().enqueueMessage("t1", "  padded  ");

      expect(calls).toEqual(["padded"]);
    });

    it("carries terminal context and attachments through the queue", async () => {
      const { finishTurn } = controllableSendMessage();
      const attachments = [attachment("C:\\tmp\\a.txt")];
      await useChatStore.getState().enqueueMessage("t1", "first");
      await useChatStore.getState().enqueueMessage("t1", "second", "term-ctx", attachments);

      await finishTurn();

      expect(useChatStore.getState().sendMessage).toHaveBeenLastCalledWith(
        "t1",
        "second",
        "term-ctx",
        attachments,
      );
    });

    it("keeps draining when a turn throws", async () => {
      const { calls, finishTurn } = controllableSendMessage({ throwOn: ["boom"] });
      await useChatStore.getState().enqueueMessage("t1", "boom");
      await useChatStore.getState().enqueueMessage("t1", "after");

      await finishTurn();

      // A thrown turn must not strand the sends behind it — the executor advances
      // from its finally block, so a provider failure costs one answer, not the
      // rest of the queue.
      expect(calls).toEqual(["boom", "after"]);
      expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
    });

    it("drops queued sends when the thread is deleted", async () => {
      controllableSendMessage();
      await useChatStore.getState().enqueueMessage("t1", "first");
      await useChatStore.getState().enqueueMessage("t1", "queued");
      expect(useChatStore.getState().sendQueues.t1).toHaveLength(1);

      await useChatStore.getState().deleteThread("t1");

      expect(useChatStore.getState().sendQueues.t1).toBeUndefined();
    });
  });
}
