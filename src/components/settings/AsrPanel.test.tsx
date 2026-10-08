import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsrPanel } from "./AsrPanel";
import { useAiStore } from "../../stores/aiStore";
const ipc = vi.hoisted(() => vi.fn());
const picker = vi.hoisted(() => vi.fn());
const progressListeners = vi.hoisted(() => new Set<(event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_event, callback) => { progressListeners.add(callback); return () => progressListeners.delete(callback); }) }));
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
