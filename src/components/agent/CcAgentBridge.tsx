import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ActionCard, type ActionCardDecision } from "./ActionCard";
import { getTerminal } from "../../lib/terminal/terminalRegistry";
import { formatCcTerminalEcho, type CcTerminalEcho } from "../../lib/terminal/ccEcho";
import { buildInteractiveCommandInput } from "../../lib/terminal/commandInput";
import { getQueryTab } from "../../lib/queryRegistry";
import {
  basename,
  joinPath,
  listenSftpComplete,
  listenSftpPaused,
  listenSftpProgress,
  sftpDownload,
  sftpDownloadDir,
  sftpStat,
  type FileEntry,
  type TransferCompletePayload,
} from "../../lib/sftp";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { useAiStore } from "../../stores/aiStore";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSftpStore } from "../../stores/sftpStore";
import { newTransferId, useTransferStore } from "../../stores/transferStore";
/**
 * Bridges the in-app Claude Code MCP server's human-in-the-loop events to the UI.
 *
 * - `agent-cc-permission`: CC asked to run a write/side-effect tool. We surface
 *   an ActionCard; the user's choice is sent back via `cc_resolve_permission`,
 *   unblocking the server's `permission_prompt` handler.
 * - `agent-cc-tool`: an approved Taomni side-effect tool needs the frontend to
 *   perform the effect (e.g. write a command into the linked SSH terminal). The
 *   outcome is returned via `cc_resolve_tool_call`.
 *
 * Mounted once at the app shell. Events only fire when a CC thread actually
 * drives a tool, so this is inert otherwise.
 */

interface PermissionPrompt {
  callId: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
  trust: string;
}

