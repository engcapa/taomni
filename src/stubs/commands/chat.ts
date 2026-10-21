import { type InvokeArgs } from "./runtime";
import { basename, mimeFromName } from "./files";

export const CHAT_THREADS_STORAGE_KEY = "taomni.stub.chatThreads.v1";

export const CHAT_MESSAGES_STORAGE_KEY = "taomni.stub.chatMessages.v1";

export interface StubChatThread {
  id: string;
  title: string;
  provider_id: string;
  created_at: number;
  updated_at: number;
  linked_session_id: string | null;
  source: string;
  mode?: string | null;
  output_format?: string | null;
  cc_model?: string | null;
}

export interface StubChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  redacted: boolean;
  attachments?: StubChatAttachment[];
}

export interface StubChatAttachment {
  id: string;
  kind: "image" | "file" | "video";
  path: string;
  name: string;
  size: number;
  mime?: string | null;
  preview_url?: string | null;
}

export function loadChatThreads(): StubChatThread[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_THREADS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.map((thread) => ({
          ...thread,
          mode: thread?.mode === "image" || thread?.mode === "video" ? thread.mode : "chat",
        }))
      : [];
  } catch {
    return [];
  }
}

export function saveChatThreads(threads: StubChatThread[]): void {
  localStorage.setItem(CHAT_THREADS_STORAGE_KEY, JSON.stringify(threads));
}

