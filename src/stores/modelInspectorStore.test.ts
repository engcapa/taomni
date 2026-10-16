import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAiStore } from "./aiStore";
import { useModelInspectorStore, type ModelCheckResult, type ProviderModels } from "./modelInspectorStore";
import { inspectorStub } from "../stubs/modelInspectorStub";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mock = vi.mocked(invoke);
beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear();
  useModelInspectorStore.setState({ entries: {} });
  mock.mockResolvedValue(null);
  await useAiStore.getState().loadConfig();
  // Simulate a real backend config load, including its normalization contract.
  mock.mockResolvedValue(useAiStore.getState().config);
  await useAiStore.getState().loadConfig();
});
it("loading only reads metadata and does not run checks", async () => {
  mock.mockResolvedValue(inspectorStub("deepseek", false));
  await useModelInspectorStore.getState().load("deepseek");
  expect(mock).toHaveBeenLastCalledWith("get_provider_models", { providerId: "deepseek", forceRefresh: false, providerDraft: useAiStore.getState().config?.llm.providers.deepseek });
  expect(mock.mock.calls.some(([command]) => command === "test_llm_model")).toBe(false);
});
it("late reads cannot overwrite a newer refresh or another provider", async () => {
  let resolve!: (data: ProviderModels) => void;
  mock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const old = useModelInspectorStore.getState().load("deepseek");
  mock.mockResolvedValueOnce({ ...inspectorStub("deepseek", false), source: "live" });
  await useModelInspectorStore.getState().load("deepseek", true);
  mock.mockResolvedValueOnce(inspectorStub("local", false));
  await useModelInspectorStore.getState().load("local");
  resolve(inspectorStub("deepseek", false)); await old;
  expect(useModelInspectorStore.getState().entries.deepseek.data?.source).toBe("live");
  expect(useModelInspectorStore.getState().entries.local.data?.rows[0].metadata_source).toBe("live");
});
it("refresh rejection preserves last-good rows and exposes the reason", async () => {
  mock.mockResolvedValueOnce(inspectorStub("deepseek", false));
  await useModelInspectorStore.getState().load("deepseek");
  mock.mockRejectedValueOnce(new Error("offline"));
  await useModelInspectorStore.getState().load("deepseek", true);
  expect(useModelInspectorStore.getState().entries.deepseek.data?.rows).toHaveLength(3);
  expect(useModelInspectorStore.getState().entries.deepseek.error).toContain("offline");
});
it("duplicate checks are blocked and failures remain results not invented success", async () => {
  mock.mockResolvedValueOnce(inspectorStub("deepseek", false));
  await useModelInspectorStore.getState().load("deepseek");
  let resolve!: (data: ModelCheckResult) => void;
  mock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const check = useModelInspectorStore.getState().check("deepseek", "unlisted-model");
  await useModelInspectorStore.getState().check("deepseek", "unlisted-model");
  expect(mock.mock.calls.filter(([c]) => c === "test_llm_model")).toHaveLength(1);
  resolve({ ok: false, error: "401\nOriginal", latency_ms: 5, checked_at: 20 }); await check;
  expect(useModelInspectorStore.getState().entries.deepseek.data?.rows.find((r) => r.id === "unlisted-model")?.check?.ok).toBe(false);
  expect(useModelInspectorStore.getState().entries.deepseek.pending).toEqual([]);
});
it("batch tests sequentially and rejects repeated batch starts", async () => {
  mock.mockResolvedValueOnce(inspectorStub("deepseek", false));
  await useModelInspectorStore.getState().load("deepseek");
  let running = 0; let maximum = 0;
  mock.mockImplementation(async () => {
    running++; maximum = Math.max(maximum, running);
    await Promise.resolve(); running--;
    return { ok: true, latency_ms: 2, checked_at: 10, error: null };
  });
  await Promise.all([useModelInspectorStore.getState().checkAll("deepseek"), useModelInspectorStore.getState().checkAll("deepseek")]);
  expect(maximum).toBe(1);
  expect(mock.mock.calls.filter(([c]) => c === "test_llm_model")).toHaveLength(3);
  expect(useModelInspectorStore.getState().entries.deepseek.batch).toBe(false);
});
it("policy prevents checks even when catalog still contains older enabled state", async () => {
  mock.mockResolvedValueOnce(inspectorStub("deepseek", false));
  await useModelInspectorStore.getState().load("deepseek");
  const config = useAiStore.getState().config!;
  useAiStore.setState({ config: { ...config, full_local_mode: true } });
  const count = mock.mock.calls.length;
  await useModelInspectorStore.getState().checkAll("deepseek");
  expect(mock.mock.calls).toHaveLength(count);
});
it("selection uses the real configuration save chain and preserves unrelated fields", async () => {
  mock.mockResolvedValue(undefined);
  const before = useAiStore.getState().config!;
  await useModelInspectorStore.getState().selectModel("deepseek", "catalog-model");
  const save = mock.mock.calls.find(([c]) => c === "save_ai_config")!;
  const saved = (save[1] as Record<string, unknown>)?.config as typeof before;
  expect(saved.llm.providers.deepseek).toMatchObject({ ...before.llm.providers.deepseek, model: "catalog-model" });
  expect(saved.llm.providers.anthropic).toEqual(before.llm.providers.anthropic);
  expect(useAiStore.getState().config?.llm.providers.deepseek.model).toBe("catalog-model");
});
it("failed selection does not change the current model", async () => {
  const before = useAiStore.getState().config!.llm.providers.deepseek.model;
  mock.mockRejectedValueOnce(new Error("save failed"));
  await expect(useModelInspectorStore.getState().selectModel("deepseek", "new")).rejects.toThrow();
  expect(useAiStore.getState().config!.llm.providers.deepseek.model).toBe(before);
});
it("a stale catalog read does not erase a completed check", async () => {
  mock.mockResolvedValueOnce(inspectorStub("deepseek", false));
  await useModelInspectorStore.getState().load("deepseek");
  let resolve!: (data: ProviderModels) => void;
  mock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const read = useModelInspectorStore.getState().load("deepseek", true);
  mock.mockResolvedValueOnce({ ok: true, checked_at: 100, latency_ms: 5, error: null });
  await useModelInspectorStore.getState().check("deepseek", "deepseek-chat");
  resolve(inspectorStub("deepseek", false)); await read;
  expect(useModelInspectorStore.getState().entries.deepseek.data?.rows[0].check?.checked_at).toBe(100);
});

it("checks the current draft without saving it, even after a disabled snapshot", async () => {
  mock.mockResolvedValueOnce({ ...inspectorStub("deepseek", false), checks_disabled: true });
  await useModelInspectorStore.getState().load("deepseek");
  const config = useAiStore.getState().config!;
  const draft = { ...config.llm.providers.deepseek, model: "unsaved", api_keys: [], api_key: "synthetic", base_url: "http://draft.invalid", proxy_mode: "none" };
  useAiStore.setState({ config: { ...config, llm: { ...config.llm, providers: { ...config.llm.providers, deepseek: draft } } } });
  mock.mockResolvedValueOnce({ ok: true, checked_at: 100, latency_ms: 5, error: null });
  await useModelInspectorStore.getState().check("deepseek", "unsaved");
  expect(mock).toHaveBeenLastCalledWith("test_llm_model", { providerId: "deepseek", model: "unsaved", providerDraft: draft });
  expect(mock.mock.calls.some(([c]) => c === "save_ai_config")).toBe(false);
});
