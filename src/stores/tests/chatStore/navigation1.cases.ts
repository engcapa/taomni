import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tab } from "../../../types";
import { rememberChatDrawerProviderPreference, useAiStore } from "../../aiStore";
import { useAppStore } from "../../appStore";
import { useChatStore, type ChatThread } from "../../chatStore";
import { invokeMock, makeConfig, makeThread } from "./harness";

export function registerchatStoreNavigation1Cases() {

  describe("chatStore new thread provider selection", () => {
    beforeEach(() => {
      invokeMock.mockReset();
      window.localStorage.clear();
      useAiStore.setState({
        config: makeConfig(),
        loading: false,
        saving: false,
        testResults: {},
        voiceShellEnabled: false,
      });
      useChatStore.setState({
        threads: [],
        threadsLoaded: true,
        activeThreadId: null,
        messages: {},
        streamingId: {},
        ccToolCards: {},
        ccUsage: {},
        sendingByThreadId: {},
        sending: false,
        drawerOpen: false,
        drawerScope: null,
        drawerTabId: null,
        tabDrawerOpenByTabId: {},
        activeThreadIdByTabId: {},
        drawerWidth: 380,
        drawerHeight: 420,
        drawerPosition: "right",
        drawerPinned: true,
        drawerFloatingOpacity: 1,
        pendingComposerText: "",
        composerDrafts: {},
      });
      invokeMock.mockImplementation((command: string, args: { providerId?: string | null; linkedSessionId?: string | null; mode?: string | null; }) => {
        if (command !== "chat_new_thread") throw new Error(`unexpected command: ${command}`);
        const thread = makeThread({
          provider_id: args.providerId ?? "deepseek",
          linked_session_id: args.linkedSessionId ?? null,
          mode: args.mode ?? "chat",
        });
        return Promise.resolve(thread);
      });
    });

    afterEach(() => {
      window.localStorage.clear();
      vi.clearAllMocks();
    });

    it("uses the active LLM provider as the default even when Claude Code is enabled", async () => {
      await useChatStore.getState().newThread(undefined, "term-1");

      expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
        providerId: "deepseek",
        linkedSessionId: "term-1",
        mode: "chat",
      });
    });

    it("uses the remembered chat provider before the active LLM provider", async () => {
      rememberChatDrawerProviderPreference("local", "chat");

      await useChatStore.getState().newThread(undefined, "term-1");

      expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
        providerId: "local",
        linkedSessionId: "term-1",
        mode: "chat",
      });
    });

    it("keeps an explicitly selected provider even when Claude Code is enabled", async () => {
      await useChatStore.getState().newThread("local", undefined);

      expect(invokeMock).toHaveBeenCalledWith("chat_new_thread", {
        providerId: "local",
        linkedSessionId: null,
        mode: "chat",
      });
    });

    it("does not let an in-flight thread list overwrite a newer model pin", async () => {
      let releaseList!: (threads: ChatThread[]) => void;
      const list = new Promise<ChatThread[]>((resolve) => { releaseList = resolve; });
      const stale = makeThread({ id: "thread-1", provider_id: "opencode-go" });
      invokeMock.mockImplementation((command: string, args: { providerId?: string | null; linkedSessionId?: string | null; mode?: string | null; }) => {
        if (command === "chat_list_threads") return list;
        if (command === "chat_new_thread") return Promise.resolve({
          ...stale,
          provider_id: args.providerId ?? "opencode-go",
          linked_session_id: args.linkedSessionId ?? null,
          mode: args.mode ?? "chat",
        });
        if (command === "chat_set_thread_llm_model") return Promise.resolve(null);
        throw new Error(`unexpected command: ${command}`);
      });

      const loading = useChatStore.getState().loadThreads();
      await useChatStore.getState().newThread("opencode-go", "term-1");
      await useChatStore.getState().setThreadLlmModel("thread-1", "kimi-k3");
      releaseList([stale]);
      await loading;

      expect(useChatStore.getState().threads).toEqual([
        expect.objectContaining({ id: "thread-1", llm_model: "kimi-k3" }),
      ]);
    });

    it("reuses an existing tab thread instead of creating one for the default provider", async () => {
      useChatStore.setState({
        threads: [
          makeThread({
            id: "old-thread",
            title: "Old chat",
            provider_id: "deepseek",
            linked_session_id: "term-1",
          }),
        ],
      });

      await useChatStore.getState().openTabChat("term-1");

      expect(invokeMock).not.toHaveBeenCalled();
      expect(useChatStore.getState()).toMatchObject({
        activeThreadId: "old-thread",
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: "term-1",
        activeThreadIdByTabId: { "term-1": "old-thread" },
      });
    });

    it("clamps and persists the floating drawer opacity preference", () => {
      useChatStore.getState().setDrawerFloatingOpacity(0.2);

      expect(useChatStore.getState().drawerFloatingOpacity).toBe(0.65);
      expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.layout.v1") ?? "{}"))
        .toMatchObject({ floatingOpacity: 0.65 });

      useChatStore.getState().setDrawerFloatingOpacity(1.2);

      expect(useChatStore.getState().drawerFloatingOpacity).toBe(1);
      expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.layout.v1") ?? "{}"))
        .toMatchObject({ floatingOpacity: 1 });
    });
  });

  describe("chatStore media generation", () => {
    beforeEach(() => {
      invokeMock.mockReset();
      const thread = makeThread({
        id: "image-thread",
        provider_id: "agnes",
        mode: "image",
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
        drawerScope: null,
        drawerTabId: null,
        tabDrawerOpenByTabId: {},
        activeThreadIdByTabId: {},
        drawerWidth: 380,
        drawerHeight: 420,
        drawerPosition: "right",
        drawerPinned: true,
        drawerFloatingOpacity: 1,
        pendingComposerText: "",
        composerDrafts: {},
      });
      invokeMock.mockImplementation((command: string) => {
        if (command !== "chat_generate_media") throw new Error(`unexpected command: ${command}`);
        return Promise.resolve({
          user_message: {
            id: "user-1",
            thread_id: "image-thread",
            role: "user",
            content: "a blue terminal window",
            created_at: 1,
            redacted: false,
            attachments: [],
          },
          assistant_message: {
            id: "assistant-1",
            thread_id: "image-thread",
            role: "assistant",
            content: "Generated image saved to:\n/tmp/image.png",
            created_at: 2,
            redacted: false,
            attachments: [{
              id: "media-1",
              kind: "image",
              path: "/tmp/image.png",
              name: "image.png",
              size: 123,
              mime: "image/png",
            }],
          },
          redacted_count: 0,
          saved_path: "/tmp/image.png",
          remote_url: null,
          video_id: null,
          model: "agnes-image-2.1-flash",
        });
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("routes image threads to the media generation command", async () => {
      await useChatStore.getState().sendMessage("image-thread", "a blue terminal window");

      expect(invokeMock).toHaveBeenCalledWith("chat_generate_media", {
        req: {
          thread_id: "image-thread",
          prompt: "a blue terminal window",
          kind: "image",
          attachments: [],
        },
      });
      expect(useChatStore.getState().messages["image-thread"]).toHaveLength(2);
      expect(useChatStore.getState().messages["image-thread"][1].attachments?.[0]).toMatchObject({
        kind: "image",
        path: "/tmp/image.png",
      });
      expect(useChatStore.getState().sending).toBe(false);
    });

    it("forwards Grok reference images to video generation", async () => {
      const thread = makeThread({
        id: "grok-video-thread",
        provider_id: "acp:grok",
        mode: "video",
      });
      const reference = {
        id: "reference-1",
        kind: "image" as const,
        path: "/tmp/reference.png",
        name: "reference.png",
        size: 456,
        mime: "image/png",
      };
      useChatStore.setState({
        threads: [thread],
        activeThreadId: thread.id,
        messages: { [thread.id]: [] },
      });

      await useChatStore.getState().sendMessage(
        thread.id,
        "Animate this terminal glow",
        undefined,
        [reference],
      );

      expect(invokeMock).toHaveBeenCalledWith("chat_generate_media", {
        req: {
          thread_id: "grok-video-thread",
          prompt: "Animate this terminal glow",
          kind: "video",
          attachments: [reference],
        },
      });
    });
  });

  describe("chatStore DB MCP context bridge", () => {
    beforeEach(() => {
      invokeMock.mockReset();
      vi.mocked(listen).mockResolvedValue(() => undefined);
      const thread = makeThread({
        id: "thread-db",
        provider_id: "claude-code",
        linked_session_id: "db-tab",
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
        drawerTabId: "db-tab",
        tabDrawerOpenByTabId: { "db-tab": true },
        activeThreadIdByTabId: { "db-tab": thread.id },
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
            id: "db-tab",
            type: "database",
            title: "MySQL",
            closable: true,
            sessionId: "saved-db",
          } as Tab,
        ],
        activeTabId: "db-tab",
        cwdByTab: {},
        dbConnByTab: { "db-tab": "saved-db::runtime" },
        dbSelectedObjectsByTab: {
          "db-tab": [
            {
              catalog: null,
              schema: "shop",
              name: "orders",
              kind: "table",
            },
            {
              catalog: null,
              schema: "shop",
              name: "sp_sync",
              kind: "procedure",
            },
          ],
        },
      });
      invokeMock.mockImplementation((command: string) => {
        if (command !== "chat_stream") throw new Error(`unexpected command: ${command}`);
        return Promise.resolve(null);
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("sends the live DB connection and selected objects with each turn", async () => {
      await useChatStore.getState().sendMessage("thread-db", "select 多选表前10条记录");

      expect(invokeMock).toHaveBeenCalledWith("chat_stream", {
        req: expect.objectContaining({
          thread_id: "thread-db",
          bound_session_id: "saved-db",
          bound_db_connection_id: "saved-db::runtime",
          bound_db_selected_objects: [
            {
              catalog: null,
              schema: "shop",
              name: "orders",
              kind: "table",
            },
            {
              catalog: null,
              schema: "shop",
              name: "sp_sync",
              kind: "procedure",
            },
          ],
        }),
      });
    });
  });

  describe("chatStore code workspace context bridge", () => {
    beforeEach(() => {
      invokeMock.mockReset();
      vi.mocked(listen).mockResolvedValue(() => undefined);
      const thread = makeThread({
        id: "thread-code",
        provider_id: "codex",
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
        drawerOpen: true,
        drawerScope: "tab",
        drawerTabId: "code-tab",
        tabDrawerOpenByTabId: { "code-tab": true },
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
        codeWorkspaceByTab: {
          "code-tab": {
            repoRoot: "/repo/app",
            activePath: "src/main.ts",
            openPaths: ["src/main.ts", "src/lib.ts"],
            dirtyPaths: ["src/main.ts"],
          },
        },
      });
      invokeMock.mockImplementation((command: string) => {
        if (command !== "chat_stream") throw new Error(`unexpected command: ${command}`);
        return Promise.resolve(null);
      });
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it("sends the active code workspace with each bound turn", async () => {
      await useChatStore.getState().sendMessage("thread-code", "review current edits");

      expect(invokeMock).toHaveBeenCalledWith("chat_stream", {
        req: expect.objectContaining({
          thread_id: "thread-code",
          code_workspace: {
            repoRoot: "/repo/app",
            activePath: "src/main.ts",
            openPaths: ["src/main.ts", "src/lib.ts"],
            dirtyPaths: ["src/main.ts"],
          },
        }),
      });
    });
  });
}
