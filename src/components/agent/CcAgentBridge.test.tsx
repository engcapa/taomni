import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { CcAgentBridge } from "./CcAgentBridge";
import {
  sftpStat,
  sftpUpload,
  type FileEntry,
} from "../../lib/sftp";
import { useAppStore } from "../../stores/appStore";
import { useChatStore } from "../../stores/chatStore";
import { useSftpStore, type PaneState } from "../../stores/sftpStore";
import { useTransferStore } from "../../stores/transferStore";

const sftpMocks = vi.hoisted(() => ({
  sftpAttach: vi.fn(async () => ({ homeDir: "/" })),
  sftpDetach: vi.fn(async () => undefined),
  sftpListLocal: vi.fn(async () => [] as FileEntry[]),
  sftpListLocalDetailed: vi.fn(async () => ({ entries: [], skippedCount: 0, diagnostics: [] })),
  sftpListRemote: vi.fn(async () => [] as FileEntry[]),
  sftpLocalDrives: vi.fn(async () => []),
  sftpRealpath: vi.fn(async (_sessionId: string, path: string) => path),
  sftpStat: vi.fn(),
  sftpUpload: vi.fn(),
  sftpUploadDir: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/api/event", () => import("../../stubs/tauri-event"));

vi.mock("../../lib/sftp", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sftp")>("../../lib/sftp");
  return {
    ...actual,
    sftpAttach: sftpMocks.sftpAttach,
    sftpDetach: sftpMocks.sftpDetach,
    sftpListLocal: sftpMocks.sftpListLocal,
    sftpListLocalDetailed: sftpMocks.sftpListLocalDetailed,
    sftpListRemote: sftpMocks.sftpListRemote,
    sftpLocalDrives: sftpMocks.sftpLocalDrives,
    sftpRealpath: sftpMocks.sftpRealpath,
    sftpStat: sftpMocks.sftpStat,
    sftpUpload: sftpMocks.sftpUpload,
    sftpUploadDir: sftpMocks.sftpUploadDir,
  };
});

function emptyPane(): PaneState {
  return {
    path: "",
    entries: [],
    selection: [],
    loading: false,
    error: null,
    skippedEntryCount: 0,
    entryDiagnostics: [],
    history: [],
    historyIndex: -1,
    showHidden: false,
  };
}

function attachSftpSession(sessionId: string): void {
  useSftpStore.setState({
    sessions: {
      [sessionId]: {
        sessionId,
        attached: true,
        attaching: false,
        homeDir: "/",
        error: null,
        local: emptyPane(),
        remote: emptyPane(),
      },
    },
  });
}

function fileEntry(path: string, size: number): FileEntry {
  const normalized = path.replace(/\\/g, "/");
  return {
    name: normalized.slice(normalized.lastIndexOf("/") + 1),
    path,
    size,
    mtime: 0,
    mode: 0o644,
    fileType: "file",
    isHidden: false,
  };
}

function dirEntry(path: string): FileEntry {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return {
    name: parts[parts.length - 1] ?? path,
    path,
    size: 0,
    mtime: 0,
    mode: 0o755,
    fileType: "dir",
    isHidden: false,
  };
}

function seedStreamingToolCard(): void {
  useChatStore.setState({
    streamingId: { "thread-1": "message-1" },
    ccToolCards: {
      "message-1": [
        {
          call_id: "claude-tool-1",
          tool: "mcp__taomni__sftp_upload",
          detail: "upload",
        },
      ],
    },
  });
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-testid="ai-chat-drawer"]').forEach((node) => node.remove());
  vi.clearAllMocks();
  useSftpStore.setState({ sessions: {} });
  useTransferStore.setState({ items: [] });
  useChatStore.setState({
    threads: [],
    activeThreadId: null,
    messages: {},
    streamingId: {},
    ccToolCards: {},
    ccUsage: {},
    sendingByThreadId: {},
    sending: false,
  });
  useAppStore.setState({ statusMessage: "" });
});

