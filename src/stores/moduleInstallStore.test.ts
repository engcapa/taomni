import { describe, expect, it, vi } from "vitest";
import type { PluginRecord } from "../lib/pluginRegistry";
import { createModuleInstallStore } from "./moduleInstallStore";

const installed: PluginRecord = {
  slug: "hello-plugin", manifest: null, lifecycle: "installed",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const services = {
    install: vi.fn().mockResolvedValue(installed),
    list: vi.fn().mockResolvedValue([installed]),
    hydrate: vi.fn(),
  };
  const store = createModuleInstallStore(services);
  const fill = () => {
    store.getState().setArchivePath(" /modules/hello.taomni-plugin ");
    store.getState().setDetachedSignature(" detached signature\n ");
  };
  return { store, services, fill };
}

describe("module offline installation task", () => {
  it("requires both inputs before invoking native installation", async () => {
    const { store, services } = setup();
    expect(await store.getState().install()).toBeNull();
    expect(store.getState()).toMatchObject({ phase: "failed", validationError: true });
    store.getState().setArchivePath("/module.taomni-plugin");
    expect(await store.getState().install()).toBeNull();
    expect(services.install).not.toHaveBeenCalled();
    expect(services.hydrate).not.toHaveBeenCalled();
  });

  it("retains a single background task and frozen draft until native succeeds", async () => {
    const { store, services, fill } = setup();
    const native = deferred<PluginRecord>();
    services.install.mockReturnValue(native.promise);
    fill();
    const first = store.getState().install();
    const second = store.getState().install();
    expect(first).toBe(second);
    store.getState().setArchivePath("/different.taomni-plugin");
    store.getState().setDetachedSignature("different signature");
    expect(store.getState().archivePath).toContain("hello.taomni-plugin");
    expect(store.getState().detachedSignature).toContain("detached signature");
    expect(store.getState().phase).toBe("verifying");
    expect(services.hydrate).not.toHaveBeenCalled();
    native.resolve(installed);
    expect(await first).toEqual(installed);
    expect(services.install).toHaveBeenCalledExactlyOnceWith("/modules/hello.taomni-plugin", {
      detachedSignature: "detached signature",
    });
    expect(services.hydrate).toHaveBeenCalledExactlyOnceWith([installed]);
    expect(store.getState()).toMatchObject({ phase: "completed", installed, completionRevision: 1 });
  });

  it("preserves the registry when signature checking fails and permits retry", async () => {
    const { store, services, fill } = setup();
    services.install.mockRejectedValueOnce(new Error("signature mismatch"));
    fill();
    expect(await store.getState().install()).toBeNull();
    expect(store.getState()).toMatchObject({ phase: "failed", error: "signature mismatch", installed: null });
    expect(services.list).not.toHaveBeenCalled();
    expect(services.hydrate).not.toHaveBeenCalled();
    expect(store.getState().archivePath).toContain("hello.taomni-plugin");
    expect(await store.getState().install()).toEqual(installed);
    expect(store.getState()).toMatchObject({ phase: "completed", error: null });
  });

  it("reports actual installation success separately from registry refresh failure", async () => {
    const { store, services, fill } = setup();
    services.list.mockRejectedValueOnce(new Error("registry temporarily unavailable"));
    fill();
    expect(await store.getState().install()).toEqual(installed);
    expect(store.getState()).toMatchObject({
      phase: "completed", installed, error: null, refreshError: "registry temporarily unavailable",
    });
    expect(services.hydrate).not.toHaveBeenCalled();
  });

  it("cleans up a synchronous adapter failure so a later retry can run", async () => {
    const { store, services, fill } = setup();
    services.install.mockImplementationOnce(() => { throw new Error("adapter unavailable"); });
    fill();
    expect(await store.getState().install()).toBeNull();
    expect(await store.getState().install()).toEqual(installed);
    expect(services.install).toHaveBeenCalledTimes(2);
  });
});
