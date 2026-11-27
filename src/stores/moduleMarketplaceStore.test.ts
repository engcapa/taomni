import { describe, expect, it, vi } from "vitest";
import { createModuleMarketplaceStore } from "./moduleMarketplaceStore";
import type { ModuleInstallReview, ModuleMarketplaceCatalog } from "../lib/ipc/plugin";

const selection = { pluginId: "taomni-plugin-hello-plugin", version: "0.1.0", sha256: "a".repeat(64) };
const catalog = (sequence: number, version?: string): ModuleMarketplaceCatalog => ({ platform: "linux-x86_64", catalog: {
  coreApiVersion: "1", sequence, updatedAt: "2026-11-16", plugins: version ? {
    [selection.pluginId]: {
      id: selection.pluginId, slug: "hello-plugin", name: "Hello Plugin", version, coreApiVersion: "1",
      platforms: { "linux-x86_64": { url: "https://modules.test/hello", sha256: selection.sha256, signature: "signed", size: 1024 } },
    },
  } : {},
} });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function harness() {
  const adapter = { catalog: vi.fn().mockResolvedValue(catalog(1)), download: vi.fn().mockResolvedValue({}),
    review: vi.fn(), install: vi.fn().mockResolvedValue({ slug: "hello-plugin" }),
    provision: vi.fn().mockResolvedValue(undefined), dismiss: vi.fn().mockResolvedValue(undefined) };
  const storage = { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() };
  return { adapter, storage, store: createModuleMarketplaceStore(adapter, storage) };
}

it("keeps a staged module pending and waits for the next launch instead of downloading it again", async () => {
  const { adapter, store } = harness();
  const pending = {
    legacyWaiting: false,
    legacyPending: [selection.pluginId],
    updates: [],
    newModules: [],
  };
  adapter.catalog
    .mockResolvedValueOnce({ ...catalog(1, selection.version), release: pending })
    .mockResolvedValue({ ...catalog(1, selection.version), release: {
      ...pending, legacyRestartRequired: [selection.pluginId],
    } });
  adapter.provision.mockResolvedValue("restart-required");

  await store.getState().refresh();
  await vi.waitFor(() => {
    const plan = store.getState().catalog?.release;
    expect(plan?.legacyRestartRequired).toEqual([selection.pluginId]);
    expect(plan?.legacyPending).toEqual([selection.pluginId]);
  });
  await store.getState().refresh();
  expect(adapter.provision).toHaveBeenCalledTimes(1);
  await store.getState().provision(selection.pluginId, true);
  expect(adapter.provision).toHaveBeenLastCalledWith(selection, true);
});