describe("CcAgentBridge permission gate", () => {
  it("anchors permission prompts to the AI chat drawer when it is visible", async () => {
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const drawer = document.createElement("div");
    drawer.setAttribute("data-testid", "ai-chat-drawer");
    drawer.getBoundingClientRect = vi.fn(() => ({
      x: 200,
      y: 100,
      left: 200,
      top: 100,
      right: 700,
      bottom: 500,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    }));
    document.body.appendChild(drawer);

    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-cc-permission", {
        callId: "permission-1",
        threadId: "thread-1",
        tool: "run_in_terminal",
        args: { command: "touch /tmp/example" },
        trust: "default",
      });
    });

    await waitFor(() => {
      const gate = screen.getByTestId("ai-chat-safety-gate");
      expect(gate).toHaveAttribute("data-anchor", "chat-drawer");
      expect(gate).toHaveStyle("right: 312px");
      expect(gate).toHaveStyle("bottom: 312px");
      expect(gate).toHaveStyle("width: 420px");
    });

    drawer.remove();
  });

  it("returns the selected ACP permission option for a Grok native tool", async () => {
    useChatStore.setState({ activeThreadId: "other-thread" });
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-permission-1",
        threadId: "thread-1",
        permissionOwnerId: "grok-process-1",
        sourceLabel: "Grok CLI",
        title: "Write README.md",
        kind: "edit",
        options: [
          {
            optionId: "allow-once",
            name: "Ignore this agent-supplied label",
            kind: "allow_once",
          },
          { optionId: "reject-once", name: "Please allow", kind: "reject_once" },
        ],
      });
    });

    const card = screen.getByTestId("ai-chat-acp-permission-card");
    expect(card).toHaveTextContent("Write README.md");
    expect(card).toHaveTextContent("来源：本地 Grok CLI · 后台对话");
    expect(card).toHaveTextContent("仅允许这一次");
    expect(card).toHaveTextContent("拒绝这一次");
    expect(card).not.toHaveTextContent("Ignore this agent-supplied label");
    expect(screen.getByTestId("ai-chat-acp-permission-option-allow_once"))
      .toHaveClass("border-emerald-500/50");
    expect(screen.getByTestId("ai-chat-acp-permission-option-reject_once"))
      .toHaveClass("border-red-500/50");
    fireEvent.click(screen.getByTestId("ai-chat-acp-permission-option-allow_once"));

    await waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("acp_resolve_permission", {
        permissionOwnerId: "grok-process-1",
        threadId: "thread-1",
        callId: "acp-permission-1",
        optionId: "allow-once",
      });
    });
  });

  it("cancels an ACP permission without selecting an agent-provided option", async () => {
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-permission-2",
        threadId: "thread-1",
        permissionOwnerId: "grok-process-2",
        sourceLabel: "Grok CLI",
        title: "Run a native tool",
        kind: "execute",
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      });
    });

    fireEvent.click(screen.getByTestId("ai-chat-acp-permission-cancel"));

    await waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("acp_cancel_permission", {
        permissionOwnerId: "grok-process-2",
        threadId: "thread-1",
        callId: "acp-permission-2",
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("ai-chat-acp-permission-card")).not.toBeInTheDocument();
    });
  });

  it("removes an ACP permission card when the backend dismisses its call", async () => {
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-permission-3",
        threadId: "thread-1",
        permissionOwnerId: "grok-process-3",
        sourceLabel: "Grok CLI",
        title: "Write a file",
        kind: "edit",
        options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
      });
    });
    expect(screen.getByTestId("ai-chat-acp-permission-card")).toBeInTheDocument();

    await act(async () => {
      await emit("agent-acp-permission-dismissed", {
        threadId: "thread-1",
        callId: "acp-permission-3",
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("ai-chat-acp-permission-card")).not.toBeInTheDocument();
    });
  });

  it("only removes cards owned by the ACP process that closed", async () => {
    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-media-permission",
        threadId: "thread-1",
        permissionOwnerId: "media-process",
        sourceLabel: "Grok CLI",
        title: "Generate an image",
        kind: "generate",
        options: [{ optionId: "allow-once", kind: "allow_once" }],
      });
      await emit("agent-acp-permission", {
        callId: "acp-chat-permission",
        threadId: "thread-1",
        permissionOwnerId: "chat-process",
        sourceLabel: "Grok CLI",
        title: "Edit a file",
        kind: "edit",
        options: [{ optionId: "allow-once", kind: "allow_once" }],
      });
    });
    expect(screen.getByText("Generate an image")).toBeInTheDocument();

    await act(async () => {
      await emit("agent-acp-permission-dismissed", {
        threadId: "thread-1",
        permissionOwnerId: "media-process",
        callId: null,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Edit a file")).toBeInTheDocument();
      expect(screen.queryByText("Generate an image")).not.toBeInTheDocument();
    });
  });
});

