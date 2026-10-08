import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsrPanel } from "./AsrPanel";
import { useAiStore } from "../../stores/aiStore";
const ipc = vi.hoisted(() => vi.fn());
const picker = vi.hoisted(() => vi.fn());
const progressListeners = vi.hoisted(() => new Set<(event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (event, callback) => {
  const listener = (data: { payload: unknown }) => {
    const streaming = (data.payload as { model_id?: string }).model_id === "sherpa-zipformer-zh-en";
    if (event === (streaming ? "voice-sherpa-model-progress" : "voice-model-progress")) callback(data);
  };
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker }));
beforeEach(async () => {
  ipc.mockReset(); picker.mockReset(); progressListeners.clear(); localStorage.clear();
  ipc.mockResolvedValue(null);
  useAiStore.setState({ config: null });
  await useAiStore.getState().loadConfig();
});
afterEach(cleanup);
it("does not activate uninstalled weights and recovers after a corrupt import", async () => {
  let installed = false;
  ipc.mockImplementation(async (c) => {
    if (c === "voice_capture_supported") return true;
    if (c === "voice_models") return [{ id: "whisper-small", bytes: 487601967, installed, license: "MIT" }];
    if (c === "voice_install_model") { if (!installed) throw new Error("MODEL_CORRUPT"); return null; }
    return null;
  });
  picker.mockResolvedValue("/tmp/wrong.bin");
  render(<AsrPanel />);
  expect(await screen.findByTestId("asr-select-whisper-small")).toBeDisabled();
  fireEvent.click(screen.getByText("Import .bin"));
  expect(await screen.findByRole("alert")).toHaveTextContent("MODEL_CORRUPT");
  expect(screen.getByTestId("asr-download-whisper-small")).toBeEnabled();
  installed = true;
  fireEvent.click(screen.getByTestId("asr-download-whisper-small"));
  await waitFor(() => expect(screen.getByTestId("asr-select-whisper-small")).toBeEnabled());
  fireEvent.click(screen.getByTestId("asr-select-whisper-small"));
  await waitFor(() => expect(useAiStore.getState().config?.asr.active).toBe("whisper-small"));
  expect(ipc).toHaveBeenCalledWith("voice_install_model", { modelId: "whisper-small", sourcePath: "/tmp/wrong.bin" });
});

it("checks installed revisions and updates only after an explicit click", async () => {
  let installed = false;
  const status = (verified = false) => [{ id: "whisper-base", bytes: 147951465, license: "MIT", installed,
    update_available: !installed, available_version: "new-revision", installed_version: installed ? "new-revision" : "old-revision",
    integrity: installed ? verified ? "verified" : "unverified" : "missing" }];
  ipc.mockImplementation(async (c) => {
    if (c === "voice_capture_supported") return true;
    if (c === "voice_models") return status();
    if (c === "voice_check_models") return status(true);
    if (c === "voice_install_model") { installed = true; return null; }
    return null;
  });
  render(<AsrPanel />);
  expect(await screen.findByText(/Model data update available/)).toBeVisible();
  fireEvent.click(screen.getByTestId("asr-check-models"));
  expect(await screen.findByText("Check complete. Review each model below.")).toBeVisible();
  expect(ipc.mock.calls.some(([c]) => c === "voice_install_model")).toBe(false);
  fireEvent.click(screen.getByTestId("asr-download-whisper-base"));
  await waitFor(() => expect(screen.queryByText(/Model data update available/)).not.toBeInTheDocument());
  fireEvent.click(screen.getByTestId("asr-check-models"));
  expect(await screen.findByText(/Downloaded and verified/)).toBeVisible();
});