interface ToolDispatch {
  callId: string;
  threadId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** Live progress of an in-flight `run_captured` run (方案4). */
interface CaptureProgress {
  captureId: string;
  threadId: string;
  lines: number;
  bytes: number;
}

/**
 * A statement CC just ran on a bound DB connection (`agent-cc-sql-echo`). When
 * SQL echo is enabled, the linked query tab appends it to a query editor.
 */
interface SqlEcho {
  threadId: string;
  sql: string;
  ok: boolean;
  rowsAffected: number;
  rowCount: number;
  durationMs: number;
  captured: boolean;
  error?: string | null;
}

/** Zero-padded HH:MM:SS for the echoed comment. */
function clockHms(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Build the SQL comment line prepended above an echoed statement. */
function buildEchoNote(e: SqlEcho): string {
  const parts = [`Claude Code ${clockHms(new Date())}`];
  if (e.ok) {
    parts.push(e.captured ? "captured" : "ok");
    parts.push(`${e.rowCount} rows`);
    if (e.rowsAffected > 0) parts.push(`${e.rowsAffected} affected`);
    parts.push(`${e.durationMs}ms`);
  } else {
    parts.push(`error: ${(e.error ?? "failed").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return `-- ⟦${parts.join(" · ")}⟧`;
}

/** Human-readable byte size for the capture progress card. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short human description of what a tool call will do, for the ActionCard. */
function describe(tool: string, rawArgs: Record<string, unknown> | null | undefined): string {
  const args = rawArgs ?? {};
  switch (tool) {
    case "run_in_terminal":
    case "Bash":
      return `在终端执行命令: ${String(args.command ?? "")}`;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `修改文件: ${String(args.file_path ?? args.notebook_path ?? "")}`;
    case "sftp_upload":
      return `上传文件到 ${String(args.remote_path ?? "")}`;
    case "sftp_download":
      return `下载远端文件到 ${String(args.local_dir ?? "")}`;
    case "save_as_runbook":
      return `保存 Runbook: ${String(args.name ?? "")}`;
    case "run_sql":
    case "run_sql_captured":
      return `执行 SQL: ${String(args.sql ?? "")}`;
    case "export_result":
      return `导出查询结果 (${String(args.format ?? "csv")})`;
    case "redis_set_key":
      return `写入 Redis 键: ${String(args.key ?? "")}`;
    case "redis_del_key":
      return `删除 Redis 键: ${String(args.key ?? "")}`;
    case "redis_exec":
      return `执行 Redis 命令: ${String(args.command ?? "")}`;
    default:
      return `Claude Code 请求执行工具 "${tool}"`;
  }
}

/** The most useful preview string for a tool call (command / path / sql), if any. */
function preview(rawArgs: Record<string, unknown> | null | undefined): string | null {
  const args = rawArgs ?? {};
  if (typeof args.command === "string") return args.command;
  if (typeof args.sql === "string") return args.sql;
  if (typeof args.file_path === "string") return args.file_path;
  if (typeof args.remote_path === "string") return args.remote_path;
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sftpSessionCandidates(sessionId: string): string[] {
  if (!sessionId) return [];
  const candidates = [sessionId];
  if (!sessionId.startsWith("attached-")) {
    candidates.push(`attached-${sessionId}`);
  }
  return candidates;
}

async function ensureSftpSession(rawSessionId: string): Promise<string> {
  const sftpStore = useSftpStore.getState();
  for (const id of sftpSessionCandidates(rawSessionId)) {
    if (sftpStore.sessions[id]?.attached) return id;
  }

  const appState = useAppStore.getState();
  const tabId = rawSessionId.startsWith("attached-")
    ? rawSessionId.slice("attached-".length)
    : rawSessionId;
  const tab = appState.tabs.find((t) =>
    t.id === tabId ||
    t.sftp?.sessionId === rawSessionId ||
    t.sftp?.sessionId === `attached-${tabId}`
  );

  if (tab?.sftp) {
    await sftpStore.attach({
      sessionId: tab.sftp.sessionId,
      host: tab.sftp.host,
      port: tab.sftp.port,
      username: tab.sftp.username,
      authMethod: tab.sftp.authMethod,
      authData: tab.sftp.authData,
      networkSettingsJson: tab.sftp.networkSettingsJson ?? null,
    });
    return tab.sftp.sessionId;
  }

  if (tab?.ssh) {
    const sessionId = `attached-${tab.id}`;
    await sftpStore.attach({
      sessionId,
      host: tab.ssh.host,
      port: tab.ssh.port,
      username: tab.ssh.username,
      authMethod: tab.ssh.authMethod,
      authData: tab.ssh.authData,
      networkSettingsJson: JSON.stringify(
        toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh.optionsJson)),
      ),
    });
    return sessionId;
  }

  throw new Error(`SFTP session is not attached for ${rawSessionId}`);
}

function isDirectory(entry: FileEntry): boolean {
  return entry.fileType === "dir" || entry.targetFileType === "dir";
}

function splitNameForSuffix(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name || "download", ext: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name || "download", ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

async function localPathExists(sessionId: string, path: string): Promise<boolean> {
  try {
    await sftpStat(sessionId, path, "local");
    return true;
  } catch {
    return false;
  }
}

async function uniqueLocalPath(
  sessionId: string,
  localDir: string,
  name: string,
  isDir: boolean,
): Promise<string> {
  const first = joinPath(localDir, name || "download");
  if (!(await localPathExists(sessionId, first))) return first;

  const { stem, ext } = splitNameForSuffix(name, isDir);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = joinPath(localDir, `${stem} (${i})${ext}`);
    if (!(await localPathExists(sessionId, candidate))) return candidate;
  }
  throw new Error(`Could not find a free local filename in ${localDir}`);
}

function showSftpDownloadNotification(finalPath: string): void {
  const title = "SFTP download complete";
  const body = finalPath;
  useAppStore.getState().setStatusMessage(`${title}: ${body}`);
  void import("@tauri-apps/plugin-notification")
    .then(async (mod) => {
      if (await mod.isPermissionGranted()) {
        mod.sendNotification({ title, body });
      }
    })
    .catch(() => {
      /* best-effort only */
    });
}

async function runTrackedSftpDownload(opts: {
  sessionId: string;
  transferId: string;
  remotePath: string;
  localPath: string;
  isDir: boolean;
}): Promise<TransferCompletePayload | null> {
  const transferStore = useTransferStore.getState();
  let completePayload: TransferCompletePayload | null = null;
  let unlistenProgress: (() => void) | null = null;
  let unlistenPaused: (() => void) | null = null;
  let unlistenComplete: (() => void) | null = null;
  let resolveComplete: (payload: TransferCompletePayload) => void = () => {};
  const completePromise = new Promise<TransferCompletePayload>((resolve) => {
    resolveComplete = resolve;
  });

  try {
    const [progress, paused, complete] = await Promise.all([
      listenSftpProgress(opts.transferId, (payload) => {
        transferStore.patch(opts.transferId, {
          bytes: payload.bytes,
          size: payload.total || undefined,
          rate: payload.rate,
          eta: payload.eta,
          state: "running",
        });
      }),
      listenSftpPaused(opts.transferId, (payload) => {
        transferStore.patch(opts.transferId, {
          bytes: payload.bytes,
          rate: 0,
          eta: 0,
          state: "paused",
        });
      }),
      listenSftpComplete(opts.transferId, (payload) => {
        completePayload = payload;
        if (payload.success) {
          transferStore.setState(opts.transferId, "done");
        } else {
          transferStore.setState(opts.transferId, "error", payload.error ?? "download failed");
        }
        resolveComplete(payload);
      }),
    ]);
    unlistenProgress = progress;
    unlistenPaused = paused;
    unlistenComplete = complete;

    if (opts.isDir) {
      await sftpDownloadDir(opts.sessionId, opts.transferId, opts.remotePath, opts.localPath);
    } else {
      await sftpDownload(opts.sessionId, opts.transferId, opts.remotePath, opts.localPath, false);
    }

    return completePayload ?? await Promise.race([
      completePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
  } finally {
    unlistenProgress?.();
    unlistenPaused?.();
    unlistenComplete?.();
  }
}

async function executeSftpDownloadTool(args: Record<string, unknown>): Promise<string> {
  const rawSessionId = asString(args.session_id);
  const remotePath = asString(args.remote_path);
  const localDir = asString(args.local_dir ?? args.local_path ?? args.target_dir);
  if (!rawSessionId) throw new Error("sftp_download requires session_id");
  if (!remotePath) throw new Error("sftp_download requires remote_path");
  if (!localDir) throw new Error("sftp_download requires local_dir");

  const sessionId = await ensureSftpSession(rawSessionId);
  const localDirEntry = await sftpStat(sessionId, localDir, "local")
    .catch((err) => {
      throw new Error(`Local download directory does not exist: ${localDir} (${err})`);
    });
  if (!isDirectory(localDirEntry)) {
    throw new Error(`Local download target is not a directory: ${localDir}`);
  }

  const remoteEntry = await sftpStat(sessionId, remotePath, "remote");
  const isDir = isDirectory(remoteEntry);
  const localName = remoteEntry.name || basename(remotePath) || "download";
  const localPath = await uniqueLocalPath(sessionId, localDir, localName, isDir);
  const transferId = newTransferId();

  useTransferStore.getState().add({
    id: transferId,
    sessionId,
    direction: "download",
    kind: isDir ? "dir" : "file",
    localPath,
    remotePath,
    size: isDir ? 0 : remoteEntry.size,
    bytes: 0,
    rate: 0,
    eta: 0,
    state: "queued",
    startedAt: Date.now(),
    openAfter: false,
  });

  try {
    const payload = await runTrackedSftpDownload({
      sessionId,
      transferId,
      remotePath,
      localPath,
      isDir,
    });
    if (payload && !payload.success) {
      throw new Error(payload.error ?? "download failed");
    }
    const finalPath = payload?.finalPath || localPath;
    void useSftpStore.getState().refreshPane(sessionId, "local").catch(() => undefined);
    showSftpDownloadNotification(finalPath);
    return `downloaded ${remotePath} -> ${finalPath}`;
  } catch (err) {
    useTransferStore.getState().setState(
      transferId,
      "error",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

export function CcAgentBridge() {
  const [queue, setQueue] = useState<PermissionPrompt[]>([]);
  const [deciding, setDeciding] = useState(false);
  const [captures, setCaptures] = useState<CaptureProgress[]>([]);

  // --- permission prompts (HITL) ---------------------------------------
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<PermissionPrompt>("agent-cc-permission", (event) => {
      // Dedupe by callId: a stray double-emit must not stack two cards.
      setQueue((q) =>
        q.some((p) => p.callId === event.payload.callId) ? q : [...q, event.payload],
      );
    }).then((fn) => {
      // `listen` resolves async. If the effect was already torn down (React
      // StrictMode double-mount in dev), unregister immediately instead of
      // leaking this listener — a leak would fire every handler twice.
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => {
      // `listen` can reject outside Tauri (e.g. jsdom tests); ignore — the
      // bridge is simply inert there.
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen("taomni-sessions-changed", () => {
      void useSessionStore.getState().loadSessions();
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const decide = useCallback(
    async (prompt: PermissionPrompt, decision: ActionCardDecision) => {
      setDeciding(true);
      try {
        // ActionCardDecision values ("allow" | "allow-session" | "deny") map
        // 1:1 onto the backend CcPermissionDecision (kebab-case) enum.
        await invoke("cc_resolve_permission", {
          callId: prompt.callId,
          decision,
        });
      } catch (e) {
        console.error("cc_resolve_permission failed:", e);
      } finally {
        setQueue((q) => q.filter((p) => p.callId !== prompt.callId));
        setDeciding(false);
      }
    },
    [],
  );

  // --- side-effect tool dispatch ---------------------------------------
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<ToolDispatch>("agent-cc-tool", (event) => {
      void executeTool(event.payload);
    }).then((fn) => {
      // See the permission listener above: avoid leaking a duplicate listener,
      // which here would write the command into the terminal twice.
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => {
      // `listen` can reject outside Tauri (e.g. jsdom tests); ignore — the
      // bridge is simply inert there.
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const head = queue[0] ?? null;

  // --- captured-run progress (方案4) -----------------------------------
  useEffect(() => {
    let unlistenProgress: UnlistenFn | null = null;
    let unlistenEnd: UnlistenFn | null = null;
    let disposed = false;
    void listen<CaptureProgress>("agent-cc-capture-progress", (event) => {
      setCaptures((cs) => {
        const i = cs.findIndex((c) => c.captureId === event.payload.captureId);
        if (i === -1) return [...cs, event.payload];
        const next = cs.slice();
        next[i] = event.payload;
        return next;
      });
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenProgress = fn;
    }).catch(() => {});
    void listen<{ captureId: string }>("agent-cc-capture-end", (event) => {
      setCaptures((cs) => cs.filter((c) => c.captureId !== event.payload.captureId));
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenEnd = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenEnd?.();
    };
  }, []);

  // --- captured-run terminal echo (方案4 mirror) -----------------------
  // The default run_captured path runs in an independent channel, so it never
  // appears in the bound terminal. The backend emits this once a captured run
  // finishes; we paint a compact, read-only trace (command + output head +
  // stats) into that terminal so the user sees what CC did. Display-only
  // (writeEcho -> xterm.write), never touches stdin.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<CcTerminalEcho>("agent-cc-terminal-echo", (event) => {
      if (useAiStore.getState().config?.cc_bridge.terminal_echo_enabled === false) {
        return;
      }
      const term = getTerminal(event.payload.sessionId);
      if (!term?.writeEcho) return; // terminal closed / no display sink; chat still has it
      try {
        term.writeEcho(formatCcTerminalEcho(event.payload));
      } catch (e) {
        console.error("cc terminal echo failed:", e);
      }
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // --- SQL echo to the linked query tab --------------------------------
  // When CC runs SQL on a bound DB connection the backend emits
  // `agent-cc-sql-echo`; if the toggle is on we resolve the thread's linked
  // query tab and append the statement to its editor (never run it).
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<SqlEcho>("agent-cc-sql-echo", (event) => {
      if (!useAppStore.getState().sqlEcho) return;
      const e = event.payload;
      const tabId =
        useChatStore.getState().threads.find((t) => t.id === e.threadId)
          ?.linked_session_id ?? null;
      const entry = getQueryTab(tabId);
      if (!entry) return;
      try {
        entry.appendEchoSql(e.sql, buildEchoNote(e));
      } catch (err) {
        console.error("sql echo append failed:", err);
      }
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const cancelCapture = useCallback(async (captureId: string) => {
    try {
      await invoke("cc_cancel_capture", { captureId });
    } catch (e) {
      console.error("cc_cancel_capture failed:", e);
    }
  }, []);

  return (
    <>
      {captures.length > 0 && (
        <div className="fixed bottom-4 left-4 z-[1000] flex max-w-[360px] flex-col gap-2">
          {captures.map((c) => (
            <div
              key={c.captureId}
              className="flex items-center justify-between gap-3 rounded bg-[var(--taomni-bg-elevated,#222)] px-3 py-2 text-xs shadow-lg"
            >
              <span className="truncate text-[var(--taomni-text-muted)]">
                捕获中 {c.lines.toLocaleString()} 行 · {fmtBytes(c.bytes)}
              </span>
              <button
                type="button"
                className="shrink-0 rounded border border-[var(--taomni-border,#444)] px-2 py-0.5 hover:bg-[var(--taomni-bg-hover,#333)]"
                onClick={() => void cancelCapture(c.captureId)}
              >
                取消
              </button>
            </div>
          ))}
        </div>
      )}
      {head && (
        <div className="fixed bottom-4 right-4 z-[1000] max-w-[420px] shadow-lg">
          <ActionCard
            tool={head.tool}
            description={describe(head.tool, head.args)}
            preview={preview(head.args)}
            requiresConfirmation={true}
            executing={deciding}
            onDecide={(d) => void decide(head, d)}
          />
        </div>
      )}
    </>
  );
}

/** Perform an approved side-effect tool and report the outcome back to CC. */
async function executeTool(dispatch: ToolDispatch): Promise<void> {
  let ok = false;
  let output = "";
  const args = dispatch.args ?? {};
  try {
    switch (dispatch.tool) {
      case "run_in_terminal": {
        // `session_id` here is the thread's bound terminal *tabId* (what
        // linked_session_id stores), not the backend session id. Look the live
        // panel up in the registry and use its writeInput(): it targets the
        // correct backend session and base64-encodes internally. Passing the
        // tabId straight to writeTerminal would address the wrong session.
        const tabId = String(args.session_id ?? "");
        const command = String(args.command ?? "");
        if (!tabId) {
          output = "run_in_terminal requires a session_id";
          break;
        }
        const term = getTerminal(tabId);
        if (!term) {
          return;
        }
        term.writeInput(buildInteractiveCommandInput(command));
        ok = true;
        output = "command sent to terminal";
        break;
      }
      case "read_terminal_tail": {
        // Lets CC read back what a command actually produced in the bound SSH
        // session, instead of guessing the output from environment context.
        const tabId = String(args.session_id ?? "");
        if (!tabId) {
          output = "read_terminal_tail requires a session_id";
          break;
        }
        const term = getTerminal(tabId);
        if (!term) {
          return;
        }
        const n = Number(args.lines ?? 50);
        output = term.getLastLines(Number.isFinite(n) && n > 0 ? n : 50);
        ok = true;
        break;
      }
      case "sftp_download": {
        output = await executeSftpDownloadTool(args);
        ok = true;
        break;
      }
      case "switch_tab":
        output = "switch_tab is deprecated in this bridge; call taomni_control.session_open for saved sessions or taomni_control.tab_switch for already-open tabs.";
        break;
      case "open_session_editor":
        output = "open_session_editor is deprecated in this bridge; call taomni_control.session_open_editor instead.";
        break;
      default:
        output = `工具 "${dispatch.tool}" 暂不支持从界面执行`;
    }
  } catch (e) {
    output = e instanceof Error ? e.message : String(e);
  }
  try {
    await invoke("cc_resolve_tool_call", {
      callId: dispatch.callId,
      ok,
      output,
    });
  } catch (e) {
    console.error("cc_resolve_tool_call failed:", e);
  }
}
