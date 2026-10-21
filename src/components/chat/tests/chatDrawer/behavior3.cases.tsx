import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../../stores/appStore";
import { useChatStore } from "../../../../stores/chatStore";
import { useNotesStore } from "../../../../stores/notesStore";
import { useTaoHubStore } from "../../../../stores/taoHubStore";
import { ChatDrawerRibbon } from "../../ChatDrawer";
import { resetTaoAlertStore } from "./harness";

export function registerChatDrawerBehavior3Cases() {

  describe("ChatDrawerRibbon", () => {
    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
      useNotesStore.setState({ alerts: [] });
      resetTaoAlertStore();
    });

    it("shows only Tao and opens the stable chat tab id", () => {
      const openTabChat = vi.fn().mockResolvedValue(undefined);
      useAppStore.setState({
        tabs: [{
          id: "visual-tab",
          chatTabId: "stable-chat-tab",
          type: "terminal",
          title: "Terminal",
          closable: true,
        }],
        activeTabId: "visual-tab",
      });
      useChatStore.setState({
        drawerOpen: false,
        drawerPosition: "left",
        drawerPinned: true,
        openTabChat,
      });

      render(
        <div className="relative h-32 w-32">
          <ChatDrawerRibbon />
        </div>,
      );

      const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
      expect(ribbon).toHaveTextContent(/^Tao$/);
      expect(ribbon).toHaveClass("rounded-r-full");
      fireEvent.click(ribbon);
      expect(openTabChat).toHaveBeenCalledWith("stable-chat-tab");
    });

    it("shows Tao for git tabs and opens the git tab chat", () => {
      const openTabChat = vi.fn().mockResolvedValue(undefined);
      useAppStore.setState({
        tabs: [{
          id: "git-tab",
          type: "git",
          title: "Git taomni",
          closable: true,
          git: { repoRoot: "/repo/taomni" },
        }],
        activeTabId: "git-tab",
      });
      useChatStore.setState({
        drawerOpen: false,
        drawerPosition: "left",
        drawerPinned: true,
        openTabChat,
      });

      render(
        <div className="relative h-32 w-32">
          <ChatDrawerRibbon />
        </div>,
      );

      const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
      expect(ribbon).toHaveTextContent(/^Tao$/);
      fireEvent.click(ribbon);
      expect(openTabChat).toHaveBeenCalledWith("git-tab");
    });

    it.each([
      ["left", 4, 300],
      ["right", 796, 300],
      ["top", 400, 4],
      ["bottom", 400, 596],
    ] as const)("docks the ribbon to the nearest %s edge when dragged", (expected, clientX, clientY) => {
      Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
      useAppStore.setState({
        tabs: [{ id: "term-1", type: "terminal", title: "Terminal", closable: true }],
        activeTabId: "term-1",
      });
      useChatStore.setState({
        drawerOpen: false,
        drawerPosition: "left",
        drawerPinned: true,
      });

      render(
        <div className="relative h-32 w-32">
          <ChatDrawerRibbon />
        </div>,
      );

      const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
      fireEvent.pointerDown(ribbon, { button: 0, pointerId: 1, clientX: 400, clientY: 300 });
      fireEvent.pointerMove(ribbon, { pointerId: 1, clientX, clientY });
      fireEvent.pointerUp(ribbon, { pointerId: 1, clientX, clientY });

      expect(useChatStore.getState().drawerPosition).toBe(expected);
    });

    it("delays top and bottom hover-open long enough for drag to start", () => {
      vi.useFakeTimers();
      const openTabChat = vi.fn().mockResolvedValue(undefined);
      try {
        useAppStore.setState({
          tabs: [{ id: "term-1", type: "terminal", title: "Terminal", closable: true }],
          activeTabId: "term-1",
        });
        useChatStore.setState({
          drawerOpen: false,
          drawerPosition: "top",
          drawerPinned: false,
          openTabChat,
        });

        render(
          <div className="relative h-32 w-32">
            <ChatDrawerRibbon />
          </div>,
        );

        const ribbon = screen.getByTestId("ai-chat-drawer-ribbon");
        fireEvent.mouseEnter(ribbon);
        vi.advanceTimersByTime(300);
        expect(openTabChat).not.toHaveBeenCalled();

        fireEvent.pointerDown(ribbon, { button: 0, pointerId: 1, clientX: 400, clientY: 4 });
        vi.advanceTimersByTime(1000);
        expect(openTabChat).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("badges pending alerts and opens the Notifications hub tab on click", () => {
      const openTabChat = vi.fn().mockResolvedValue(undefined);
      const setActiveNote = vi.fn();
      const ackAlert = vi.fn().mockResolvedValue(undefined);
      useAppStore.setState({
        tabs: [{ id: "term-1", chatTabId: "stable-chat", type: "terminal", title: "T", closable: true }],
        activeTabId: "term-1",
      });
      useChatStore.setState({ drawerOpen: false, drawerPosition: "left", drawerPinned: true, openTabChat });
      useTaoHubStore.setState({ hubTab: "chat" });
      useNotesStore.setState({
        alerts: [
          {
            id: "evt-1",
            note_id: "note-7",
            kind: "overdue",
            state: "pending",
            fire_at: 1,
            acknowledged_at: null,
            note_title: "Pay invoice",
            due_at: 1,
            reminder_at: null,
          },
        ],
        setActiveNote,
        ackAlert,
      });
      resetTaoAlertStore();

      render(
        <div className="relative h-32 w-32">
          <ChatDrawerRibbon />
        </div>,
      );

      expect(screen.getByTestId("tao-ribbon-badge")).toHaveTextContent("1");
      fireEvent.click(screen.getByTestId("ai-chat-drawer-ribbon"));
      expect(openTabChat).toHaveBeenCalledWith("stable-chat");
      expect(setActiveNote).not.toHaveBeenCalled();
      expect(ackAlert).not.toHaveBeenCalled();
      expect(useTaoHubStore.getState().hubTab).toBe("notifications");
    });

    it("opens the Notifications hub tab when multiple alerts are pending", () => {
      const openTabChat = vi.fn().mockResolvedValue(undefined);
      useAppStore.setState({
        tabs: [{ id: "term-1", chatTabId: "stable-chat", type: "terminal", title: "T", closable: true }],
        activeTabId: "term-1",
      });
      useChatStore.setState({ drawerOpen: false, drawerPosition: "left", drawerPinned: true, openTabChat });
      useNotesStore.setState({
        alerts: [
          { id: "a", note_id: "n1", kind: "overdue", state: "pending", fire_at: 1, acknowledged_at: null, note_title: "A", due_at: 1, reminder_at: null },
          { id: "b", note_id: "n2", kind: "due_soon", state: "pending", fire_at: 2, acknowledged_at: null, note_title: "B", due_at: 2, reminder_at: null },
        ],
      });
      render(
        <div className="relative h-32 w-32">
          <ChatDrawerRibbon />
        </div>,
      );
      expect(screen.getByTestId("tao-ribbon-badge")).toHaveTextContent("2");
      fireEvent.click(screen.getByTestId("ai-chat-drawer-ribbon"));
      expect(openTabChat).toHaveBeenCalledWith("stable-chat");
      expect(useTaoHubStore.getState().hubTab).toBe("notifications");
    });
  });
}
