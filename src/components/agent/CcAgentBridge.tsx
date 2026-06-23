import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ActionCard, type ActionCardDecision } from "./ActionCard";
import { getTerminal } from "../../lib/terminal/terminalRegistry";

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
          output = `no live terminal for session ${tabId}`;
          break;
        }
        term.writeInput(command + "\n");
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
          output = `no live terminal for session ${tabId}`;
          break;
        }
        const n = Number(args.lines ?? 50);
        output = term.getLastLines(Number.isFinite(n) && n > 0 ? n : 50);
        ok = true;
        break;
      }
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
