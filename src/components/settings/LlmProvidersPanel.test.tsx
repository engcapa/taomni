import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAiStore } from "../../stores/aiStore";
import { useVaultStore } from "../../stores/vaultStore";
import { DEFAULT_CONFIG } from "../../stores/ai/defaults";
import { LlmProvidersPanel } from "./LlmProvidersPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/runtime", async (original) => ({ ...await original<object>(), isTauriRuntime: () => false }));
afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  const config = structuredClone(DEFAULT_CONFIG);
  for (const provider of Object.values(config.llm.providers)) { provider.api_key = ""; provider.api_keys = []; }
  config.llm.providers = { ordinary: { ...config.llm.providers.deepseek, api_key: "vault:ordinary", model: "configured-model" } };
  useAiStore.setState({ config, loading: false, saving: false, testResults: {} });
  useVaultStore.setState({ state: "unlocked" });
  vi.mocked(invoke).mockResolvedValue(null);
});

it("validates custom model limits and saves model-specific settings with the Vault reference", async () => {
  render(<LlmProvidersPanel />);
  fireEvent.click(screen.getByTestId("llm-add-custom-provider"));
  fireEvent.change(screen.getByTestId("llm-custom-protocol"), { target: { value: "openai-responses" } });
  const custom = screen.getByTestId("llm-custom-fields").closest<HTMLElement>("[data-custom]")!;
  fireEvent.change(within(custom).getByTestId("llm-provider-base-url"), { target: { value: "https://gateway.example/v1/responses" } });
  fireEvent.change(within(custom).getByTestId("llm-provider-key"), { target: { value: "vault:custom-key" } });
  fireEvent.change(screen.getByTestId("llm-custom-model-id"), { target: { value: "qa-vision" } });
  fireEvent.change(screen.getByTestId("llm-custom-context"), { target: { value: "2000" } });
  fireEvent.click(screen.getByTestId("llm-providers-save"));
  expect(screen.getByRole("alert")).toBeVisible();
  expect(invoke).not.toHaveBeenCalled();

  fireEvent.change(screen.getByTestId("llm-custom-max-output"), { target: { value: "400" } });
  fireEvent.click(screen.getByTestId("llm-custom-multimodal"));
  fireEvent.click(screen.getByTestId("llm-custom-native-search"));
  fireEvent.click(screen.getByTestId("llm-custom-effort-xhigh"));
  fireEvent.click(screen.getByTestId("llm-providers-save"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_ai_config", expect.objectContaining({
    config: expect.objectContaining({ llm: expect.objectContaining({ providers: expect.objectContaining({
      [custom.dataset.provider!]: expect.objectContaining({
        base_url: "https://gateway.example/v1", runtime: "openai-responses", api_key: "vault:custom-key", model: "qa-vision",
        custom: expect.objectContaining({ models: [{ id: "qa-vision", context_window: 2000, max_output_tokens: 400, multimodal: true, reasoning_efforts: ["xhigh"], native_search: true }] }),
      }),
    }) }) }),
  })));
});

it("uses one live draft and save for LLM keys/models/proxy plus all Tao defaults", async () => {
  const { container } = render(<LlmProvidersPanel />);
  expect(screen.queryByTestId("tao-settings-key")).not.toBeInTheDocument();
  expect(screen.queryByTestId("tao-settings-save")).not.toBeInTheDocument();
  expect(screen.getByTestId("tao-settings-cost")).toHaveValue(0);
  fireEvent.change(screen.getByTestId("tao-settings-provider"), { target: { value: "ordinary" } });
  fireEvent.change(screen.getByTestId("tao-settings-tts"), { target: { value: "tide" } });
  fireEvent.change(screen.getByTestId("tao-settings-cost"), { target: { value: "2.5" } });
  fireEvent.click(container.querySelector('[data-provider="ordinary"] > div')!);
  fireEvent.change(screen.getByTestId("llm-provider-model"), { target: { value: "provider-model-v3" } });
  fireEvent.change(screen.getByTestId("tao-settings-model"), { target: { value: "chat-model-v4" } });
  fireEvent.click(screen.getByTestId("llm-providers-save"));
  await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("save_ai_config", expect.anything()));
  const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "save_ai_config")!;
  expect(call[1]).toMatchObject({ config: {
    llm: { providers: { ordinary: { api_key: "vault:ordinary", model: "provider-model-v3" } } },
    deepseek_app: { provider: "ordinary", model: "chat-model-v4", tts_voice: "tide", cost_confirm_threshold_usd: 2.5 },
  } });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => /test_llm|deepseek_app_send/.test(command))).toBe(false);
});
