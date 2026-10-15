import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOpencodeGoStore, GO_CATALOG_TTL_MS } from "./opencodeGoStore";
import { GO_STUB_CATALOG } from "../stubs/opencodeGoStub";
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

beforeEach(() => {
  vi.clearAllMocks();
  useOpencodeGoStore.setState({ models: [], fetched_at: 0, loaded: false, loading: false, last_error: null, source: "snapshot" });
});
describe("Go catalog lifecycle", () => {
  it("loads local data then refreshes when expired; shares an in-flight request", async () => {
    invokeMock.mockResolvedValueOnce(GO_STUB_CATALOG).mockResolvedValueOnce({
      ...GO_STUB_CATALOG, fetched_at: Math.floor(Date.now() / 1000), source: "live",
    });
    await useOpencodeGoStore.getState().ensureLoaded();
    expect(invokeMock.mock.calls).toEqual([
      ["get_opencode_go_catalog", { forceRefresh: false }],
      ["get_opencode_go_catalog", { forceRefresh: true }],
    ]);
    expect(useOpencodeGoStore.getState().source).toBe("live");
    let resolve!: (value: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const a = useOpencodeGoStore.getState().refresh();
    const b = useOpencodeGoStore.getState().refresh();
    expect(a).toBe(b);
    resolve(GO_STUB_CATALOG);
    await a;
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });
  it("does not force network for blocked policy or a fresh directory", async () => {
    invokeMock.mockResolvedValue(GO_STUB_CATALOG);
    await useOpencodeGoStore.getState().ensureLoaded(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    invokeMock.mockResolvedValue({ ...GO_STUB_CATALOG, fetched_at: Math.floor((Date.now() - GO_CATALOG_TTL_MS / 2) / 1000) });
    await useOpencodeGoStore.getState().ensureLoaded();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
  it("retains last-good models and shows errors; retry recovers", async () => {
    useOpencodeGoStore.setState({ ...GO_STUB_CATALOG, loaded: true });
    invokeMock.mockRejectedValueOnce(new Error("IPC disconnected"));
    await useOpencodeGoStore.getState().refresh();
    expect(useOpencodeGoStore.getState().models).toEqual(GO_STUB_CATALOG.models);
    expect(useOpencodeGoStore.getState().last_error).toContain("IPC disconnected");
    expect(useOpencodeGoStore.getState().loading).toBe(false);
    invokeMock.mockResolvedValue({ ...GO_STUB_CATALOG, source: "live" });
    await useOpencodeGoStore.getState().refresh();
    expect(useOpencodeGoStore.getState().last_error).toBeNull();
  });
});
