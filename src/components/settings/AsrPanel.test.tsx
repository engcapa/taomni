import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsrPanel } from "./AsrPanel";
import { useAiStore } from "../../stores/aiStore";
const ipc = vi.hoisted(() => vi.fn());
const picker = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker }));
beforeEach(async () => {
  ipc.mockReset(); picker.mockReset(); localStorage.clear();
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
