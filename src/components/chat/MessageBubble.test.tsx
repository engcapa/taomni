import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../../stores/chatStore";

const coreMocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://preview/${encodeURIComponent(path)}`),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

describe("MessageBubble media previews", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders generated image and video attachments as previews", async () => {
    const message: ChatMessage = {
      id: "msg-1",
      thread_id: "thread-1",
      role: "assistant",
      content: "Generated media saved locally.",
      created_at: 1,
      redacted: false,
      attachments: [
        {
          id: "image-1",
          kind: "image",
          path: "C:\\Taomni\\ai-generations\\image.png",
          name: "image.png",
          size: 128,
          mime: "image/png",
        },
        {
          id: "video-1",
          kind: "video",
          path: "C:\\Taomni\\ai-generations\\clip.mp4",
          name: "clip.mp4",
          size: 256,
          mime: "video/mp4",
        },
      ],
    };

    render(<MessageBubble message={message} />);

    const image = screen.getByAltText("image.png") as HTMLImageElement;
    const video = screen.getByTitle("clip.mp4") as HTMLVideoElement;

    await waitFor(() => {
      expect(coreMocks.convertFileSrc).toHaveBeenCalledWith("C:\\Taomni\\ai-generations\\image.png");
      expect(coreMocks.convertFileSrc).toHaveBeenCalledWith("C:\\Taomni\\ai-generations\\clip.mp4");
    });
    expect(image.src).toContain(encodeURIComponent("C:\\Taomni\\ai-generations\\image.png"));
    expect(video).toHaveAttribute("controls");
    expect(video.getAttribute("src")).toBeTruthy();
  });
});
