import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStore } from "../../../../stores/aiStore";
import { useAppStore } from "../../../../stores/appStore";
import { useChatStore, type ChatThread } from "../../../../stores/chatStore";
import { useNotesStore } from "../../../../stores/notesStore";
import { useTaoAlertStore } from "../../../../stores/taoAlertStore";
import { useTaoHubStore } from "../../../../stores/taoHubStore";
import { ChatDrawer } from "../../ChatDrawer";
import { invokeMock, makeConfig, resetTaoAlertStore } from "./harness";

export function registerChatDrawerLayout2Cases() {

  describe("ChatDrawer layout resizing", () => {
    beforeEach(() => {
      Element.prototype.scrollIntoView = vi.fn();
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      invokeMock.mockReset();
      invokeMock.mockImplementation((command: string) => {
        if (command === "chat_list_threads") return Promise.resolve([]);
        if (command === "chat_purge_old") return Promise.resolve(0);
        if (command === "get_ai_config") return Promise.resolve(makeConfig());
        return Promise.resolve(null);
      });

      const thread: ChatThread = {
        id: "thread-1",
        title: "New chat",
        provider_id: "claude-code",
        created_at: 1,
        updated_at: 1,
        linked_session_id: "term-1",
        source: "drawer",
        mode: "chat",
        output_format: null,
        cc_model: null,
      };
      useAiStore.setState({
        config: makeConfig(),
        loading: false,
        saving: false,
        testResults: {},
        voiceShellEnabled: false,
      });
      useAppStore.setState({
        tabs: [{ id: "term-1", type: "terminal", title: "Terminal 1", closable: true }],
        activeTabId: "term-1",
        sqlEcho: false,
      });
      useChatStore.setState({
        threads: [thread],
        threadsLoaded: true,
        activeThreadId: thread.id,
        messages: { [thread.id]: [] },
        streamingId: {},
        ccToolCards: {},
        ccUsage: {},
        sendingByThreadId: {},
        sending: false,
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: "term-1",
        tabDrawerOpenByTabId: { "term-1": true },
        drawerWidth: 380,
        drawerHeight: 420,
        drawerPinned: false,
        drawerFloatingOpacity: 1,
        pendingComposerText: "",
        composerDrafts: {},
      });
    });

    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
      useTaoHubStore.setState({ hubTab: "chat" });
      resetTaoAlertStore();
      useNotesStore.setState({ alerts: [] });
    });

    it("dismisses a floating drawer on outside pointer down", () => {
      useChatStore.setState({ drawerPosition: "top", drawerPinned: false });
      render(<ChatDrawer />);

      fireEvent.pointerDown(document.body);

      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: false,
        tabDrawerOpenByTabId: { "term-1": false },
      });
    });

    it("keeps the drawer mounted while closed and does not re-animate scroll on reopen", async () => {
      const scrollIntoView = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
      useChatStore.setState({
        drawerPosition: "right",
        drawerPinned: true,
        messages: {
          "thread-1": [
            {
              id: "m1",
              thread_id: "thread-1",
              role: "user",
              content: "hello",
              created_at: 1,
              redacted: false,
            },
            {
              id: "m2",
              thread_id: "thread-1",
              role: "assistant",
              content: "world",
              created_at: 2,
              redacted: false,
            },
          ],
        },
      });

      render(<ChatDrawer />);
      const drawer = screen.getByTestId("ai-chat-drawer");
      expect(drawer).not.toHaveStyle({ display: "none" });

      // Initial open + thread align uses instant scroll, never smooth.
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalled();
      });
      expect(scrollIntoView.mock.calls.every((call) => call[0]?.behavior !== "smooth")).toBe(true);
      scrollIntoView.mockClear();

      act(() => {
        useChatStore.setState({ drawerOpen: false });
      });
      expect(drawer).toBeInTheDocument();
      expect(drawer).toHaveStyle({ display: "none" });
      expect(scrollIntoView).not.toHaveBeenCalled();

      act(() => {
        useChatStore.setState({ drawerOpen: true });
      });
      expect(drawer).not.toHaveStyle({ display: "none" });
      // Same thread re-shown: preserve scroll, do not jump/animate again.
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("keeps a floating drawer open when the AI safety gate is clicked", () => {
      useChatStore.setState({ drawerPosition: "top", drawerPinned: false });
      render(
        <>
          <ChatDrawer />
          <div data-testid="ai-chat-safety-gate">Safety gate</div>
        </>,
      );

      fireEvent.pointerDown(screen.getByTestId("ai-chat-safety-gate"));

      expect(useChatStore.getState().drawerOpen).toBe(true);
    });

    it("keeps a floating drawer open when a Tao portal popover is clicked", () => {
      useChatStore.setState({ drawerPosition: "top", drawerPinned: false });
      render(
        <>
          <ChatDrawer />
          <div data-testid="notes-date-popover" data-tao-floating-portal="notes-date-time">Date picker</div>
        </>,
      );

      fireEvent.pointerDown(screen.getByTestId("notes-date-popover"));

      expect(useChatStore.getState().drawerOpen).toBe(true);
    });

    it("resizes a top drawer by dragging its bottom edge", () => {
      useChatStore.setState({ drawerPosition: "top" });
      render(<ChatDrawer />);

      const handle = screen.getByTestId("ai-chat-drawer-height-resize");
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400, clientY: 420 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 520 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 520 });

      expect(useChatStore.getState().drawerHeight).toBe(520);
    });

    it("resizes a bottom drawer by dragging its top edge", () => {
      useChatStore.setState({ drawerPosition: "bottom" });
      render(<ChatDrawer />);

      const handle = screen.getByTestId("ai-chat-drawer-height-resize");
      fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 400, clientY: 420 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 320 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 320 });

      expect(useChatStore.getState().drawerHeight).toBe(520);
    });

    it("pins the drawer to the top edge as a full-width inline band", () => {
      useChatStore.setState({ drawerPosition: "top", drawerPinned: true });
      render(<ChatDrawer />);
      const drawer = screen.getByTestId("ai-chat-drawer");
      expect(drawer).toHaveAttribute("data-position", "top");
      expect(drawer).toHaveAttribute("data-pinned", "true");
      expect(drawer.className).toContain("w-full");
      const pin = screen.getByTestId("ai-chat-drawer-pin");
      expect(pin).toHaveAttribute("aria-pressed", "true");
      expect(pin).not.toBeDisabled();
    });

    it("does not dismiss a pinned top drawer on outside pointer down", () => {
      useChatStore.setState({ drawerPosition: "top", drawerPinned: true });
      render(<ChatDrawer />);
      fireEvent.pointerDown(document.body);
      expect(useChatStore.getState().drawerOpen).toBe(true);
    });

    it("keeps left/right pin as a side column (no regression)", () => {
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      useChatStore.setState({ drawerPosition: "right", drawerPinned: true });
      render(<ChatDrawer />);
      const drawer = screen.getByTestId("ai-chat-drawer");
      expect(drawer.className).toContain("relative");
      expect(drawer.className).not.toContain("w-full");
      expect(screen.getByTestId("ai-chat-drawer-pin")).toHaveAttribute("aria-pressed", "true");
    });

    it("adjusts opacity only for top or bottom floating drawers", () => {
      Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
      useChatStore.setState({
        drawerPosition: "top",
        drawerPinned: false,
        drawerFloatingOpacity: 0.8,
      });
      render(<ChatDrawer />);

      expect(screen.getByTestId("ai-chat-drawer")).toHaveStyle("opacity: 0.8");
      fireEvent.click(screen.getByTestId("ai-chat-drawer-opacity"));
      const slider = screen.getByTestId("ai-chat-drawer-opacity-slider") as HTMLInputElement;
      expect(slider.value).toBe("0.8");

      fireEvent.change(slider, { target: { value: "0.7" } });

      expect(useChatStore.getState().drawerFloatingOpacity).toBe(0.7);
      expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.layout.v1") ?? "{}"))
        .toMatchObject({ floatingOpacity: 0.7 });
    });

    it("does not show opacity controls for left or right floating drawers", () => {
      useChatStore.setState({
        drawerPosition: "left",
        drawerPinned: false,
        drawerFloatingOpacity: 0.75,
      });
      render(<ChatDrawer />);

      expect(screen.getByTestId("ai-chat-drawer")).not.toHaveStyle("opacity: 0.75");
      expect(screen.queryByTestId("ai-chat-drawer-opacity")).not.toBeInTheDocument();
    });

    it("shows the Tao Hub tab strip with Chat and Notes tabs", () => {
      useTaoHubStore.setState({ hubTab: "chat" });
      render(<ChatDrawer />);
      expect(screen.getByTestId("tao-hub-tab-chat")).toBeInTheDocument();
      expect(screen.getByTestId("tao-hub-tab-notes")).toBeInTheDocument();
      expect(screen.getByTestId("tao-hub-tab-notifications")).toBeInTheDocument();
      // Chat tab active by default → composer present, notes panel absent.
      expect(screen.queryByTestId("notes-panel")).not.toBeInTheDocument();
    });

    it("switches to the Notes tab and back without losing the chat view", () => {
      useTaoHubStore.setState({ hubTab: "chat" });
      render(<ChatDrawer />);

      fireEvent.click(screen.getByTestId("tao-hub-tab-notes"));
      expect(useTaoHubStore.getState().hubTab).toBe("notes");
      expect(screen.getByTestId("notes-panel")).toBeInTheDocument();
      expect(screen.getByTestId("notes-new")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("tao-hub-tab-chat"));
      expect(useTaoHubStore.getState().hubTab).toBe("chat");
      expect(screen.queryByTestId("notes-panel")).not.toBeInTheDocument();
    });

    it("opens mail notifications as a Tao Hub tab and clears only the clicked mail tab", () => {
      useTaoHubStore.setState({ hubTab: "chat" });
      useAppStore.setState({
        tabs: [
          { id: "term-1", type: "terminal", title: "Terminal 1", closable: true },
          { id: "mail-1", type: "mail", title: "Work mail", closable: true },
          { id: "mail-2", type: "mail", title: "Ops mail", closable: true },
        ],
        activeTabId: "term-1",
      });
      useTaoAlertStore.setState({
        mailNew: [
          {
            id: "mail:mail-1",
            source: "mail",
            kind: "mail_new",
            title: "Work mail",
            count: 3,
            mailTabId: "mail-1",
            mailAccountId: "acct-1",
            fireAt: 1,
          },
          {
            id: "mail:mail-2",
            source: "mail",
            kind: "mail_new",
            title: "Ops mail",
            count: 1,
            mailTabId: "mail-2",
            mailAccountId: "acct-2",
            fireAt: 2,
          },
        ],
      });

      render(<ChatDrawer />);

      fireEvent.click(screen.getByTestId("tao-hub-tab-notifications"));
      expect(screen.getByTestId("tao-alert-inbox")).toBeInTheDocument();
      expect(screen.getAllByTestId("tao-alert-inbox-item")).toHaveLength(2);
      expect(screen.getByTestId("tao-hub-notifications-badge")).toHaveTextContent("4");

      fireEvent.click(screen.getAllByTestId("tao-alert-jump")[0]);

      expect(useAppStore.getState().activeTabId).toBe("mail-1");
      expect(useTaoAlertStore.getState().mailNew.map((alert) => alert.mailTabId)).toEqual(["mail-2"]);
    });

    it("keeps dismissed notifications hidden until history is searched and supports clearing history", async () => {
      useTaoHubStore.setState({ hubTab: "notifications" });
      useTaoAlertStore.setState({
        mailNew: [
          {
            id: "mail:mail-1",
            source: "mail",
            kind: "mail_new",
            title: "Work mail",
            count: 2,
            mailTabId: "mail-1",
            mailAccountId: "acct-1",
            fireAt: 10,
          },
        ],
      });

      render(<ChatDrawer />);

      expect(screen.getByTestId("tao-alert-inbox-item")).toBeInTheDocument();
      expect(screen.queryByTestId("tao-alert-history-result")).not.toBeInTheDocument();
      await waitFor(() => expect(useTaoAlertStore.getState().history).toHaveLength(1));

      fireEvent.click(screen.getByTestId("tao-alert-ack"));
      expect(screen.queryByTestId("tao-alert-inbox-item")).not.toBeInTheDocument();

      fireEvent.change(screen.getByTestId("tao-alert-history-search"), { target: { value: "Work" } });
      expect(screen.getByTestId("tao-alert-history-result")).toHaveTextContent("Work mail");

      fireEvent.click(screen.getByTestId("tao-alert-history-clear"));
      expect(screen.queryByTestId("tao-alert-history-result")).not.toBeInTheDocument();
      expect(useTaoAlertStore.getState().history).toHaveLength(0);
    });
  });
}
