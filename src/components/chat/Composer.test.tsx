import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { useChatStore } from "../../stores/chatStore";
import type { ChatAttachment } from "../../lib/chat/attachments";

const invokeMock = vi.hoisted(() => vi.fn());
const dialogOpenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
}));

function attachment(path: string, index = 0): ChatAttachment {
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    id: `att-${index}`,
    kind: name.endsWith(".png") ? "image" : "file",
    path,
    name,
    size: 2048,
    mime: name.endsWith(".png") ? "image/png" : "text/plain",
  };
}

describe("Composer attachments", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    dialogOpenMock.mockReset();
    useChatStore.setState({
      pendingComposerText: "",
      consumePendingComposerText: () => "",
    });
    invokeMock.mockImplementation((command: string, args: { paths?: string[] }) => {
      if (command === "chat_stat_attachment_paths") {
        return Promise.resolve((args.paths ?? []).map((path, index) => attachment(path, index)));
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("attaches picker files and sends metadata without leaking the local path in content", async () => {
    dialogOpenMock.mockResolvedValue(["C:\\tmp\\diagram.png"]);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<Composer onSend={onSend} sending={false} />);

    fireEvent.click(screen.getByTestId("ai-chat-attach-button"));
    expect(await screen.findByText("diagram.png (2.0 KiB)")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Send (Ctrl+Enter)"));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toBe("Please review the attached files.");
    expect(onSend.mock.calls[0][0]).not.toContain("C:\\tmp\\diagram.png");
    expect(onSend.mock.calls[0][2]).toEqual([attachment("C:\\tmp\\diagram.png")]);
  });

  it("attaches OS-dropped file paths to the composer", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} sending={false} />);

    fireEvent.drop(screen.getByTestId("ai-chat-composer"), {
      dataTransfer: {
        types: ["Files", "text/uri-list"],
        files: [],
        getData: (format: string) => (format === "text/uri-list" ? "file:///C:/tmp/drop.png" : ""),
        dropEffect: "none",
      },
    });

    expect(await screen.findByText("drop.png (2.0 KiB)")).toBeInTheDocument();
  });

  it("rejects more than ten attachments", async () => {
    const paths = Array.from({ length: 11 }, (_, i) => `C:\\tmp\\file-${i}.txt`);
    dialogOpenMock.mockResolvedValue(paths);
    const onSend = vi.fn().mockResolvedValue(undefined);

    render(<Composer onSend={onSend} sending={false} />);
    fireEvent.click(screen.getByTestId("ai-chat-attach-button"));

    expect(await screen.findByTestId("ai-chat-attachment-error")).toHaveTextContent("Attach up to 10 files.");
    expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
  });

  it("persists composer height after dragging the resize handle", () => {
    render(<Composer onSend={vi.fn()} sending={false} />);

    const handle = screen.getByTestId("ai-chat-composer-resize");
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 20 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 20 });

    const textarea = screen.getByPlaceholderText(/Type a message/) as HTMLTextAreaElement;
    expect(textarea.style.height).toBe("136px");
    expect(localStorage.getItem("taomni.chatComposer.height.v1")).toBe("136");
  });
});