it("persists an independent proxy, tests HF, and keeps application settings untouched", async () => {
  ipc.mockImplementation(async (command) => {
    if (command === "voice_capture_supported") return true;
    if (command === "voice_models") return [{ id: "whisper-base", bytes: 147951465, installed: false, license: "MIT" }];
    if (command === "list_sessions") return [];
    if (command === "test_proxy_connection") return "Connected";
    return null;
  });
  const view = render(<AsrPanel />);
  const mode = await screen.findByTestId("asr-download-proxy-mode");
  expect(mode).toHaveValue("app");
  fireEvent.change(mode, { target: { value: "custom" } });
  fireEvent.change(screen.getByPlaceholderText("Proxy host"), { target: { value: "127.0.0.1" } });
  fireEvent.change(screen.getByPlaceholderText("Port"), { target: { value: "7890" } });
  fireEvent.click(screen.getByLabelText("SOCKS 5"));
  expect(screen.getByTestId("asr-download-whisper-base")).toBeDisabled();
  fireEvent.click(screen.getByText("Test", { exact: true }));
  expect(await screen.findByText("Connected")).toBeVisible();
  expect(ipc).toHaveBeenCalledWith("test_proxy_connection", expect.objectContaining({ proxyHost: "127.0.0.1", proxyPort: 7890, testHost: "huggingface.co" }));
  fireEvent.click(screen.getByTestId("asr-download-proxy-save"));
  await waitFor(() => expect(screen.getByTestId("asr-download-whisper-base")).toBeEnabled());
  expect(useAiStore.getState().config?.asr.download_proxy).toMatchObject({ mode: "custom", custom: { host: "127.0.0.1", port: 7890, kind: "socks5" } });
  expect(ipc.mock.calls.some(([c]) => c === "save_app_proxy_config" || c === "get_app_proxy_config")).toBe(false);
  view.unmount(); render(<AsrPanel />);
  expect(screen.getByTestId("asr-download-proxy-mode")).toHaveValue("custom");
  expect(screen.getByPlaceholderText("Proxy host")).toHaveValue("127.0.0.1");
  fireEvent.change(screen.getByTestId("asr-download-proxy-mode"), { target: { value: "none" } });
  fireEvent.click(screen.getByTestId("asr-download-proxy-save"));
  await waitFor(() => expect(useAiStore.getState().config?.asr.download_proxy?.mode).toBe("none"));
});