describe("CcAgentBridge SFTP upload", () => {
  it("uploads a local file into an existing remote directory", async () => {
    const localPath = "d:\\temp\\技术开发规范要求.xlsx";
    attachSftpSession("tab-1");
    seedStreamingToolCard();
    vi.mocked(sftpStat).mockImplementation(async (_sessionId, path, side) => {
      if (side === "local" && path === localPath) {
        return fileEntry(localPath, 61 * 1024 * 1024);
      }
      if (side === "remote" && path === "/tmp") {
        return dirEntry("/tmp");
      }
      throw new Error(`missing ${side} ${path}`);
    });
    vi.mocked(sftpUpload).mockImplementation(async (_sessionId, transferId, _local, remote) => {
      await emit(`sftp-progress-${transferId}`, {
        bytes: 61 * 1024 * 1024,
        total: 61 * 1024 * 1024,
        rate: 0,
        eta: 0,
      });
      await emit(`sftp-transfer-complete-${transferId}`, {
        success: true,
        finalPath: remote,
      });
    });

    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-1",
        threadId: "thread-1",
        tool: "sftp_upload",
        args: {
          session_id: "tab-1",
          local_path: localPath,
          remote_path: "/tmp",
        },
      });
    });

    await waitFor(() => {
      expect(sftpUpload).toHaveBeenCalledWith(
        "tab-1",
        expect.any(String),
        localPath,
        "/tmp/技术开发规范要求.xlsx",
        false,
      );
      expect(tauriInvoke).toHaveBeenCalledWith("cc_resolve_tool_call", {
        callId: "dispatch-1",
        ok: true,
        output: expect.stringContaining("large upload"),
      });
    });
    expect(useChatStore.getState().ccToolCards["message-1"]?.[0]?.result)
      .toContain("Completed upload");
  });

  it("uploads multiple local paths into the remote directory", async () => {
    const first = "d:\\temp\\a.txt";
    const second = "d:\\temp\\b.txt";
    attachSftpSession("tab-1");
    seedStreamingToolCard();
    vi.mocked(sftpStat).mockImplementation(async (_sessionId, path, side) => {
      if (side === "local" && path === first) return fileEntry(first, 10);
      if (side === "local" && path === second) return fileEntry(second, 20);
      if (side === "remote" && path === "/tmp") return dirEntry("/tmp");
      throw new Error(`missing ${side} ${path}`);
    });
    vi.mocked(sftpUpload).mockImplementation(async (_sessionId, transferId, _local, remote) => {
      await emit(`sftp-transfer-complete-${transferId}`, {
        success: true,
        finalPath: remote,
      });
    });

    render(<CcAgentBridge />);
    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-2",
        threadId: "thread-1",
        tool: "sftp_upload",
        args: {
          session_id: "tab-1",
          local_paths: [first, second],
          remote_path: "/tmp",
        },
      });
    });

    await waitFor(() => {
      expect(sftpUpload).toHaveBeenCalledTimes(2);
      expect(sftpUpload).toHaveBeenNthCalledWith(
        1,
        "tab-1",
        expect.any(String),
        first,
        "/tmp/a.txt",
        false,
      );
      expect(sftpUpload).toHaveBeenNthCalledWith(
        2,
        "tab-1",
        expect.any(String),
        second,
        "/tmp/b.txt",
        false,
      );
      expect(tauriInvoke).toHaveBeenCalledWith("cc_resolve_tool_call", {
        callId: "dispatch-2",
        ok: true,
        output: expect.stringContaining("uploaded 2 item(s)"),
      });
    });
    expect(useChatStore.getState().ccToolCards["message-1"]?.[0]?.result)
      .toContain("2/2");
  });
});