it("retries an unsuccessful import only after the user resumes the installation", async () => {
  const { adapter, store } = harness();
  adapter.catalog.mockResolvedValue({ ...catalog(1, selection.version), release: {
    legacyWaiting: false,
    legacyPending: [selection.pluginId],
    legacyImportFailed: [selection.pluginId],
    legacyImportErrors: { [selection.pluginId]: "Timed out copying objects" },
    updates: [],
    newModules: [],
  } });
  adapter.provision.mockResolvedValue("restart-required");

  await store.getState().refresh();
  expect(adapter.provision).not.toHaveBeenCalled();
  await store.getState().provision(selection.pluginId, true);
  expect(store.getState().catalog?.release?.legacyRestartRequired).toEqual([selection.pluginId]);
  expect(store.getState().catalog?.release?.legacyImportFailed).toEqual([]);
  expect(store.getState().catalog?.release?.legacyImportErrors).toEqual({});
});
describe("module marketplace ownership", () => {
  it("deduplicates catalog refresh and rejects late results from an old mirror", async () => {
    const { adapter, storage, store } = harness();
    const first = deferred<ModuleMarketplaceCatalog>();
    const second = deferred<ModuleMarketplaceCatalog>();
    adapter.catalog.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = store.getState().refresh("https://first.test/modules.json");
    expect(store.getState().refresh("https://first.test/modules.json")).toBe(a);
    const b = store.getState().refresh("https://second.test/modules.json");
    second.resolve(catalog(2));
    await b;
    first.resolve(catalog(1));
    await a;
    expect(store.getState()).toMatchObject({ source: "https://second.test/modules.json", catalog: catalog(2), loading: false });
    expect(adapter.catalog).toHaveBeenCalledTimes(2);
    expect(storage.setItem.mock.lastCall?.[1]).toBe("https://second.test/modules.json");
  });

  it("keeps a verified catalog visible after a failed check without starting transfers", async () => {
    const { adapter, store } = harness();
    await store.getState().refresh();
    adapter.catalog.mockRejectedValueOnce(new Error("Invalid official signature"));
    await store.getState().refresh("https://failed-mirror.test/modules.json");
    expect(store.getState()).toMatchObject({ catalog: catalog(1), error: "Invalid official signature", loading: false });
    expect(store.getState().catalogSource).not.toBe("https://failed-mirror.test/modules.json");
    expect(adapter.download).not.toHaveBeenCalled();
    expect(adapter.install).not.toHaveBeenCalled();
  });

  it("does not pass credential, fragment or non-network source URLs to native", async () => {
    const { adapter, store } = harness();
    for (const source of ["file:///tmp/catalog", "https://user:secret@mirror.test/modules.json", "https://mirror.test/catalog#fragment", "malformed"]) {
      await store.getState().refresh(source);
      expect(store.getState().error).toBeTruthy();
    }
    expect(adapter.catalog).not.toHaveBeenCalled();
  });

  it("deduplicates downloads until native completion and keeps rejected commands actionable", async () => {
    const { adapter, store } = harness();
    const native = deferred<never>();
    adapter.download.mockReturnValueOnce(native.promise);
    const first = store.getState().download(selection);
    expect(store.getState().download(selection)).toBe(first);
    await Promise.resolve();
    expect(adapter.download).toHaveBeenCalledOnce();
    expect(store.getState().busy[selection.pluginId]).toBe("download");
    native.reject(new Error("Proxy connection refused"));
    await first;
    expect(store.getState().busy[selection.pluginId]).toBeUndefined();
    expect(store.getState().errors[selection.pluginId]).toBe("Proxy connection refused");
    expect(adapter.install).not.toHaveBeenCalled();
  });

  it("requires the verified review before install and retains install failure without fake success", async () => {
    const { adapter, store } = harness();
    await store.getState().install();
    expect(adapter.install).not.toHaveBeenCalled();
    const review = { dataDirectory: "/native/plugins/hello-plugin/data", downloadId: "native-id", manifest: { name: "Actual signed module" } } as ModuleInstallReview;
    adapter.review.mockResolvedValue(review);
    await store.getState().openReview(selection);
    expect(store.getState().review?.detail).toBe(review);
    adapter.install.mockRejectedValueOnce(new Error("Package changed after confirmation"));
    await store.getState().install();
    expect(adapter.install).toHaveBeenCalledWith(selection, undefined);
    expect(store.getState().errors[selection.pluginId]).toBe("Package changed after confirmation");
    expect(store.getState().review).not.toBeNull();
    await store.getState().install();
    expect(store.getState().review).toBeNull();
  });

  it("does not open a late review after the user changes the catalog source", async () => {
    const { adapter, store } = harness();
    const response = deferred<ModuleInstallReview>();
    adapter.review.mockReturnValueOnce(response.promise);
    const pending = store.getState().openReview(selection);
    await store.getState().refresh("https://new.test/modules.json");
    response.resolve({} as ModuleInstallReview);
    await pending;
    expect(store.getState().review).toBeNull();
  });

  it("preserves a verified review when the background check still offers the same package", async () => {
    const { adapter, store } = harness();
    adapter.catalog.mockResolvedValueOnce(catalog(1, selection.version));
    await store.getState().refresh();
    const response = deferred<ModuleInstallReview>();
    adapter.review.mockReturnValueOnce(response.promise);
    const pending = store.getState().openReview(selection);
    await Promise.resolve();
    expect(adapter.review).toHaveBeenCalledWith(selection);

    adapter.catalog.mockResolvedValueOnce(catalog(2, selection.version));
    await store.getState().refresh();
    const detail = {} as ModuleInstallReview;
    response.resolve(detail);
    await pending;
    expect(store.getState().review).toMatchObject({ selection, detail });

    adapter.catalog.mockResolvedValueOnce(catalog(3, selection.version));
    await store.getState().refresh();
    expect(store.getState().review?.detail).toBe(detail);
  });

  it("closes the review when the refreshed catalog replaces the selected package", async () => {
    const { adapter, store } = harness();
    adapter.catalog.mockResolvedValueOnce(catalog(1, selection.version));
    await store.getState().refresh();
    adapter.review.mockResolvedValueOnce({} as ModuleInstallReview);
    await store.getState().openReview(selection);
    expect(store.getState().review?.selection).toEqual(selection);

    adapter.catalog.mockResolvedValueOnce(catalog(2, "0.2.0"));
    await store.getState().refresh();
    expect(store.getState().review).toBeNull();
    await store.getState().install();
    expect(adapter.install).not.toHaveBeenCalled();
  });
});
