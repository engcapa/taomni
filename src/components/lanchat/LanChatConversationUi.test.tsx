import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanTransferProgress } from "../../types";
import { LanChatPanel } from "./LanChatPanel";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { TransferTrayButton } from "./TransferPanel";

const initialState = useLanChatStore.getState();

const profile = {
  id: "me",
  name: "我",
  signature: "",
  status: "online" as const,
  updatedAt: 1,
};

const peer = {
  id: "peer-1",
  name: "赵敏",
  signature: "",
  status: "online" as const,
  lastSeen: 1,
  addr: "192.168.1.8",
  port: 7777,
};

function transfer(overrides: Partial<LanTransferProgress>): LanTransferProgress {
  return {
    transferId: "tx-1",
    direction: "recv",
    name: "lanchat-design.pdf",
    size: 200,
    transferred: 100,
    rate: 64,
    eta: 2,
    state: "active",
    convId: "direct:peer-1",
    ...overrides,
  };
}

function resetStore() {
  useLanChatStore.setState(
    {
      ...initialState,
      isDesktop: true,
      profile,
      roster: [peer],
      groups: [],
      conversations: [],
      messagesByConv: {},
      activeConvId: null,
      transfers: {},
      transferPaths: {},
    },
    true,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  resetStore();
});

afterEach(() => {
  cleanup();
  resetStore();
});

describe("LanChat conversation UI", () => {
  it("renders file transfers as message-stream cards", () => {
    const transferControl = vi.fn(async () => undefined);
    useLanChatStore.setState({
      activeConvId: "direct:peer-1",
      transferControl,
      transfers: {
        "tx-1": transfer({ transferred: 124, size: 200, rate: 256, eta: 3 }),
      },
    });

    render(<MessageThread />);

    const card = screen.getByTestId("lanchat-file-card");
    expect(card).toHaveTextContent("lanchat-design.pdf");
    expect(card).toHaveTextContent("接收");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "62");

    fireEvent.click(screen.getByTitle("暂停"));
    expect(transferControl).toHaveBeenCalledWith("tx-1", "pause");
  });

  it("keeps completed file cards actionable", () => {
    const openTransfer = vi.fn(async () => undefined);
    const openTransferFolder = vi.fn(async () => undefined);
    const sendFilePath = vi.fn(async () => undefined);
    useLanChatStore.setState({
      activeConvId: "direct:peer-1",
      openTransfer,
      openTransferFolder,
      sendFilePath,
      transferPaths: { "tx-done": "C:\\Downloads\\logs.zip" },
      transfers: {
        "tx-done": transfer({
          transferId: "tx-done",
          direction: "send",
          name: "logs.zip",
          size: 500,
          transferred: 500,
          rate: 0,
          eta: 0,
          state: "done",
        }),
      },
    });

    render(<MessageThread />);

    fireEvent.click(screen.getByTitle("打开文件"));
    fireEvent.click(screen.getByTitle("打开所在目录"));
    fireEvent.click(screen.getByTitle("重新发送"));

    expect(openTransfer).toHaveBeenCalledWith("tx-done");
    expect(openTransferFolder).toHaveBeenCalledWith("tx-done");
    expect(sendFilePath).toHaveBeenCalledWith("C:\\Downloads\\logs.zip");
  });

  it("shows active transfer status in the tray and clears finished records", () => {
    useLanChatStore.setState({
      transfers: {
        "tx-active": transfer({ transferId: "tx-active", transferred: 100, size: 200 }),
        "tx-done": transfer({
          transferId: "tx-done",
          direction: "send",
          name: "screenshot.png",
          size: 10,
          transferred: 10,
          rate: 0,
          eta: 0,
          state: "done",
        }),
      },
      transferPaths: { "tx-done": "C:\\Downloads\\screenshot.png" },
    });

    render(<TransferTrayButton />);
    expect(screen.getByTestId("lanchat-transfer-tray")).toHaveTextContent("50%");

    fireEvent.click(screen.getByTestId("lanchat-transfer-tray"));
    expect(screen.getByTestId("lanchat-transfer-tray-popover")).toHaveTextContent("当前传输");
    expect(screen.getByText("lanchat-design.pdf")).toBeInTheDocument();
    expect(screen.getByText("screenshot.png")).toBeInTheDocument();

    fireEvent.click(screen.getByText("清理已完成"));
    expect(useLanChatStore.getState().transfers["tx-active"]).toBeDefined();
    expect(useLanChatStore.getState().transfers["tx-done"]).toBeUndefined();
  });

  it("uses a multi-line composer and sends with Enter", async () => {
    const sendCurrent = vi.fn(async () => undefined);
    useLanChatStore.setState({
      activeConvId: "direct:peer-1",
      sendCurrent,
    });

    render(<MessageInput />);

    const textarea = screen.getByTestId("lanchat-composer-textarea") as HTMLTextAreaElement;
    expect(textarea.rows).toBe(3);
    expect(textarea.style.minHeight).toBe("72px");
    expect(textarea.style.maxHeight).toBe("144px");

    fireEvent.change(textarea, { target: { value: "你好" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(sendCurrent).toHaveBeenCalledWith("你好", []));
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("collapses the member panel into a ribbon and expands it again", () => {
    useLanChatStore.setState({
      init: vi.fn(async () => undefined),
      activeConvId: "direct:peer-1",
      conversations: [
        { id: "direct:peer-1", kind: "direct", peerOrGroupId: "peer-1", lastMsgAt: 1, unread: 0 },
      ],
    });

    render(<LanChatPanel />);

    expect(screen.getByTestId("lanchat-roster-panel")).toHaveStyle({ width: "236px" });
    fireEvent.click(screen.getByTestId("lanchat-roster-collapse"));

    expect(screen.queryByTestId("lanchat-roster-panel")).toBeNull();
    expect(screen.getByTestId("lanchat-roster-ribbon")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("lanchat-roster-expand"));
    expect(screen.getByTestId("lanchat-roster-panel")).toBeInTheDocument();
  });

  it("resizes the member panel by dragging the conversation divider", () => {
    useLanChatStore.setState({
      init: vi.fn(async () => undefined),
      activeConvId: "direct:peer-1",
      conversations: [
        { id: "direct:peer-1", kind: "direct", peerOrGroupId: "peer-1", lastMsgAt: 1, unread: 0 },
      ],
    });

    render(<LanChatPanel />);

    const handle = screen.getByTestId("lanchat-roster-resize-handle");
    fireEvent.pointerDown(handle, { clientX: 236 });
    fireEvent.pointerMove(document, { clientX: 306 });
    fireEvent.pointerUp(document);

    expect(screen.getByTestId("lanchat-roster-panel")).toHaveStyle({ width: "306px" });

    fireEvent.doubleClick(handle);
    expect(screen.getByTestId("lanchat-roster-panel")).toHaveStyle({ width: "236px" });
  });
});