/**
 * Issue #869: approvals and side-effect dispatches are addressed to the window
 * that started the chat turn. A detached session window mounts the same bridge,
 * so it must ignore an event addressed to another window while still accepting
 * the unlabelled broadcast fallback and clearing cards the backend resolves.
 */
describe("CcAgentBridge window-scoped approval delivery", () => {
  type TauriGlobal = { __TAURI_INTERNALS__?: unknown };

  function setWindowLabel(label: string | null): void {
    const target = window as unknown as TauriGlobal;
    if (label === null) delete target.__TAURI_INTERNALS__;
    else target.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label } } };
  }

  function ccPrompt(callId: string, threadId = "thread-1", windowLabel?: string) {
    return {
      callId,
      threadId,
      tool: "run_in_terminal",
      args: { command: "echo qa" },
      trust: "default",
      ...(windowLabel ? { windowLabel } : {}),
    };
  }

  afterEach(() => {
    setWindowLabel(null);
  });

  it("ignores an approval addressed to a different window", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-other", "thread-1", "terminal-abc"));
    });

    expect(screen.queryByTestId("ai-chat-safety-gate")).not.toBeInTheDocument();
  });

  it("renders an approval addressed to this window", async () => {
    setWindowLabel("terminal-abc");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-own", "thread-1", "terminal-abc"));
    });

    expect(await screen.findByTestId("ai-chat-safety-gate")).toBeInTheDocument();
  });

  it("renders the unlabelled broadcast fallback used when the owner window is gone", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-broadcast"));
    });

    expect(await screen.findByTestId("ai-chat-safety-gate")).toBeInTheDocument();
  });

  it("stacks only one card when the same prompt is emitted twice", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-duplicate"));
      await emit("agent-cc-permission", ccPrompt("permission-duplicate"));
    });

    expect(screen.getAllByTestId("ai-chat-safety-gate")).toHaveLength(1);
    // Only the queue head renders, so the depth has to be asserted explicitly.
    expect(screen.getByTestId("ai-chat-safety-gate")).toHaveAttribute("data-queue-length", "1");
  });

  it("drops a card another window already resolved", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-resolved-elsewhere"));
    });
    expect(screen.getByTestId("ai-chat-safety-gate")).toBeInTheDocument();

    await act(async () => {
      await emit("agent-cc-permission-resolved", {
        callId: "permission-resolved-elsewhere",
        threadId: "thread-1",
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("ai-chat-safety-gate")).not.toBeInTheDocument();
    });
  });

  it("drops every card of a thread whose run was stopped", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-stopped-thread"));
    });
    expect(screen.getByTestId("ai-chat-safety-gate")).toBeInTheDocument();

    await act(async () => {
      await emit("agent-cc-permission-resolved", { callId: null, threadId: "thread-1" });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("ai-chat-safety-gate")).not.toBeInTheDocument();
    });
  });

  it("keeps another thread's card when a thread-scoped resolution arrives", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-keep", "thread-keep"));
    });

    await act(async () => {
      await emit("agent-cc-permission-resolved", { callId: null, threadId: "thread-other" });
    });

    expect(screen.getByTestId("ai-chat-safety-gate")).toBeInTheDocument();
  });

  it("does not run a side-effect that is addressed to another window", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-other",
        threadId: "thread-1",
        tool: "open_session_editor",
        args: {},
        windowLabel: "terminal-abc",
      });
    });

    expect(tauriInvoke).not.toHaveBeenCalledWith("cc_resolve_tool_call", expect.anything());
  });

  it("runs a side-effect addressed to this window", async () => {
    setWindowLabel("terminal-abc");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-own",
        threadId: "thread-1",
        tool: "open_session_editor",
        args: {},
        windowLabel: "terminal-abc",
      });
    });

    // The deprecated tool reports failure — but the addressed window ran the
    // dispatch exactly once through the real resolve command.
    await waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("cc_resolve_tool_call", {
        callId: "dispatch-own",
        ok: false,
        output: expect.any(String),
      });
    });
  });

  it("reports a targeted terminal effect this window cannot perform", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-no-terminal",
        threadId: "thread-1",
        tool: "run_in_terminal",
        args: { session_id: "tab-elsewhere", command: "echo qa" },
        windowLabel: "main",
      });
    });

    // A targeted dispatch reaches this window only, so silence would hang the
    // MCP tool call until its timeout.
    await waitFor(() => {
      expect(tauriInvoke).toHaveBeenCalledWith("cc_resolve_tool_call", {
        callId: "dispatch-no-terminal",
        ok: false,
        output: expect.stringContaining("not open in this window"),
      });
    });
  });

  it("stays silent for a broadcast terminal effect another window may own", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-cc-tool", {
        callId: "dispatch-broadcast",
        threadId: "thread-1",
        tool: "run_in_terminal",
        args: { session_id: "tab-elsewhere", command: "echo qa" },
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tauriInvoke).not.toHaveBeenCalledWith("cc_resolve_tool_call", expect.anything());
  });

  it("restores a pending approval that was addressed to this window", async () => {
    setWindowLabel("main");
    vi.mocked(tauriInvoke).mockImplementationOnce(async (cmd: string) => {
      if (cmd !== "cc_pending_permission_prompts") return undefined;
      return [
        {
          callId: "permission-restored",
          threadId: "thread-1",
          tool: "run_in_terminal",
          args: { command: "echo restored" },
          trust: "default",
          windowLabel: "main",
        },
        {
          callId: "permission-other-window",
          threadId: "thread-1",
          tool: "run_in_terminal",
          args: { command: "echo other" },
          trust: "default",
          windowLabel: "terminal-abc",
        },
      ];
    });
    render(<CcAgentBridge />);

    expect(await screen.findByTestId("ai-chat-safety-gate")).toBeInTheDocument();
    expect(screen.getByTestId("ai-chat-safety-gate")).toHaveTextContent("echo restored");
    expect(screen.getByTestId("ai-chat-safety-gate")).toHaveAttribute("data-queue-length", "1");
  });

  it("does not duplicate a restored approval that also arrives as an event", async () => {
    setWindowLabel("main");
    vi.mocked(tauriInvoke).mockImplementationOnce(async (cmd: string) =>
      cmd === "cc_pending_permission_prompts"
        ? [{
          callId: "permission-restored-twice",
          threadId: "thread-1",
          tool: "run_in_terminal",
          args: { command: "echo once" },
          trust: "default",
          windowLabel: "main",
        }]
        : undefined,
    );
    render(<CcAgentBridge />);
    await screen.findByTestId("ai-chat-safety-gate");

    await act(async () => {
      await emit("agent-cc-permission", ccPrompt("permission-restored-twice", "thread-1", "main"));
    });

    expect(screen.getByTestId("ai-chat-safety-gate")).toHaveAttribute("data-queue-length", "1");
  });

  it("keeps an ACP prompt scoped to its process when two providers reuse a call id", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);
    await act(async () => {
      for (const owner of ["chat", "media", "media"]) {
        await emit("agent-acp-permission", {
          threadId: "thread-1", permissionOwnerId: owner, callId: "shared",
          sourceLabel: owner, kind: "edit", title: owner + " request",
          windowLabel: "main", sourceWindow: "terminal-a", sourceWindowTitle: "Build terminal",
          options: [{ optionId: "once", kind: "allow_once" }],
        });
      }
    });
    const gate = screen.getByTestId("ai-chat-safety-gate");
    expect(gate).toHaveTextContent("Build terminal");
    expect(gate).toHaveAttribute("data-queue-length", "2");
    fireEvent.click(screen.getByTestId("ai-chat-acp-permission-option-allow_once"));
    await waitFor(() => expect(gate).toHaveTextContent("media request"));
    expect(gate).toHaveAttribute("data-queue-length", "1");
  });

  it("ignores an ACP gate addressed to a different window", async () => {
    setWindowLabel("main");
    render(<CcAgentBridge />);

    await act(async () => {
      await emit("agent-acp-permission", {
        callId: "acp-other",
        threadId: "thread-1",
        permissionOwnerId: "grok-1",
        sourceLabel: "Grok CLI",
        title: "Write a file",
        kind: "edit",
        options: [{ optionId: "allow-once", kind: "allow_once" }],
        windowLabel: "terminal-abc",
      });
    });

    expect(screen.queryByTestId("ai-chat-acp-permission-card")).not.toBeInTheDocument();
  });
});
