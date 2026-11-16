import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./tests/pluginFrontendHarness";
import { createPluginFrontendApi, installPluginFrontendHost } from "./pluginFrontendHost";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), cancel: vi.fn().mockResolvedValue(true) }));
vi.mock("./ipc/plugin", () => ({ invokePlugin: mocks.invoke, cancelPluginRequest: mocks.cancel }));

beforeEach(() => { mocks.invoke.mockReset(); mocks.cancel.mockClear(); });

describe("shared module host and activation-scoped requests", () => {
  it("publishes the renderer's existing React instance and freezes the SDK", () => {
    const host = installPluginFrontendHost();
    expect(host.React).toBe(React);
    expect(host.React.useState).toBe(React.useState);
    expect(installPluginFrontendHost()).toBe(host);
    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(globalThis, "__taomniHost")?.writable).toBe(false);
  });

  it("binds requests to the selected owner and rejects a result from a revoked activation", async () => {
    let current = true;
    const pending = deferred<unknown>();
    mocks.invoke.mockReturnValue(pending.promise);
    const api = createPluginFrontendApi("hello-plugin", () => current);
    const result = api.invoke("hello/read", { slug: "other" });
    expect(mocks.invoke).toHaveBeenCalledWith("hello-plugin", "hello/read", { slug: "other" }, { requestId: expect.any(String) });
    current = false;
    pending.resolve({ values: ["stale"] });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect(api.invoke("hello/read")).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("unmount cancels pending native work and settles the caller before a late reply", async () => {
    const pending = deferred<unknown>();
    mocks.invoke.mockReturnValue(pending.promise);
    const api = createPluginFrontendApi("hello-plugin", () => true);
    const result = api.invoke("hello/read");
    api.dispose();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.cancel).toHaveBeenCalledWith("hello-plugin", mocks.invoke.mock.calls[0][3].requestId);
    pending.resolve({ values: ["late"] });
    await expect(api.invoke("hello/read")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("supports caller cancellation without disposing other requests", async () => {
    const pending = deferred<unknown>();
    mocks.invoke.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ values: [] });
    const api = createPluginFrontendApi("hello-plugin", () => true);
    const controller = new AbortController();
    const result = api.invoke("hello/read", undefined, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect(api.invoke("hello/read")).resolves.toEqual({ values: [] });
    pending.resolve(null);
    api.dispose();
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });
});
