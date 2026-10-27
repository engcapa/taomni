import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailFolder } from "../../../lib/mail";
import type { MailTabInfo } from "../../../types";
import { MailSubscriptionSnapshots } from "./subscriptionSnapshots";
import { useMailSubscriptions } from "./useMailSubscriptions";

const { setSubscription } = vi.hoisted(() => ({ setSubscription: vi.fn() }));
vi.mock("../../../lib/mail", () => ({ mailSetFolderSubscription: setSubscription }));

const folder: MailFolder = { accountId: "account", name: "Archive", displayName: "Archive", flags: ["\\Subscribed"], total: 4, unread: 1, updatedAt: 0 };
const info = { sessionId: "account", sync: { subscribedOnly: false } } as MailTabInfo;

function context() {
  return { info, foldersRef: { current: [folder] }, setFolders: vi.fn(),
    folderSnapshots: new MailSubscriptionSnapshots(), setError: vi.fn() };
}

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("subscription request lifetime", () => {
  it("retains errors and allows retry without publishing an optimistic result", async () => {
    const input = context();
    setSubscription.mockRejectedValueOnce(new Error("server unavailable"));
    const { result } = renderHook(() => useMailSubscriptions(input));
    await act(() => result.current.toggleSubscription(folder, false));
    expect(input.setError).toHaveBeenLastCalledWith("Error: server unavailable");
    expect(input.setFolders).not.toHaveBeenCalled();
    expect(result.current.subscriptionBusy).toBeNull();
    setSubscription.mockResolvedValueOnce([{ ...folder, flags: [] }]);
    await act(() => result.current.toggleSubscription(folder, false));
    expect(input.setFolders).toHaveBeenCalledWith([{ ...folder, flags: [] }]);
    expect(setSubscription).toHaveBeenCalledTimes(2);
  });

  it("ignores a successful response from a closed or replaced account", async () => {
    for (const replacement of [false, true]) {
      let finish!: (folders: MailFolder[]) => void;
      setSubscription.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      const input = context();
      const view = renderHook((props) => useMailSubscriptions(props), { initialProps: input });
      let pending!: Promise<void>;
      act(() => { pending = view.result.current.toggleSubscription(folder, false); });
      if (replacement) view.rerender({ ...input, info: { ...info, sessionId: "replacement" } });
      else view.unmount();
      await act(async () => { finish([{ ...folder, flags: [] }]); await pending; });
      expect(input.setFolders).not.toHaveBeenCalled();
      expect(input.folderSnapshots.capture()).toBe(0);
      view.unmount();
    }
  });
});
