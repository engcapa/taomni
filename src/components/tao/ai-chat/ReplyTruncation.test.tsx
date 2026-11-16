import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { createChatController } from "./controller";
import { TaoAiChat } from "./TaoAiChat";
import type { ChatProfile, TaoEvent } from "./ports";

afterEach(cleanup);

it("shows output exhaustion for reasoning alone and offers regeneration instead of unsupported continuation", async () => {
  setLocale("en");
  const profile: ChatProfile = { modes: [{ id: "ask", label: "问" }], sidePanels: [], defaultModel: "deepseek-v4.1-flash", defaultThinking: true, defaultWeb: false };
  const regenerate = vi.fn(async () => [
    { type: "message_start" },
    { type: "block_start", index: 0, block: { type: "text" } },
    { type: "block_delta", index: 0, delta: { text: "Final implementation" } },
    { type: "message_delta", stopReason: "end_turn" },
    { type: "message_stop" },
  ] as TaoEvent[]);
  const controller = createChatController({ profile, backend: { send: async () => [
    { type: "block_start", index: 0, block: { type: "thinking", text: "Designing the implementation" } },
    { type: "message_delta", stopReason: "max_tokens" },
    { type: "message_stop" },
  ], regenerate } });
  await controller.send("Build a project");
  render(<TaoAiChat controller={controller} profile={profile} />);
  expect(screen.getByTestId("tao-home-stopped-state")).toHaveTextContent("Response reached the output limit");
  expect(screen.queryByTestId("tao-home-continue")).toBeNull();
  expect(regenerate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("tao-home-regenerate"));
  await waitFor(() => expect(screen.getByText("Final implementation")).toBeInTheDocument());
  expect(regenerate).toHaveBeenCalledOnce();
  expect(screen.queryByTestId("tao-home-stopped-state")).toBeNull();
});
