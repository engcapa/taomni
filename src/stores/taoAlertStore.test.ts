import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TAO_ALERT_HISTORY_LIMIT,
  taoAlertHistoryKey,
  useTaoAlertStore,
  type TaoAlertHistoryEntry,
} from "./taoAlertStore";
import type { TaoAlert } from "../lib/tao/taoAlerts";

function alert(overrides: Partial<TaoAlert>): TaoAlert {
  return {
    id: "chat:t1",
    source: "chat",
    kind: "ai_done",
    title: "Thread ready",
    threadId: "t1",
    fireAt: 100,
    ...overrides,
  };
}

function resetStore() {
  window.localStorage.clear();
  useTaoAlertStore.setState({
    aiDone: [],
    mailNew: [],
    history: [],
    historyLimit: DEFAULT_TAO_ALERT_HISTORY_LIMIT,
  });
}

describe("taoAlertStore history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T00:00:00Z"));
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStore();
  });

  it("records pending alerts as searchable history without clearing them on ack", () => {
    useTaoAlertStore.getState().pushAiDone("thread-1", "Build finished");

    const state = useTaoAlertStore.getState();
    expect(state.aiDone).toHaveLength(1);
    expect(state.history).toMatchObject([
      {
        id: "chat:thread-1",
        source: "chat",
        kind: "ai_done",
        title: "Build finished",
      },
    ]);

    useTaoAlertStore.getState().ack("chat:thread-1");

    expect(useTaoAlertStore.getState().aiDone).toHaveLength(0);
    expect(useTaoAlertStore.getState().history).toHaveLength(1);
  });

  it("keeps the latest 30 entries when the history limit is set to 30", () => {
    const alerts = Array.from({ length: 35 }, (_, index) =>
      alert({
        id: `chat:t${index}`,
        title: `Thread ${index}`,
        threadId: `t${index}`,
        fireAt: 100 + index,
      }),
    );

    useTaoAlertStore.getState().recordHistory(alerts);
    useTaoAlertStore.getState().setHistoryLimit(30);

    const history = useTaoAlertStore.getState().history;
    expect(history).toHaveLength(30);
    expect(history[0].title).toBe("Thread 34");
    expect(history.at(-1)?.title).toBe("Thread 5");
    expect(useTaoAlertStore.getState().historyLimit).toBe(30);
  });

  it("clears only history when the manual clear action runs", () => {
    useTaoAlertStore.setState({
      aiDone: [alert({ id: "chat:live", threadId: "live", title: "Live", fireAt: 1 })],
      history: [
        {
          ...alert({ id: "chat:old", threadId: "old", title: "Old", fireAt: 2 }),
          historyId: "chat:old:2",
          firstSeenAt: 10,
          lastSeenAt: 10,
        } satisfies TaoAlertHistoryEntry,
      ],
    });

    useTaoAlertStore.getState().clearHistory();

    expect(useTaoAlertStore.getState().aiDone).toHaveLength(1);
    expect(useTaoAlertStore.getState().history).toHaveLength(0);
  });

  it("uses alert id plus fire time as the history key", () => {
    expect(taoAlertHistoryKey(alert({ id: "mail:tab", fireAt: 42 }))).toBe("mail:tab:42");
  });
});
