import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "../chat/Composer";
import { AiRewriteOverlay } from "../terminal/AiRewriteOverlay";
import { MessageInput } from "../lanchat/MessageInput";
import { useAiStore } from "../../stores/aiStore";
import { useChatStore } from "../../stores/chatStore";
import { useLanChatStore } from "../../stores/lanChatStore";
const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
beforeEach(() => {
  useAiStore.setState({ config: null });
  useChatStore.setState({ pendingComposerText: "", composerDrafts: {} });
  ipc.mockReset().mockImplementation(async (c) => c === "voice_capture_supported" ? true : c === "voice_models" ? [{ id: "whisper-base", installed: true }] : c === "voice_stop_and_transcribe" ? { transcript: "检查日志" } : null);
});
afterEach(cleanup);
async function dictate(id: string) {
  fireEvent.click(screen.getByTestId(id));
  await waitFor(() => expect(screen.getByTestId(id)).toHaveAttribute("data-state", "recording"));
  fireEvent.click(screen.getByTestId(id));
}
it("Chat receives a draft and never calls onSend", async () => {
  const send = vi.fn(); render(<Composer onSend={send} sending={false} />);
  await dictate("chat-voice-button");
  await waitFor(() => expect(screen.getByTestId("chat-composer-textarea")).toHaveValue("检查日志"));
  expect(send).not.toHaveBeenCalled();
});
it("terminal rewrite receives an instruction without generating or executing a command", async () => {
  const accept = vi.fn(); render(<AiRewriteOverlay currentCommand="ls" onAccept={accept} onDismiss={vi.fn()} />);
  await dictate("rewrite-voice-button");
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("检查日志"));
  expect(accept).not.toHaveBeenCalled();
  expect(ipc.mock.calls.some(([c]) => c === "tab_rewrite_command")).toBe(false);
});
it("LAN messenger receives a draft without sending it", async () => {
  const send = vi.fn(); useLanChatStore.setState({ activeConvId: "peer:a", sendCurrent: send });
  render(<MessageInput />); await dictate("lanchat-voice-button");
  await waitFor(() => expect(screen.getByTestId("lanchat-composer-textarea")).toHaveValue("检查日志"));
  expect(send).not.toHaveBeenCalled();
});
it("sending the Chat draft discards a pending transcription", async () => {
  let resolve!: (result: { transcript: string }) => void;
  const result = new Promise<{ transcript: string }>((r) => { resolve = r; });
  ipc.mockImplementation(async (c) => c === "voice_capture_supported" ? true : c === "voice_models" ? [{ id: "whisper-base", installed: true }] : c === "voice_stop_and_transcribe" ? result : null);
  const send = vi.fn(); render(<Composer onSend={send} sending={false} />);
  fireEvent.change(screen.getByTestId("chat-composer-textarea"), { target: { value: "original" } });
  await dictate("chat-voice-button");
  fireEvent.keyDown(screen.getByTestId("chat-composer-textarea"), { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await act(async () => resolve({ transcript: "stale" }));
  expect(screen.getByTestId("chat-composer-textarea")).toHaveValue("");
});
