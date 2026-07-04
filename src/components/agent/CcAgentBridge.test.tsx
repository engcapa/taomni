import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
