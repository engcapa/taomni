import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceSettingsDialog, useVoiceSettingsStore } from "./VoiceSettingsDialog";
import { DictationButton } from "./DictationButton";
import { useAiStore, type AiConfig } from "../../stores/aiStore";
const ipc = vi.hoisted(() => vi.fn());
const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, cb) => { events.set(name, cb); return () => events.delete(name); }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
function Input({ context = "one", disabled = false }: { context?: string; disabled?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("hello world");
  return <><textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)} /><DictationButton targetRef={ref} onText={setText} contextKey={context} disabled={disabled} /><VoiceSettingsDialog /></>;
}
async function record() {
  fireEvent.click(screen.getByTestId("dictation-button"));
  await waitFor(() => expect(screen.getByTestId("dictation-button")).toHaveAttribute("data-state", "recording"));
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
describe("local dictation lifecycle", () => {
  beforeEach(() => {
    events.clear();
    useAiStore.setState({ config: null });
    useVoiceSettingsStore.setState({ open: false });
    ipc.mockReset().mockImplementation(async (command: string) => {
      if (command === "voice_capture_supported") return true;
      if (command === "voice_models") return [{ id: "whisper-base", installed: true }];
      if (command === "voice_stop_and_transcribe") return { transcript: "你好" };
      return null;
    });
  });
  afterEach(cleanup);
  it("replaces selection in the current draft without sending", async () => {
    render(<Input />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.setSelectionRange(6, 11);
    await record();
    fireEvent.click(screen.getByTestId("dictation-button"));
    await waitFor(() => expect(input.value).toBe("hello 你好"));
    expect(ipc.mock.calls.some(([command]) => command.includes("send"))).toBe(false);
  });
  it("preserves edits made while decoding", async () => {
    const result = deferred<{ transcript: string }>();
    ipc.mockImplementation(async (c) => c === "voice_capture_supported" ? true : c === "voice_models" ? [{ id: "whisper-base", installed: true }] : c === "voice_stop_and_transcribe" ? result.promise : null);
    render(<Input />);
    await record(); fireEvent.click(screen.getByTestId("dictation-button"));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "new " } }); input.setSelectionRange(4, 4);
    await act(async () => result.resolve({ transcript: "text" }));
    expect(input.value).toBe("new text");
  });
  it.each(["context", "cancel", "blur", "escape", "disabled", "unmount"])("discards late results after %s", async (kind) => {
    const result = deferred<{ transcript: string }>();
    const callback = vi.fn();
    ipc.mockImplementation(async (c) => c === "voice_capture_supported" ? true : c === "voice_models" ? [{ id: "whisper-base", installed: true }] : c === "voice_stop_and_transcribe" ? result.promise : null);
    const view = render(<DictationButton onTranscript={callback} contextKey="one" />);
    await record(); fireEvent.click(screen.getByTestId("dictation-button"));
    if (kind === "context") view.rerender(<DictationButton onTranscript={callback} contextKey="two" />);
    if (kind === "disabled") view.rerender(<DictationButton onTranscript={callback} contextKey="one" disabled />);
    if (kind === "unmount") view.unmount();
    if (kind === "cancel") fireEvent.click(screen.getByTestId("dictation-button-cancel"));
    if (kind === "blur") fireEvent(window, new Event("blur"));
    if (kind === "escape") fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => result.resolve({ transcript: "stale" }));
    expect(callback).not.toHaveBeenCalled();
    expect(ipc.mock.calls.some(([c]) => c === "voice_stop_capture")).toBe(true);
  });
  it("recovers from microphone permission errors", async () => {
    let denied = true;
    ipc.mockImplementation(async (c) => {
      if (c === "voice_capture_supported") return true;
      if (c === "voice_models") return [{ id: "whisper-base", installed: true }];
      if (c === "voice_start_capture" && denied) throw new Error("MIC_PERMISSION_OR_DEVICE");
      return null;
    });
    render(<Input />); fireEvent.click(screen.getByTestId("dictation-button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("MIC_PERMISSION_OR_DEVICE");
    expect(screen.getByTestId("dictation-button")).toHaveAttribute("data-state", "idle");
    denied = false; await record();
  });
  it("keeps setup open when the initiating button unmounts on a responsive layout change", async () => {
    ipc.mockImplementation(async (c) => c === "voice_capture_supported" ? true : c === "voice_models" ? [{ id: "whisper-base", installed: false, bytes: 147951465, license: "MIT" }] : null);
    const Host = ({ show }: { show: boolean }) => <>{show && <DictationButton />}<VoiceSettingsDialog /></>;
    const view = render(<Host show />);
    fireEvent.click(screen.getByTestId("dictation-button"));
    expect(await screen.findByRole("dialog")).toBeVisible();
    view.rerender(<Host show={false} />);
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("opens model setup without an automatic download or microphone access", async () => {
    ipc.mockImplementation(async (c) => c === "voice_capture_supported" ? true : c === "voice_models" ? [{ id: "whisper-base", installed: false, bytes: 147951465, license: "MIT" }] : null);
    render(<Input />); fireEvent.click(screen.getByTestId("dictation-button"));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(ipc.mock.calls.some(([c]) => c === "voice_install_model" || c === "voice_start_capture")).toBe(false);
  });
  it("keeps partials out of the draft and waits for an acknowledged final", async () => {
    useAiStore.setState({ config: { asr: { active: "deepgram" } } as AiConfig });
    const stopped = deferred<void>();
    ipc.mockImplementation(async (c) => c === "voice_capture_supported" ? true : c === "voice_stop_stream" ? stopped.promise : null);
    render(<Input />);
    await record();
    const id = ipc.mock.calls.find(([c]) => c === "voice_start_stream")![1].sessionId;
    const transcript = (text: string, final_text: boolean) => act(() => events.get("voice-transcript")!({ payload: { session_id: id, text, final_text } }));
    transcript("temporary", false);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.value).toBe("hello world");
    expect(screen.getByTestId("dictation-button-interim")).toHaveTextContent("temporary");
    fireEvent.click(screen.getByTestId("dictation-button"));
    expect(screen.getByTestId("dictation-button")).toHaveAttribute("data-state", "transcribing");
    fireEvent.change(input, { target: { value: "edited " } });
    input.setSelectionRange(7, 7);
    transcript("final", true);
    expect(input.value).toBe("edited final");
    await act(async () => stopped.resolve());
    expect(screen.getByTestId("dictation-button")).toHaveAttribute("data-state", "idle");
    transcript("late", true);
    expect(input.value).toBe("edited final");
  });
  it("cancels streaming without committing the provisional text", async () => {
    useAiStore.setState({ config: { asr: { active: "deepgram" } } as AiConfig });
    render(<Input />); await record();
    const id = ipc.mock.calls.find(([c]) => c === "voice_start_stream")![1].sessionId;
    act(() => events.get("voice-transcript")!({ payload: { session_id: id, text: "discard", final_text: false } }));
    fireEvent.click(screen.getByTestId("dictation-button-cancel"));
    act(() => events.get("voice-transcript")!({ payload: { session_id: id, text: "late", final_text: true } }));
    expect(screen.getByRole("textbox")).toHaveValue("hello world");
    expect(ipc).toHaveBeenCalledWith("voice_stop_capture", { sessionId: id });
    expect(ipc.mock.calls.some(([c]) => c === "voice_stop_stream")).toBe(false);
  });

});
