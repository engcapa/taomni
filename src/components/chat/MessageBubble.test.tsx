import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../../stores/chatStore";

const coreMocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://preview/${encodeURIComponent(path)}`),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => coreMocks);

describe("MessageBubble tool activity collapse", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("collapses tool transcript by default and expands on click", () => {
    const message: ChatMessage = {
      id: "msg-tools",
      thread_id: "thread-1",
      role: "assistant",
      content: [
        "Working on it.",
        "",
        "> 🔧 `search_tool`",
        "> ↳ completed",
        "> 🔧 `run_terminal_command` — rm -v /tmp/x",
        "> ↳ removed",
        "",
        "Done.",
      ].join("\n"),
      created_at: 1,
      redacted: false,
    };

    render(<MessageBubble message={message} />);

    expect(screen.getByText("Working on it.")).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    // Collapsed: summary chip visible with tool previews; detail rows hidden.
    const toggle = screen.getByTestId("chat-tool-activity-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("chat-tool-activity-list")).not.toBeInTheDocument();
    // Summary embeds tool names for scanability even while collapsed.
    expect(toggle.textContent).toMatch(/search_tool/);
    expect(toggle.textContent).toMatch(/run_terminal_command/);

    fireEvent.click(toggle);

    expect(screen.getByTestId("chat-tool-activity-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("chat-tool-activity-list")).toBeInTheDocument();
    expect(screen.getByText("search_tool")).toBeInTheDocument();
    expect(screen.getByText("run_terminal_command")).toBeInTheDocument();
  });
});

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
          preview_url: "https://media.example/image.png",
        },
        {
          id: "video-1",
          kind: "video",
          path: "C:\\Taomni\\ai-generations\\clip.mp4",
          name: "clip.mp4",
          size: 256,
          mime: "video/mp4",
          preview_url: null,
        },
      ],
    };

    render(<MessageBubble message={message} />);

    const image = screen.getByAltText("image.png") as HTMLImageElement;
    const video = screen.getByTitle("clip.mp4") as HTMLVideoElement;

    await waitFor(() => {
      expect(coreMocks.convertFileSrc).toHaveBeenCalledWith("C:\\Taomni\\ai-generations\\clip.mp4");
    });
    expect(coreMocks.convertFileSrc).not.toHaveBeenCalledWith("C:\\Taomni\\ai-generations\\image.png");
    expect(image.src).toBe("https://media.example/image.png");
    expect(video).toHaveAttribute("controls");
    expect(video.getAttribute("src")).toBeTruthy();
  });

  it("uses the message remote URL as a preview fallback for older generated media", () => {
    const message: ChatMessage = {
      id: "msg-remote",
      thread_id: "thread-1",
      role: "assistant",
      content: "Generated image saved locally.\n\nRemote URL:\nhttps://media.example/old-image.png",
      created_at: 1,
      redacted: false,
      attachments: [
        {
          id: "image-old",
          kind: "image",
          path: "C:\\Taomni\\ai-generations\\old-image.png",
          name: "old-image.png",
          size: 128,
          mime: "image/png",
        },
      ],
    };

    render(<MessageBubble message={message} />);

    const image = screen.getByAltText("old-image.png") as HTMLImageElement;
    expect(coreMocks.convertFileSrc).not.toHaveBeenCalled();
    expect(image.src).toBe("https://media.example/old-image.png");
  });
});
