import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ModelInspectorPanel } from "./ModelInspectorPanel";
import { LlmProvidersPanel } from "./LlmProvidersPanel";
import { useModelInspectorStore } from "../../stores/modelInspectorStore";
import { useAiStore } from "../../stores/aiStore";
import { inspectorStub, inspectorCheckStub } from "../../stubs/modelInspectorStub";
import { setLocale } from "../../lib/i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mock = vi.mocked(invoke);
beforeEach(async () => {
  localStorage.clear(); vi.clearAllMocks(); setLocale("en");
  useModelInspectorStore.setState({ entries: {} });
  mock.mockResolvedValue(null);
  await useAiStore.getState().loadConfig();
  mock.mockImplementation(async (command, args) => {
    const params = args as Record<string, unknown> | undefined;
    if (command === "get_provider_models") return inspectorStub(String(params?.providerId), !!params?.forceRefresh);
    if (command === "test_llm_model") return inspectorCheckStub(String(params?.providerId), String(params?.model));
    return null;
  });
});
afterEach(cleanup);
const open = (blocked = false, providerId = "deepseek", currentModel = "deepseek-chat") =>
  render(<ModelInspectorPanel providerId={providerId} currentModel={currentModel} blocked={blocked} onClose={vi.fn()} />);
it("renders current first, all metadata columns, unknowns and neutral live mismatch", async () => {
  open();
  const rows = await screen.findAllByTestId("model-inspector-row");
  expect(rows[0]).toHaveAttribute("data-model", "deepseek-chat");
  expect(rows[0]).toHaveAttribute("data-current", "true");
  expect(rows[0]).toHaveTextContent("Alias mapping");
  const unknown = rows.find((r) => r.dataset.model === "unlisted-model")!;
  expect(unknown).toHaveTextContent("Not in catalog");
  expect(unknown).toHaveTextContent("—");
  expect(screen.getByText("Not in live list")).toBeVisible();
  expect(screen.getByText("USD / 1M tokens (input / output / cache read)")).toBeVisible();
  expect(mock.mock.calls.some(([c]) => c === "test_llm_model")).toBe(false);
});
it("individual failure shows first line with full original error in title", async () => {
  open();
  const rows = await screen.findAllByTestId("model-inspector-row");
  const row = rows.find((r) => r.dataset.model === "unlisted-model")!;
  fireEvent.click(within(row).getByTestId("model-inspector-check"));
  await waitFor(() => expect(within(row).getByTestId("model-inspector-result")).toHaveTextContent("✗ Fixture 401 Unauthorized"));
  expect(within(row).getByTestId("model-inspector-result")).toHaveAttribute("title", "Fixture 401 Unauthorized\nFull gateway error");
});
it("batch requires explicit confirmation and cancel sends nothing", async () => {
  open(); await screen.findAllByTestId("model-inspector-row");
  fireEvent.click(screen.getByTestId("model-inspector-check-all"));
  expect(screen.getByTestId("model-inspector-confirm")).toHaveTextContent("quota");
  fireEvent.click(screen.getByTestId("model-inspector-cancel-all"));
  expect(mock.mock.calls.filter(([c]) => c === "test_llm_model")).toHaveLength(0);
  fireEvent.click(screen.getByTestId("model-inspector-check-all"));
  fireEvent.click(screen.getByTestId("model-inspector-confirm-all"));
  await waitFor(() => expect(mock.mock.calls.filter(([c]) => c === "test_llm_model")).toHaveLength(3));
});
it("policy disables all checks and refresh while remaining read-only", async () => {
  open(true); await screen.findAllByTestId("model-inspector-row");
  for (const id of ["model-inspector-check-current", "model-inspector-check-all", "model-inspector-refresh"]) {
    expect(screen.getByTestId(id)).toBeDisabled();
  }
  screen.getAllByTestId("model-inspector-check").forEach((button) => expect(button).toBeDisabled());
  screen.getAllByTestId("model-inspector-select").forEach((button) => expect(button).toBeDisabled());
  expect(screen.getByTestId("model-inspector-disabled")).toBeVisible();
});
it("local unavailable is not an empty catalog; failed refresh retains rows", async () => {
  mock.mockResolvedValueOnce({ ...inspectorStub("local", false), rows: [], unavailable: true, last_error: "connection refused" });
  const rendered = open(false, "local", "local");
  expect(await screen.findByTestId("model-inspector-unavailable")).toBeVisible();
  expect(screen.queryByTestId("model-inspector-empty")).toBeNull();
  rendered.unmount();
  open(); await screen.findAllByTestId("model-inspector-row");
  mock.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByTestId("model-inspector-refresh"));
  expect(await screen.findByTestId("model-inspector-error")).toHaveTextContent("offline");
  expect(screen.getAllByTestId("model-inspector-row")).toHaveLength(3);
});
it("selecting saves configuration and the real provider row moves the highlight", async () => {
  render(<LlmProvidersPanel />);
  // Locate a specific provider rather than relying on sort order.
  const deepseek = document.querySelector('[data-testid="llm-provider-row"][data-provider="deepseek"]')!;
  fireEvent.click(deepseek.firstElementChild!);
  fireEvent.click(within(deepseek as HTMLElement).getByTestId("model-inspector-open"));
  const rows = await screen.findAllByTestId("model-inspector-row");
  fireEvent.click(within(rows.find((r) => r.dataset.model === "catalog-model")!).getByTestId("model-inspector-select"));
  await waitFor(() => expect(within(deepseek as HTMLElement).getByTestId("llm-provider-model")).toHaveValue("catalog-model"));
  expect(screen.getAllByTestId("model-inspector-row")[0]).toHaveAttribute("data-model", "catalog-model");
  expect(mock.mock.calls.some(([c]) => c === "save_ai_config")).toBe(true);
});
it("every existing and Go provider has an entry; close returns focus; edits remain local until save", async () => {
  render(<LlmProvidersPanel />);
  for (const id of ["deepseek", "agnes", "glm", "groq", "siliconflow", "anthropic", "local", "opencode-go"]) {
    const row = document.querySelector(`[data-provider="${id}"][data-testid$="provider-row"]`)!;
    fireEvent.click(row.firstElementChild!);
    expect(within(row as HTMLElement).getByTestId("model-inspector-open")).toBeVisible();
  }
  const deepseek = document.querySelector('[data-testid="llm-provider-row"][data-provider="deepseek"]') as HTMLElement;
  const trigger = within(deepseek).getByTestId("model-inspector-open");
  fireEvent.click(trigger);
  await screen.findAllByTestId("model-inspector-row");
  fireEvent.keyDown(screen.getByTestId("model-inspector-panel"), { key: "Escape" });
  expect(trigger).toHaveFocus();
  fireEvent.change(within(deepseek).getByTestId("llm-provider-model"), { target: { value: "manual-model" } });
  expect(useAiStore.getState().config?.llm.providers.deepseek.model).toBe("manual-model");
  expect(mock.mock.calls.filter(([c]) => c === "save_ai_config")).toHaveLength(0);
});
it("shows loading before data, genuine empty and Chinese text", async () => {
  let resolve!: (data: unknown) => void;
  mock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  setLocale("zh-CN");
  open();
  expect(screen.getByTestId("model-inspector-loading")).toHaveTextContent("正在加载");
  resolve({ ...inspectorStub("deepseek", false), rows: [] });
  expect(await screen.findByTestId("model-inspector-empty")).toHaveTextContent("没有可用模型");
  expect(screen.queryByTestId("model-inspector-unavailable")).toBeNull();
});
it("save failure remains visible without moving selection and local uses live source", async () => {
  open(); await screen.findAllByTestId("model-inspector-row");
  mock.mockRejectedValueOnce(new Error("save denied"));
  const row = screen.getAllByTestId("model-inspector-row").find((r) => r.dataset.model === "catalog-model")!;
  fireEvent.click(within(row).getByTestId("model-inspector-select"));
  expect(await screen.findByTestId("model-inspector-error")).toHaveTextContent("save denied");
  expect(screen.getAllByTestId("model-inspector-row")[0]).toHaveAttribute("data-current", "true");
  cleanup();
  open(false, "local", "loaded-model");
  expect((await screen.findAllByTestId("model-inspector-row"))[0]).toHaveAttribute("data-source", "live");
});
it("current check updates immediately and opening again reads the persisted stub result", async () => {
  const rendered = open(); await screen.findAllByTestId("model-inspector-row");
  fireEvent.click(screen.getByTestId("model-inspector-check-current"));
  await waitFor(() => expect(screen.getAllByTestId("model-inspector-result")[0]).toHaveTextContent("✓ 12ms"));
  rendered.unmount();
  useModelInspectorStore.setState({ entries: {} });
  open();
  await waitFor(() => expect(screen.getAllByTestId("model-inspector-result")[0]).toHaveTextContent("✓ 12ms"));
  expect(mock.mock.calls.filter(([c]) => c === "test_llm_model")).toHaveLength(1);
});
it("future configured provider automatically receives an inspector entry", () => {
  const config = useAiStore.getState().config!;
  useAiStore.setState({ config: { ...config, llm: { ...config.llm, providers: {
    ...config.llm.providers, future: { ...config.llm.providers.deepseek, runtime: "future-protocol", model: "future-model" },
  } } } });
  render(<LlmProvidersPanel />);
  const row = document.querySelector('[data-testid="llm-provider-row"][data-provider="future"]')!;
  fireEvent.click(row.firstElementChild!);
  expect(within(row as HTMLElement).getByTestId("model-inspector-open")).toBeVisible();
});
