import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReattachMessage } from "../../lib/detachedSession";
import type { Tab } from "../../types";
import { useDetachedWindowEvents } from "./useDetachedWindowEvents";

const mocks = vi.hoisted(() => ({ subscribe: vi.fn(), drain: vi.fn(), clear: vi.fn(), stop: vi.fn() }));
vi.mock("../../lib/detachedSession", () => ({ subscribeReattach: mocks.subscribe,
  drainPendingReattach: mocks.drain, clearReattachHandoff: mocks.clear }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subscribe.mockReturnValue(mocks.stop);
  mocks.drain.mockReturnValue([]);
});
afterEach(cleanup);

it("reattaches only sanitized matching module identities and deduplicates across transports", async () => {
  const tabsRef = { current: [] as Tab[] };
  const addTab = vi.fn((tab: Tab) => { tabsRef.current.push(tab); });
  const setActiveTab = vi.fn();
  const view = renderHook(() => useDetachedWindowEvents({ tabsRef, addTab, setActiveTab,
    setStatusMessage: vi.fn(), showAttachedSftp: vi.fn() }));
  const receive = mocks.subscribe.mock.calls[0][0] as (message: ReattachMessage) => void;
  const tab = { id: "plugin-original", type: "plugin", title: "Hello", closable: true,
    plugin: { slug: "hello-plugin", kind: "hello-plugin" } };
  const envelope = { type: "reattach" as const, from: "detached-webview", seq: 1, kind: "plugin" as const };
  await act(async () => receive({ ...envelope, id: "plugin-original", payload: { ...tab, password: "discard" } }));
  expect(addTab).toHaveBeenCalledExactlyOnceWith(tab);
  await act(async () => receive({ ...envelope, id: "plugin-original", payload: tab }));
  expect(addTab).toHaveBeenCalledTimes(1);
  expect(tabsRef.current).toEqual([tab]);
  await act(async () => receive({ ...envelope, id: "plugin-wrong", payload: tab }));
  expect(addTab).toHaveBeenCalledTimes(1);
  expect(setActiveTab).not.toHaveBeenCalled();
  expect(mocks.clear).toHaveBeenLastCalledWith("plugin", "plugin-wrong");
  view.unmount();
  expect(mocks.stop).toHaveBeenCalledTimes(1);
});