it("keeps unsaved proxy edits and blocks download when saving fails", async () => {
  ipc.mockImplementation(async (command) => {
    if (command === "voice_capture_supported") return true;
    if (command === "voice_models") return [{ id: "whisper-base", bytes: 147951465, installed: false, license: "MIT" }];
    if (command === "save_ai_config") throw new Error("Save failed");
    return null;
  });
  render(<AsrPanel />);
  fireEvent.change(await screen.findByTestId("asr-download-proxy-mode"), { target: { value: "none" } });
  fireEvent.click(screen.getByTestId("asr-download-proxy-save"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  expect(screen.getByTestId("asr-download-whisper-base")).toBeDisabled();
  expect(screen.getByTestId("asr-download-proxy-mode")).toHaveValue("none");
  expect(useAiStore.getState().config?.asr.download_proxy?.mode).toBe("app");
});

const downloadUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin?download=true";
const baseModel = { id: "whisper-base", filename: "ggml-base.bin", bytes: 100_000_000, installed: false, license: "MIT", download_url: downloadUrl };
it("copies and opens the exact pinned download address", async () => {
  ipc.mockImplementation(async (c) => c === "voice_models" ? [baseModel] : c === "voice_capture_supported" ? true : null);
  render(<AsrPanel />);
  expect(await screen.findByTestId("asr-download-url-whisper-base")).toHaveAttribute("href", downloadUrl);
  fireEvent.click(screen.getByTestId("asr-copy-url-whisper-base"));
  expect(await screen.findByText("Copied")).toBeVisible();
  expect(ipc).toHaveBeenCalledWith("clipboard_write_text", { text: downloadUrl });
  fireEvent.click(screen.getByTestId("asr-open-url-whisper-base"));
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("open_external_url", { url: downloadUrl }));
  expect(ipc.mock.calls.some(([c]) => c === "voice_install_model")).toBe(false);
});
it("shows and copies the backend-provided Zipformer repository address", async () => {
  const current = useAiStore.getState().config!;
  useAiStore.setState({ config: { ...current, asr: { ...current.asr, active: "sherpa-zipformer-zh-en", mode: "local" } } });
  const downloadUrl = "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/tree/98590b7ed6443e77b714204da2757d75e1a642f4";
  ipc.mockImplementation(async (c) => c === "voice_models" ? [] : c === "voice_capture_supported" ? true : c === "voice_sherpa_model_status" ? {
    model_id: "sherpa-zipformer-zh-en", revision: "98590b7ed6443e77b714204da2757d75e1a642f4", download_url: downloadUrl,
    available_version: "98590b7ed644", installed_version: null, update_available: false, integrity: "missing",
    files: [], total_bytes: 199056205, downloaded_bytes: 0, installed: false,
  } : null);
  render(<AsrPanel />);
  expect(await screen.findByTestId("asr-download-url-sherpa-zipformer-zh-en")).toHaveAttribute("href", downloadUrl);
  fireEvent.click(screen.getByTestId("asr-copy-url-sherpa-zipformer-zh-en"));
  expect(await screen.findByText("Copied")).toBeVisible();
  expect(ipc).toHaveBeenCalledWith("clipboard_write_text", { text: downloadUrl });
  fireEvent.click(screen.getByTestId("asr-open-url-sherpa-zipformer-zh-en"));
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("open_external_url", { url: downloadUrl }));
});
const sherpaStatus = {
  model_id: "sherpa-zipformer-zh-en", revision: "fixture-v2", available_version: "fixture-v2",
  installed_version: null, update_available: false, integrity: "missing",
  files: [{ filename: "encoder.onnx", bytes: 199_056_205, downloaded: 25_000_000, installed: false }],
  total_bytes: 199_056_205, downloaded_bytes: 25_000_000, installed: false,
};
it("restores Zipformer progress after reopening, cancels, and resumes through the shared card", async () => {
  let job = { revision: 4, job_id: "sherpa-job", model_id: sherpaStatus.model_id, bytes: 25_000_000, total: 199_056_205, phase: "downloading" };
  ipc.mockImplementation(async (c) => {
    if (c === "voice_models") return [baseModel];
    if (c === "voice_capture_supported") return true;
    if (c === "voice_sherpa_model_status") return sherpaStatus;
    if (c === "voice_sherpa_model_installation") return { ...job };
    if (c === "voice_cancel_sherpa_model_installation") {
      job = { ...job, revision: 5, phase: "cancelled" };
      for (const callback of progressListeners) callback({ payload: job });
    }
    return null;
  });
  const view = render(<AsrPanel />);
  expect(await screen.findByRole("progressbar")).toHaveAttribute("value", "12");
  view.unmount(); render(<AsrPanel />);
  expect(await screen.findByTestId("asr-sherpa-installation-progress")).toHaveTextContent("25.0 / 199.1 MB");
  expect(screen.getByTestId("asr-download-whisper-base")).toBeDisabled();
  expect(screen.getByTestId("asr-download-sherpa-zipformer-zh-en")).toBeDisabled();
  fireEvent.click(screen.getByTestId("asr-cancel-sherpa-download"));
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("voice_cancel_sherpa_model_installation", { jobId: "sherpa-job" }));
  await waitFor(() => expect(screen.getByTestId("asr-download-sherpa-zipformer-zh-en")).toBeEnabled());
  expect(screen.getByTestId("asr-download-sherpa-zipformer-zh-en")).toHaveTextContent("Resume download");
  expect(within(screen.getByTestId("asr-model-sherpa-zipformer-zh-en")).getByRole("button", { name: "Use this model" })).toBeDisabled();
  fireEvent.click(screen.getByTestId("asr-download-sherpa-zipformer-zh-en"));
  fireEvent.click(screen.getByTestId("asr-download-sherpa-zipformer-zh-en"));
  await waitFor(() => expect(ipc.mock.calls.filter(([c]) => c === "voice_install_sherpa_model")).toHaveLength(1));
});
it("protects Zipformer from stale snapshots, shows failure, and blocks both downloads for unsaved proxy edits", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  ipc.mockImplementation(async (c) => c === "voice_models" ? [baseModel] : c === "voice_capture_supported" ? true : c === "voice_sherpa_model_status" ? sherpaStatus : c === "voice_sherpa_model_installation" ? pending : null);
  render(<AsrPanel />);
  await screen.findByTestId("asr-download-sherpa-zipformer-zh-en");
  const job = { revision: 2, job_id: "sherpa-job", model_id: sherpaStatus.model_id, bytes: 199_056_205, total: 199_056_205, phase: "verifying" };
  await act(async () => { for (const callback of progressListeners) callback({ payload: job }); });
  await act(async () => resolve({ ...job, revision: 1, bytes: 10, phase: "downloading" }));
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "100");
  expect(screen.getByTestId("asr-cancel-sherpa-download")).toBeDisabled();
  await act(async () => { for (const callback of progressListeners) callback({ payload: { ...job, revision: 3, phase: "failed", error: "Connection lost" } }); });
  expect(screen.getByTestId("asr-sherpa-installation-progress")).toHaveTextContent("Connection lost");
  expect(screen.getByTestId("asr-download-sherpa-zipformer-zh-en")).toBeEnabled();
  fireEvent.change(screen.getByTestId("asr-download-proxy-mode"), { target: { value: "none" } });
  expect(screen.getByTestId("asr-download-whisper-base")).toBeDisabled();
  expect(screen.getByTestId("asr-download-sherpa-zipformer-zh-en")).toBeDisabled();
  fireEvent.click(screen.getByTestId("asr-download-proxy-save"));
  await waitFor(() => expect(screen.getByTestId("asr-download-sherpa-zipformer-zh-en")).toBeEnabled());
});
it("restores backend progress on reopening, cancels the same job and resumes its partial file", async () => {
  let job = { revision: 1, job_id: "job-1", model_id: "whisper-base", bytes: 30_000_000, total: 100_000_000, phase: "downloading" };
  ipc.mockImplementation(async (c) => {
    if (c === "voice_models") return [{ ...baseModel, resumable_bytes: 30_000_000 }];
    if (c === "voice_capture_supported") return true;
    if (c === "voice_model_installation") return { ...job };
    if (c === "voice_cancel_model_installation") {
      job = { ...job, revision: 2, phase: "cancelled" };
      for (const callback of progressListeners) callback({ payload: job });
    }
    return null;
  });
  const first = render(<AsrPanel />);
  expect(await screen.findByTestId("asr-installation-progress")).toHaveTextContent("30.0 / 100.0 MB");
  first.unmount(); render(<AsrPanel />);
  expect(await screen.findByRole("progressbar")).toHaveAttribute("value", "30");
  expect(screen.getByTestId("asr-download-whisper-base")).toBeDisabled();
  expect(ipc.mock.calls.some(([c]) => c === "voice_install_model")).toBe(false);
  fireEvent.click(screen.getByTestId("asr-cancel-download"));
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("voice_cancel_model_installation", { jobId: "job-1" }));
  await waitFor(() => expect(screen.getByTestId("asr-download-whisper-base")).toBeEnabled());
  expect(screen.getByTestId("asr-download-whisper-base")).toHaveTextContent("Resume download");
  fireEvent.click(screen.getByTestId("asr-download-whisper-base"));
  fireEvent.click(screen.getByTestId("asr-download-whisper-base"));
  await waitFor(() => expect(ipc.mock.calls.filter(([c]) => c === "voice_install_model")).toHaveLength(1));
});
it("ignores an older snapshot and keeps full transfer distinct from verification completion", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  ipc.mockImplementation(async (c) => c === "voice_models" ? [baseModel] : c === "voice_capture_supported" ? true : c === "voice_model_installation" ? pending : null);
  render(<AsrPanel />);
  await screen.findByTestId("asr-download-whisper-base");
  const job = { revision: 2, job_id: "job-2", model_id: "whisper-base", bytes: 100_000_000, total: 100_000_000, phase: "verifying" };
  await act(async () => { for (const callback of progressListeners) callback({ payload: job }); });
  await act(async () => resolve({ ...job, revision: 1, bytes: 10_000_000, phase: "downloading" }));
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "100");
  expect(screen.getByTestId("asr-installation-progress")).toHaveTextContent("Verifying SHA-256");
  expect(screen.getByTestId("asr-download-whisper-base")).toBeDisabled();
  expect(screen.getByTestId("asr-cancel-download")).toBeDisabled();
});