export function loadChatMessages(): Record<string, StubChatMessage[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_MESSAGES_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveChatMessages(messages: Record<string, StubChatMessage[]>): void {
  localStorage.setItem(CHAT_MESSAGES_STORAGE_KEY, JSON.stringify(messages));
}

export function normalizeStubChatMode(mode: unknown): "chat" | "image" | "video" {
  return mode === "image" || mode === "video" ? mode : "chat";
}

export function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function stubGeneratedImageDataUri(prompt: string): string {
  const label = escapeSvgText((prompt || "Generated image").slice(0, 48));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768" viewBox="0 0 1024 768"><rect width="1024" height="768" fill="#111827"/><rect x="72" y="72" width="880" height="624" rx="32" fill="#1f2937"/><circle cx="512" cy="306" r="156" fill="#38bdf8"/><path d="M336 594h352l-112-142-82 92-54-62z" fill="#a7f3d0"/><text x="512" y="658" fill="#f8fafc" font-size="38" font-family="Arial, sans-serif" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export async function invokeChat<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    // ---------- AI chat drawer commands (browser preview stubs) ----------
    case "chat_list_threads": {
      const limit = Number((args as InvokeArgs | undefined)?.limit ?? 50);
      return loadChatThreads()
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, Number.isFinite(limit) ? limit : 50) as T;
    }

    case "chat_new_thread": {
      const now = Math.floor(Date.now() / 1000);
      const mode = normalizeStubChatMode((args as InvokeArgs | undefined)?.mode);
      const thread: StubChatThread = {
        id: `stub-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: "New chat",
        provider_id: ((args as InvokeArgs | undefined)?.providerId as string | null | undefined) ?? "deepseek",
        created_at: now,
        updated_at: now,
        linked_session_id: ((args as InvokeArgs | undefined)?.linkedSessionId as string | null | undefined) ?? null,
        source: "drawer",
        mode,
        output_format: null,
        cc_model: null,
      };
      saveChatThreads([thread, ...loadChatThreads()]);
      return thread as T;
    }

    case "chat_list_messages": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const messages = loadChatMessages();
      return (threadId ? messages[threadId] ?? [] : []) as T;
    }

    case "chat_set_thread_provider": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const providerId = (args as InvokeArgs | undefined)?.providerId as string | undefined;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId && providerId ? { ...thread, provider_id: providerId } : thread,
      ));
      return undefined as T;
    }

    case "chat_set_thread_llm_model": {
      const threadId = args?.threadId as string | undefined;
      const model = (args?.model as string | null | undefined) ?? null;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, llm_model: model } : thread,
      ));
      return undefined as T;
    }

    case "chat_set_thread_cc_model": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const model = ((args as InvokeArgs | undefined)?.model as string | null | undefined) ?? null;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, cc_model: model } : thread,
      ));
      return undefined as T;
    }

    case "chat_set_thread_output_format": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const outputFormat = ((args as InvokeArgs | undefined)?.outputFormat as string | null | undefined) ?? null;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, output_format: outputFormat } : thread,
      ));
      return undefined as T;
    }

    case "chat_delete_thread": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      saveChatThreads(loadChatThreads().filter((thread) => thread.id !== threadId));
      const messages = loadChatMessages();
      if (threadId) delete messages[threadId];
      saveChatMessages(messages);
      return undefined as T;
    }

    case "chat_purge_old": {
      return 0 as T;
    }

    case "chat_stop_stream": {
      return undefined as T;
    }

    case "acp_probe_profile": {
      const profileId = (args as InvokeArgs | undefined)?.profileId as string | undefined;
      return {
        profileId: profileId ?? "unknown",
        ok: false,
        message: "ACP handshake probing is only available in the desktop build.",
        agent: null,
      } as T;
    }

    case "chat_stat_attachment_paths": {
      const paths = ((args as InvokeArgs | undefined)?.paths as string[] | undefined) ?? [];
      return paths.map((path, index) => {
        const name = basename(path);
        const mime = mimeFromName(name);
        const kind = mime.startsWith("image/")
          ? "image"
          : mime.startsWith("video/")
            ? "video"
            : "file";
        return {
          id: `stub-att-${Date.now()}-${index}`,
          kind,
          path,
          name,
          size: 0,
          mime,
        } satisfies StubChatAttachment;
      }) as T;
    }

    case "chat_read_clipboard_image_attachment": {
      return ({
        id: `stub-clipboard-image-${Date.now()}`,
        kind: "image",
        path: `clipboard://pasted-image-${Date.now()}.png`,
        name: "Pasted image",
        size: 0,
        mime: "image/png",
        preview_url: stubGeneratedImageDataUri("pasted clipboard image"),
      } satisfies StubChatAttachment) as T;
    }

    case "chat_send": {
      const req = (args as InvokeArgs | undefined)?.req as { thread_id?: string; content?: string; attachments?: StubChatAttachment[] } | undefined;
      const threadId = req?.thread_id ?? "";
      const now = Math.floor(Date.now() / 1000);
      const userMessage: StubChatMessage = {
        id: `stub-user-${Date.now()}`,
        thread_id: threadId,
        role: "user",
        content: req?.content ?? "",
        created_at: now,
        redacted: false,
        attachments: req?.attachments ?? [],
      };
      const assistantMessage: StubChatMessage = {
        id: `stub-assistant-${Date.now()}`,
        thread_id: threadId,
        role: "assistant",
        content: "Browser preview stub: connect a desktop AI provider to get a real response.",
        created_at: now,
        redacted: false,
      };
      const messages = loadChatMessages();
      messages[threadId] = [...(messages[threadId] ?? []), userMessage, assistantMessage];
      saveChatMessages(messages);
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, updated_at: now } : thread,
      ));
      return { user_message: userMessage, assistant_message: assistantMessage } as T;
    }

    case "chat_generate_media": {
      const req = (args as InvokeArgs | undefined)?.req as { thread_id?: string; prompt?: string; kind?: string } | undefined;
      const threadId = req?.thread_id ?? "";
      const kind = req?.kind === "video" ? "video" : "image";
      const now = Math.floor(Date.now() / 1000);
      const prompt = req?.prompt ?? "";
      const ext = kind === "video" ? "mp4" : "png";
      const mime = kind === "video" ? "video/mp4" : "image/svg+xml";
      const model = kind === "video" ? "agnes-video-v2.0" : "agnes-image-2.1-flash";
      const savedPath = `/browser-preview/ai-generations/${kind}-${Date.now()}.${ext}`;
      const attachmentPath = kind === "image" ? stubGeneratedImageDataUri(prompt) : savedPath;
      const userMessage: StubChatMessage = {
        id: `stub-user-${Date.now()}`,
        thread_id: threadId,
        role: "user",
        content: prompt,
        created_at: now,
        redacted: false,
        attachments: [],
      };
      const assistantMessage: StubChatMessage = {
        id: `stub-assistant-${Date.now()}`,
        thread_id: threadId,
        role: "assistant",
        content: `${kind === "video" ? "Generated video" : "Generated image"} saved to:\n${savedPath}`,
        created_at: now + 1,
        redacted: false,
        attachments: [{
          id: `stub-media-${Date.now()}`,
          kind,
          path: attachmentPath,
          name: `generated-${kind}.${ext}`,
          size: kind === "video" ? 0 : attachmentPath.length,
          mime,
          preview_url: kind === "image" ? attachmentPath : null,
        }],
      };
      const messages = loadChatMessages();
      const hadMessages = (messages[threadId] ?? []).length > 0;
      messages[threadId] = [...(messages[threadId] ?? []), userMessage, assistantMessage];
      saveChatMessages(messages);
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              updated_at: now,
              title: hadMessages ? thread.title : prompt.slice(0, 40) || thread.title,
              mode: kind,
            }
          : thread,
      ));
      return {
        user_message: userMessage,
        assistant_message: assistantMessage,
        redacted_count: 0,
        saved_path: savedPath,
        remote_url: null,
        video_id: kind === "video" ? `stub-video-${Date.now()}` : null,
        model,
      } as T;
    }
    default: throw new Error(`Unhandled chat stub command: ${cmd}`);
  }
}
