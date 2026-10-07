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
