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

  it("releases an active tab's resources once without cancelling the cleanup RPC", () => {
    mocks.invoke.mockResolvedValue(null);
    const api = createPluginFrontendApi("taoffice-excel", () => true);
    const close = api.deferCleanup!("workbook/close", { id: "session" });
    api.dispose();
    close();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "taoffice-excel", "workbook/close", { id: "session" }, { requestId: expect.any(String) },
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("leaves resource cleanup to the host when the module activation has ended", () => {
    let current = true;
    const api = createPluginFrontendApi("taoffice-excel", () => current);
    api.deferCleanup!("workbook/close", { id: "previous" });
    current = false;
    api.dispose();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("retains structured native RPC codes and readable recovery advice, then permits a fresh request", async () => {
    const rejection = { code: -32004, message: "MODULE_HOST_NOEXEC: choose an executable XDG_DATA_HOME", data: { retryable: true } };
    mocks.invoke.mockRejectedValueOnce(rejection).mockResolvedValueOnce({ values: ["preserved"] });
    const api = createPluginFrontendApi("hello-plugin", () => true);
    const result = api.invoke("hello/read");
    await expect(result).rejects.toMatchObject({ code: -32004, message: rejection.message, data: rejection.data, cause: rejection });
    await expect(result.catch((error) => error.cause)).resolves.toBe(rejection);
    await expect(result.catch(String)).resolves.toContain("MODULE_HOST_NOEXEC");
    await expect(api.invoke("hello/read")).resolves.toEqual({ values: ["preserved"] });
    api.dispose();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
