import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiStore } from "../../../../stores/aiStore";
import { useAppStore } from "../../../../stores/appStore";
import { useChatStore, type ChatThread } from "../../../../stores/chatStore";
import { useNotesStore } from "../../../../stores/notesStore";
import { useOpencodeGoStore } from "../../../../stores/opencodeGoStore";
import { useTaoHubStore } from "../../../../stores/taoHubStore";
import { GO_STUB_CATALOG } from "../../../../stubs/opencodeGoStub";
import { ChatDrawer } from "../../ChatDrawer";
import { invokeMock, makeConfig, resetTaoAlertStore } from "./harness";

export function registerChatDrawerBehavior1Cases() {

  describe("ChatDrawer provider and echo controls", () => {
    beforeEach(() => {
      Element.prototype.scrollIntoView = vi.fn();
      window.localStorage.clear();
      invokeMock.mockReset();
      invokeMock.mockImplementation((command: string) => {
        if (command === "chat_list_threads") return Promise.resolve([]);
        if (command === "chat_purge_old") return Promise.resolve(0);
        if (command === "get_ai_config") return Promise.resolve(makeConfig());
        if (command === "save_ai_config") return Promise.resolve(null);
        if (command === "notes_list") return Promise.resolve([]);
        if (command === "notes_get_prefs") return Promise.resolve({});
        if (command === "notes_list_alerts") return Promise.resolve([]);
        if (command === "notes_list_tags") return Promise.resolve([]);
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
        drawerPosition: "right",
        drawerPinned: true,
        drawerFloatingOpacity: 1,
        pendingComposerText: "",
        composerDrafts: {},
      });
    });

    it("shows the Go selector only on Go threads, pins model through IPC and preserves other threads", async () => {
      const config = makeConfig();
      config.llm.providers["opencode-go"] = { base_url: "https://example.invalid/v1", api_key: "", model: "deepseek-v4.1-flash", runtime: "opencode-go" };
      useAiStore.setState({ config });
      const a = { ...useChatStore.getState().threads[0], provider_id: "opencode-go" };
      const b = { ...a, id: "thread-2", provider_id: "deepseek" };
      invokeMock.mockImplementation((command: string) => {
        if (command === "chat_list_threads") return Promise.resolve([a, b]);
        if (command === "get_ai_config") return Promise.resolve(config);
        if (command === "chat_purge_old") return Promise.resolve(0);
        return Promise.resolve(null);
      });
      useChatStore.setState({ threads: [a, b] });
      useOpencodeGoStore.setState({ ...GO_STUB_CATALOG, loading: false, loaded: true, ensureLoaded: vi.fn().mockResolvedValue(undefined) });
      render(<ChatDrawer />);
      expect(screen.getByTestId("go-thread-picker")).toBeTruthy();
      fireEvent.change(screen.getByTestId("go-thread-model-select"), { target: { value: "kimi-k3" } });
      await waitFor(() => expect(useChatStore.getState().threads[0].llm_model).toBe("kimi-k3"));
      expect(invokeMock).toHaveBeenCalledWith("chat_set_thread_llm_model", { threadId: a.id, model: "kimi-k3" });
      expect(useChatStore.getState().threads[1].llm_model).toBeUndefined();
      act(() => useChatStore.setState({ activeThreadId: "thread-2" }));
      expect(screen.queryByTestId("go-thread-picker")).toBeNull();
    });

    afterEach(() => {
      cleanup();
      window.localStorage.clear();
      vi.clearAllMocks();
      useTaoHubStore.setState({ hubTab: "chat" });
      resetTaoAlertStore();
      useNotesStore.setState({ alerts: [] });
    });

    it("puts the active LLM provider before local agents", () => {
      render(<ChatDrawer />);

      const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
      expect(Array.from(provider.options).map((option) => option.value)).toEqual([
        "deepseek",
        "local",
        "claude-code",
      ]);
    });

    it("includes provider groups in the manual provider picker", () => {
      const config = makeConfig();
      config.llm.provider_groups = {
        balanced: {
          label: "Balanced",
          provider_ids: ["deepseek", "local"],
          enabled: true,
        },
      };
      useAiStore.setState({ config });

      render(<ChatDrawer />);

      const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
      expect(Array.from(provider.options).map((option) => option.value)).toEqual([
        "deepseek",
        "local",
        "group:balanced",
        "claude-code",
      ]);
      expect(Array.from(provider.options).map((option) => option.textContent)).toContain("Group: Balanced");
    });

    it("lists enabled ACP profiles by display name without adding an xAI provider", () => {
      const config = makeConfig();
      config.acp_bridge.enabled = true;
      config.acp_bridge.profiles[0].enabled = true;
      useAiStore.setState({ config });

      render(<ChatDrawer />);

      const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
      expect(Array.from(provider.options).map((option) => option.value)).toContain("acp:grok");
      expect(Array.from(provider.options).map((option) => option.textContent)).toContain("Grok CLI (ACP)");
      expect(config.llm.providers).not.toHaveProperty("grok");
      expect(config.llm.providers).not.toHaveProperty("xai");
    });

    it("migrates bridge-only ACP enablement into a visible preferred profile", async () => {
      const config = makeConfig();
      config.acp_bridge.enabled = true;
      config.acp_bridge.profiles[0].enabled = false;
      invokeMock.mockImplementation((command: string) => {
        if (command === "get_ai_config") return Promise.resolve(config);
        if (command === "chat_list_threads") return Promise.resolve([]);
        if (command === "chat_purge_old") return Promise.resolve(0);
        return Promise.resolve(null);
      });

      await act(async () => {
        await useAiStore.getState().loadConfig();
      });
      render(<ChatDrawer />);

      const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
      expect(Array.from(provider.options).map((option) => option.value)).toContain("acp:grok");
      expect(useAiStore.getState().config?.acp_bridge.profiles[0].enabled).toBe(true);
    });

    it("remembers provider changes from the thread picker", () => {
      render(<ChatDrawer />);

      const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
      fireEvent.change(provider, { target: { value: "deepseek" } });

      expect(JSON.parse(window.localStorage.getItem("taomni.chatDrawer.provider.v1") ?? "{}")).toMatchObject({
        chat: "deepseek",
      });
      expect(invokeMock).toHaveBeenCalledWith("chat_set_thread_provider", {
        threadId: "thread-1",
        providerId: "deepseek",
      });
    });

    it("renders terminal echo as the same compact button style as echo toggles", () => {
      render(<ChatDrawer />);

      const echo = screen.getByTestId("chat-cc-terminal-echo-toggle");
      expect(echo).toHaveClass("taomni-btn");
      expect(echo).toHaveAttribute("aria-pressed", "true");
      expect(echo).toHaveTextContent("Terminal echo: on");
    });

    it("offers Grok CLI and its reference-image attachment control in media modes", () => {
      const config = makeConfig();
      config.llm.providers.agnes = {
        base_url: "https://apihub.agnes-ai.com/v1",
        api_key: "",
        model: "agnes-2.0-flash",
        runtime: "openai-compat",
        capabilities: { chat: true, image_generation: true, video_generation: true },
        image_model: "agnes-image-2.1-flash",
        video_model: "agnes-video-v2.0",
      };
      config.acp_bridge.enabled = true;
      config.acp_bridge.profiles[0].enabled = true;
      invokeMock.mockImplementation((command: string) => {
        if (command === "chat_list_threads") return Promise.resolve([]);
        if (command === "chat_purge_old") return Promise.resolve(0);
        if (command === "get_ai_config") return Promise.resolve(config);
        if (command === "save_ai_config") return Promise.resolve(null);
        return Promise.resolve(null);
      });
      const imageThread: ChatThread = {
        ...useChatStore.getState().threads[0],
        provider_id: "acp:grok",
        mode: "image",
      };
      useAiStore.setState({ config });
      useChatStore.setState({
        threads: [imageThread],
        activeThreadId: imageThread.id,
        messages: { [imageThread.id]: [] },
      });

      render(<ChatDrawer />);

      const provider = screen.getByLabelText("Thread LLM provider") as HTMLSelectElement;
      expect(Array.from(provider.options).map((option) => option.value)).toEqual(["agnes", "acp:grok"]);
      expect(screen.getByTestId("chat-mode-image")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("ai-chat-attach-button")).toBeVisible();
    });
  });
}