it("requires an explicit verified q8 replacement action for installed f16", async () => {
  ipc.mockImplementation(async (command: string) => {
    if (command === "voice_models") return [
      { id: "whisper-small", filename: "ggml-small.bin", bytes: 487601967, installed: true, license: "MIT", replacement: "whisper-small-q8" },
      { id: "whisper-small-q8", filename: "ggml-small-q8_0.bin", bytes: 264464607, installed: false, license: "MIT" },
    ];
    if (command === "voice_capture_supported") return true;
    return null;
  });
  render(<AsrPanel />);
  const replace = await screen.findByTestId("asr-replace-whisper-small");
  await waitFor(() => expect(replace).toBeEnabled());
  expect(ipc.mock.calls.some(([c]) => c === "voice_install_model")).toBe(false);
  fireEvent.click(replace);
  await waitFor(() => expect(ipc).toHaveBeenCalledWith("voice_install_model", { modelId: "whisper-small-q8", sourcePath: null, replaceModelId: "whisper-small" }));
});

it("discloses online audio upload when a cloud provider is selected", async () => {
  const config = useAiStore.getState().config!;
  useAiStore.setState({ config: { ...config, asr: { ...config.asr, active: "soniox", mode: "online" } } });
  ipc.mockImplementation(async (command) => command === "voice_models" ? [] : command === "voice_capture_supported" ? true : null);
  render(<AsrPanel />);
  expect(await screen.findByText(/Audio is sent to the selected online provider/)).toBeVisible();
  expect(screen.queryByText(/Audio is not uploaded/)).not.toBeInTheDocument();
});
