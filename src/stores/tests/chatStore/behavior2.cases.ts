import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../../types";
import { useAiStore } from "../../aiStore";
import { useAppStore } from "../../appStore";
import { isChatCapableTabType, useChatStore } from "../../chatStore";
import { invokeMock, makeConfig, makeThread } from "./harness";

export function registerchatStoreBehavior2Cases() {

  describe("chatStore sendPromptToTabChat", () => {
    beforeEach(() => {
      invokeMock.mockReset();
      vi.mocked(listen).mockResolvedValue(() => undefined);
      useAiStore.setState({
        config: makeConfig(),
        loading: false,
        saving: false,
        testResults: {},
        voiceShellEnabled: false,
      });
      const thread = makeThread({
        id: "thread-code",
        provider_id: "deepseek",
        linked_session_id: "code-tab",
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
        drawerOpen: false,
        drawerScope: "tab",
        drawerTabId: "code-tab",
        tabDrawerOpenByTabId: {},
        activeThreadIdByTabId: { "code-tab": thread.id },
        drawerWidth: 380,
        drawerHeight: 420,
        drawerPosition: "right",
        drawerPinned: true,
        drawerFloatingOpacity: 1,
        pendingComposerText: "",
        composerDrafts: {},
      });
      useAppStore.setState({
        tabs: [
          {
            id: "code-tab",
            type: "code-workspace",
            title: "Code · app",
            closable: true,
            codeWorkspace: { repoRoot: "/repo/app" },
          } as Tab,
        ],
        activeTabId: "code-tab",
        codeWorkspaceByTab: {},
      });
      invokeMock.mockResolvedValue(null);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    const PROMPT = [
      "请把下面这段代码当作教学示例，讲解其中用到的语言语法与写法。",
      "",
      "## 上下文",
      "- 文件: src/lib.rs",
      "",
      "```rust",
      "impl Foo {}",
      "```",
    ].join("\n");

    // sendPromptToTabChat routes through enqueueMessage, which hands the prompt to
    // sendMessage without awaiting it (the send owns its own loading state). Spy on
    // that boundary: what reaches sendMessage is this method's contract, and
    // sendMessage's own path to chat_stream is covered by the context-bridge suite
    // above. The trailing two args are the queue's terminalContext/attachments
    // pass-through, undefined for a bare prompt.
    function spyOnSendMessage() {
      const sendMessage = vi.fn(async (_threadId: string, _content: string) => undefined);
      useChatStore.setState({ sendMessage });
      return sendMessage;
    }

    it("sends the prompt verbatim, without blockquote prefixes", async () => {
      const sendMessage = spyOnSendMessage();
      await useChatStore.getState().sendPromptToTabChat(PROMPT);

      expect(sendMessage).toHaveBeenCalledWith("thread-code", PROMPT, undefined, undefined);
      // Regression guard: attachToComposer's "> " prefix would fold the
      // instructions and the code fence into a single quoted block.
      const sent = sendMessage.mock.calls[0]?.[1] ?? "";
      expect(sent.split("\n").some((line) => line.startsWith(">"))).toBe(false);
      expect(sent).toContain("```rust");
    });

    it("auto-sends instead of staging in the composer", async () => {
      const sendMessage = spyOnSendMessage();
      await useChatStore.getState().sendPromptToTabChat(PROMPT);

      expect(useChatStore.getState().pendingComposerText).toBe("");
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    it("reuses the tab's thread so follow-ups stay in context", async () => {
      spyOnSendMessage();
      await useChatStore.getState().sendPromptToTabChat(PROMPT);

      expect(invokeMock).not.toHaveBeenCalledWith("chat_new_thread", expect.anything());
      expect(useChatStore.getState().threads).toHaveLength(1);
      expect(useChatStore.getState().activeThreadId).toBe("thread-code");
    });

    it("opens the drawer for the bound tab", async () => {
      spyOnSendMessage();
      await useChatStore.getState().sendPromptToTabChat(PROMPT);

      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: "code-tab",
      });
      expect(useChatStore.getState().tabDrawerOpenByTabId["code-tab"]).toBe(true);
    });

    it("ignores a blank prompt", async () => {
      const sendMessage = spyOnSendMessage();
      await useChatStore.getState().sendPromptToTabChat("   \n  ");

      expect(sendMessage).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalled();
      expect(useChatStore.getState().drawerOpen).toBe(false);
    });
  });

  describe("chatStore drawer lifecycle", () => {
    beforeEach(() => {
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(null);
      useAiStore.setState({
        config: makeConfig(),
        loading: false,
        saving: false,
        testResults: {},
        voiceShellEnabled: false,
      });
      useChatStore.setState({
        threads: [
          makeThread({ id: "thread-a", linked_session_id: "term-a" }),
          makeThread({ id: "thread-b", linked_session_id: "term-b" }),
          makeThread({ id: "global-thread", linked_session_id: null }),
        ],
        threadsLoaded: true,
        activeThreadId: "thread-a",
        messages: {},
        streamingId: {},
        ccToolCards: {},
        ccUsage: {},
        sendingByThreadId: { "thread-a": true },
        sending: true,
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: "term-a",
        tabDrawerOpenByTabId: { "term-a": true },
        activeThreadIdByTabId: { "term-a": "thread-a" },
        drawerWidth: 380,
        drawerHeight: 420,
        drawerPosition: "right",
        drawerPinned: true,
        drawerFloatingOpacity: 1,
        pendingComposerText: "",
        composerDrafts: {},
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("hides a tab-bound drawer on active-tab sync without stopping the running thread", async () => {
      await useChatStore.getState().syncTabChatWithActiveTab("term-b");

      expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: false,
        drawerScope: "tab",
        drawerTabId: "term-b",
        sending: true,
        sendingByThreadId: { "thread-a": true },
        tabDrawerOpenByTabId: { "term-a": true },
      });
    });

    it("hides a tab-bound drawer when switching to a non-chat tab without stopping", async () => {
      await useChatStore.getState().syncTabChatWithActiveTab(null);

      expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: false,
        drawerTabId: null,
        sending: true,
        sendingByThreadId: { "thread-a": true },
        tabDrawerOpenByTabId: { "term-a": true },
      });
    });

    it("lets automatic visibility changes hide the drawer without stopping", () => {
      useChatStore.getState().setDrawerOpen(false);

      expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: false,
        sending: true,
        sendingByThreadId: { "thread-a": true },
      });
    });

    it("dismisses the active tab drawer and prevents tab sync from reopening it", async () => {
      useChatStore.getState().dismissDrawer();

      expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: false,
        sending: true,
        sendingByThreadId: { "thread-a": true },
        tabDrawerOpenByTabId: { "term-a": false },
      });

      await useChatStore.getState().syncTabChatWithActiveTab("term-a");

      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: false,
        tabDrawerOpenByTabId: { "term-a": false },
      });
    });

    it("hides the active tab drawer without stopping the running thread", async () => {
      await useChatStore.getState().toggleTabChat("term-a");

      expect(invokeMock).not.toHaveBeenCalledWith("chat_stop_stream", expect.anything());
      expect(useChatStore.getState()).toMatchObject({
        drawerOpen: false,
        sending: true,
        sendingByThreadId: { "thread-a": true },
        tabDrawerOpenByTabId: { "term-a": false },
      });
    });

    it("restores each tab's remembered current thread without creating a new one", async () => {
      useChatStore.setState({
        threads: [
          makeThread({ id: "thread-a-latest", linked_session_id: "term-a", updated_at: 3 }),
          makeThread({ id: "thread-a-current", linked_session_id: "term-a", updated_at: 2 }),
          makeThread({ id: "thread-b", linked_session_id: "term-b", updated_at: 1 }),
        ],
        activeThreadId: "thread-a-current",
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: "term-a",
        tabDrawerOpenByTabId: { "term-a": true, "term-b": true },
        activeThreadIdByTabId: {
          "term-a": "thread-a-current",
          "term-b": "thread-b",
        },
      });

      await useChatStore.getState().syncTabChatWithActiveTab("term-b");

      expect(useChatStore.getState()).toMatchObject({
        activeThreadId: "thread-b",
        drawerOpen: true,
        drawerTabId: "term-b",
      });

      await useChatStore.getState().syncTabChatWithActiveTab("term-a");

      expect(invokeMock).not.toHaveBeenCalledWith("chat_new_thread", expect.anything());
      expect(useChatStore.getState()).toMatchObject({
        activeThreadId: "thread-a-current",
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: "term-a",
        activeThreadIdByTabId: {
          "term-a": "thread-a-current",
          "term-b": "thread-b",
        },
      });
    });
  });

  describe("isChatCapableTabType", () => {
    it("covers every tab kind that offers an AI action", () => {
      for (const type of [
        "welcome",
        "terminal",
        "rdp",
        "database",
        "redis",
        "hbase-shell",
        "mail",
        "git",
        "code-workspace",
      ]) {
        expect(isChatCapableTabType(type)).toBe(true);
      }
    });

    it("includes hbase-shell so its explain prompt binds to the HBase tab", () => {
      // Without this, sendPromptToTabChat falls back to the welcome tab and the
      // prompt lands in an unrelated thread.
      expect(isChatCapableTabType("hbase-shell")).toBe(true);
    });

    it("rejects tab kinds with no chat surface", () => {
      for (const type of ["nettools", "sockscap", "objectstorage", "notes", null, undefined, ""]) {
        expect(isChatCapableTabType(type)).toBe(false);
      }
    });
  });
}
