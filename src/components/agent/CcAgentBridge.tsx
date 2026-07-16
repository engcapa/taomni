import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
} from "react";
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
  sftpListLocal,
  sftpStat,
  sftpUpload,
  sftpUploadDir,
  type FileEntry,
  type TransferCompletePayload,
  type TransferProgressPayload,
} from "../../lib/sftp";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";
import { useAiStore } from "../../stores/aiStore";
import { useChatStore } from "../../stores/chatStore";
import { useAppStore } from "../../stores/appStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSftpStore } from "../../stores/sftpStore";
import { newTransferId, useTransferStore } from "../../stores/transferStore";
/**
 * Bridges local agent human-in-the-loop events to the UI.
 *
 * - `agent-cc-permission`: CC asked to run a write/side-effect tool. We surface
 *   an ActionCard; the user's choice is sent back via `cc_resolve_permission`,
 *   unblocking the server's `permission_prompt` handler.
 * - `agent-acp-permission`: an ACP agent (such as Grok CLI) requested native
 *   tool permission. We show locally trusted labels for standard ACP choices
 *   and return the selected opaque option id via `acp_resolve_permission`.
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

interface AcpPermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

interface AcpPermissionPrompt {
  callId: string;
  threadId: string;
  permissionOwnerId: string;
  sourceLabel: string;
  title: string;
  kind: string;
  options: AcpPermissionOption[];
}

interface AcpPermissionDismissed {
  threadId: string;
  permissionOwnerId?: string | null;
  callId?: string | null;
}

type QueuedPermission =
  | ({ source: "cc" } & PermissionPrompt)
  | ({ source: "acp" } & AcpPermissionPrompt);

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

const LARGE_UPLOAD_THRESHOLD_BYTES = 60 * 1024 * 1024;
const SAFETY_GATE_DRAWER_SELECTOR = '[data-testid="ai-chat-drawer"]';
const SAFETY_GATE_INSET = 12;
const SAFETY_GATE_VIEWPORT_MARGIN = 16;
const SAFETY_GATE_MAX_WIDTH = 420;
const SAFETY_GATE_MIN_WIDTH = 260;

interface SafetyGatePlacement {
  anchored: boolean;
  style: CSSProperties;
}

function viewportSafetyGatePlacement(): SafetyGatePlacement {
  return {
    anchored: false,
    style: {
      right: SAFETY_GATE_VIEWPORT_MARGIN,
      bottom: SAFETY_GATE_VIEWPORT_MARGIN,
      width: `min(calc(100vw - ${SAFETY_GATE_VIEWPORT_MARGIN * 2}px), ${SAFETY_GATE_MAX_WIDTH}px)`,
    },
  };
}

function computeSafetyGatePlacement(): SafetyGatePlacement {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return viewportSafetyGatePlacement();
  }
  const drawer = document.querySelector<HTMLElement>(SAFETY_GATE_DRAWER_SELECTOR);
  if (!drawer) return viewportSafetyGatePlacement();
  const rect = drawer.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return viewportSafetyGatePlacement();
  const width = Math.min(
    SAFETY_GATE_MAX_WIDTH,
    Math.max(SAFETY_GATE_MIN_WIDTH, rect.width - SAFETY_GATE_INSET * 2),
  );
  return {
    anchored: true,
    style: {
      right: Math.max(
        SAFETY_GATE_VIEWPORT_MARGIN,
        window.innerWidth - rect.right + SAFETY_GATE_INSET,
      ),
      bottom: Math.max(
        SAFETY_GATE_VIEWPORT_MARGIN,
        window.innerHeight - rect.bottom + SAFETY_GATE_INSET,
      ),
      width,
    },
  };
}

function useSafetyGatePlacement(active: boolean): SafetyGatePlacement {
  const [placement, setPlacement] = useState<SafetyGatePlacement>(viewportSafetyGatePlacement);
  const updatePlacement = useCallback(() => {
    setPlacement(computeSafetyGatePlacement());
  }, []);

  useLayoutEffect(() => {
    if (!active) return;
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    let resizeObserver: ResizeObserver | null = null;
    const drawer = document.querySelector<HTMLElement>(SAFETY_GATE_DRAWER_SELECTOR);
    if (drawer && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(updatePlacement);
      resizeObserver.observe(drawer);
    }
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
      resizeObserver?.disconnect();
    };
  }, [active, updatePlacement]);

  return active ? placement : viewportSafetyGatePlacement();
}

const ACP_PERMISSION_OPTION_PRESENTATION: Record<
  AcpPermissionOption["kind"],
  { label: string; className: string }
> = {
  allow_once: {
    label: "仅允许这一次",
    className: "border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10",
  },
  allow_always: {
    label: "始终允许",
    className: "border border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/10",
  },
  reject_once: {
    label: "拒绝这一次",
    className: "border border-red-500/50 text-red-300 hover:bg-red-500/10",
  },
  reject_always: {
    label: "始终拒绝",
    className: "border border-red-500/50 text-red-300 hover:bg-red-500/10",
  },
};

function AcpPermissionCard({
  prompt,
  executing,
  isActiveThread,
  onSelect,
  onCancel,
}: {
  prompt: Extract<QueuedPermission, { source: "acp" }>;
  executing: boolean;
  isActiveThread: boolean;
  onSelect: (optionId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="max-w-md w-full rounded-lg border border-yellow-500/50 bg-[var(--taomni-panel-bg)] p-3 shadow-md"
      data-testid="ai-chat-acp-permission-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-semibold">本地 Agent 请求执行操作</span>
        <span className="rounded border border-yellow-500/40 px-1.5 py-0.5 text-[10px] text-yellow-400">
          需要确认
        </span>
      </div>
      <div className="mb-1 text-[10px] text-[var(--taomni-text-muted)]">
        来源：本地 {prompt.sourceLabel}{isActiveThread ? "" : " · 后台对话"}
      </div>
      <div className="mb-1 text-[11px] text-[var(--taomni-text-muted)]">{prompt.title}</div>
      <div className="mb-2 text-[10px] text-[var(--taomni-text-muted)]">
        操作类型：{prompt.kind}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {prompt.options.map((option) => {
          const presentation = ACP_PERMISSION_OPTION_PRESENTATION[option.kind];
          return (
            <button
              key={option.optionId}
              type="button"
              className={`taomni-btn h-7 px-3 text-[12px] disabled:cursor-wait disabled:opacity-60 ${presentation.className}`}
              disabled={executing}
              data-testid={`ai-chat-acp-permission-option-${option.kind}`}
              onClick={() => onSelect(option.optionId)}
            >
              {presentation.label}
            </button>
          );
        })}
        <button
          type="button"
          className="taomni-btn h-7 px-3 text-[12px] text-[var(--taomni-text-muted)] disabled:cursor-wait disabled:opacity-60"
          disabled={executing}
          data-testid="ai-chat-acp-permission-cancel"
          onClick={onCancel}
        >
          取消操作
        </button>
      </div>
    </div>
  );
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
    case "sftp_upload": {
      const localPaths = uploadLocalPaths(args);
      const remote = String(args.remote_path ?? args.remote_dir ?? "");
      if (localPaths.length > 1) return `上传 ${localPaths.length} 个本地文件到 ${remote}`;
      return `上传 ${localPaths[0] ?? String(args.local_path ?? "")} 到 ${remote}`;
    }
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
  const uploadPaths = uploadLocalPaths(args);
  if (uploadPaths.length > 0) return uploadPaths.join(", ");
  if (typeof args.remote_path === "string") return args.remote_path;
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(asString).filter((item) => item.length > 0);
  }
  const single = asString(value);
  return single ? [single] : [];
}

function uploadLocalPaths(args: Record<string, unknown>): string[] {
  const paths = [
    ...asStringList(args.local_path),
    ...asStringList(args.local_paths),
  ];
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

interface AgentToolContext {
  threadId: string;
  callId: string;
  tool: string;
}

const agentToolCardTargets = new Map<string, string>();

function updateAgentToolCardResult(ctx: AgentToolContext, result: string): void {
  const messageId = useChatStore.getState().streamingId[ctx.threadId];
  if (!messageId) return;

  useChatStore.setState((state) => {
    const cards = [...(state.ccToolCards[messageId] ?? [])];
    const targetCallId = agentToolCardTargets.get(ctx.callId) ?? ctx.callId;
    let idx = cards.findIndex((card) => card.call_id === targetCallId);
    if (idx < 0) {
      for (let i = cards.length - 1; i >= 0; i -= 1) {
        const cardTool = cards[i]?.tool ?? "";
        if (
          cardTool === ctx.tool ||
          cardTool.endsWith(`__${ctx.tool}`) ||
          cardTool.includes(ctx.tool)
        ) {
          idx = i;
          agentToolCardTargets.set(ctx.callId, cards[i].call_id);
          break;
        }
      }
    }

    if (idx >= 0) {
      cards[idx] = { ...cards[idx], result };
    } else {
      cards.push({ call_id: ctx.callId, tool: ctx.tool, detail: "", result });
      agentToolCardTargets.set(ctx.callId, ctx.callId);
    }
    return { ccToolCards: { ...state.ccToolCards, [messageId]: cards } };
  });
}

function reportAgentToolStatus(ctx: AgentToolContext | null | undefined, message: string): void {
  useAppStore.getState().setStatusMessage(message);
  if (ctx) updateAgentToolCardResult(ctx, message);
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

function showSftpNotification(title: string, body: string): void {
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

function showSftpDownloadNotification(finalPath: string): void {
  showSftpNotification("SFTP download complete", finalPath);
}

function showSftpUploadNotification(finalPath: string): void {
  showSftpNotification("SFTP upload complete", finalPath);
}

async function runTrackedSftpTransfer(opts: {
  transferId: string;
  failureLabel: string;
  run: () => Promise<void>;
  onProgress?: (payload: TransferProgressPayload) => void;
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
        opts.onProgress?.(payload);
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
          transferStore.setState(opts.transferId, "error", payload.error ?? opts.failureLabel);
        }
        resolveComplete(payload);
      }),
    ]);
    unlistenProgress = progress;
    unlistenPaused = paused;
    unlistenComplete = complete;

    await opts.run();

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

async function runTrackedSftpDownload(opts: {
  sessionId: string;
  transferId: string;
  remotePath: string;
  localPath: string;
  isDir: boolean;
  onProgress?: (payload: TransferProgressPayload) => void;
}): Promise<TransferCompletePayload | null> {
  return runTrackedSftpTransfer({
    transferId: opts.transferId,
    failureLabel: "download failed",
    onProgress: opts.onProgress,
    run: async () => {
      if (opts.isDir) {
        await sftpDownloadDir(opts.sessionId, opts.transferId, opts.remotePath, opts.localPath);
      } else {
        await sftpDownload(opts.sessionId, opts.transferId, opts.remotePath, opts.localPath, false);
      }
    },
  });
}

async function runTrackedSftpUpload(opts: {
  sessionId: string;
  transferId: string;
  localPath: string;
  remotePath: string;
  isDir: boolean;
  onProgress?: (payload: TransferProgressPayload) => void;
}): Promise<TransferCompletePayload | null> {
  return runTrackedSftpTransfer({
    transferId: opts.transferId,
    failureLabel: "upload failed",
    onProgress: opts.onProgress,
    run: async () => {
      if (opts.isDir) {
        await sftpUploadDir(opts.sessionId, opts.transferId, opts.localPath, opts.remotePath);
      } else {
        await sftpUpload(opts.sessionId, opts.transferId, opts.localPath, opts.remotePath, false);
      }
    },
  });
}

function makeTransferProgressReporter(
  ctx: AgentToolContext | null | undefined,
  prefix: string,
): (payload: TransferProgressPayload) => void {
  let lastReport = 0;
  return (payload) => {
    const now = Date.now();
    if (now - lastReport < 1000 && payload.bytes < payload.total) return;
    lastReport = now;
    const total = payload.total > 0 ? ` / ${fmtBytes(payload.total)}` : "";
    const rate = payload.rate > 0 ? ` @ ${fmtBytes(payload.rate)}/s` : "";
    reportAgentToolStatus(ctx, `${prefix}: ${fmtBytes(payload.bytes)}${total}${rate}`);
  };
}

interface SftpUploadPlan {
  name: string;
  localPath: string;
  remotePath: string;
  kind: "file" | "dir";
  size: number;
}

async function localEntryTransferSize(entry: FileEntry): Promise<number> {
  if (entry.fileType !== "dir") return entry.size || 0;
  const children = await sftpListLocal(entry.path);
  let total = 0;
  for (const child of children) {
    total += await localEntryTransferSize(child);
  }
  return total;
}

async function resolveUploadRemotePath(
  sessionId: string,
  remotePath: string,
  localName: string,
  totalCount: number,
): Promise<string> {
  if (remotePath.endsWith("/") || remotePath.endsWith("\\")) {
    return joinPath(remotePath, localName);
  }

  try {
    const remoteEntry = await sftpStat(sessionId, remotePath, "remote");
    if (isDirectory(remoteEntry)) return joinPath(remotePath, localName);
  } catch {
    // Missing remote paths are valid for a single-file upload, where the path
    // names the desired destination file. Multiple files need a directory.
  }

  if (totalCount > 1) {
    throw new Error(
      "sftp_upload with multiple local paths requires remote_path to be an existing remote directory or end with /",
    );
  }
  return remotePath;
}

async function buildSftpUploadPlans(
  sessionId: string,
  localPaths: string[],
  remotePath: string,
): Promise<SftpUploadPlan[]> {
  const plans: SftpUploadPlan[] = [];
  for (const localPath of localPaths) {
    const entry = await sftpStat(sessionId, localPath, "local")
      .catch((err) => {
        throw new Error(`Local upload path does not exist: ${localPath} (${err})`);
      });
    const name = entry.name || basename(localPath) || "upload";
    const kind = entry.fileType === "dir" ? "dir" : "file";
    const size = await localEntryTransferSize(entry);
    plans.push({
      name,
      kind,
      size,
      localPath: entry.path || localPath,
      remotePath: await resolveUploadRemotePath(sessionId, remotePath, name, localPaths.length),
    });
  }
  return plans;
}

function formatUploadSummary(results: Array<{ localPath: string; remotePath: string }>): string {
  const lines = results.slice(0, 8).map((item) => `${item.localPath} -> ${item.remotePath}`);
  if (results.length > lines.length) {
    lines.push(`... ${results.length - lines.length} more`);
  }
  return lines.join("\n");
}

async function executeSftpUploadTool(
  args: Record<string, unknown>,
  ctx?: AgentToolContext,
): Promise<string> {
  const rawSessionId = asString(args.session_id);
  const localPaths = uploadLocalPaths(args);
  const remotePath = asString(args.remote_path ?? args.remote_dir);
  if (!rawSessionId) throw new Error("sftp_upload requires session_id");
  if (localPaths.length === 0) throw new Error("sftp_upload requires local_path or local_paths");
  if (!remotePath) throw new Error("sftp_upload requires remote_path");

  const sessionId = await ensureSftpSession(rawSessionId);
  reportAgentToolStatus(ctx, `Preparing SFTP upload to ${remotePath}`);
  const plans = await buildSftpUploadPlans(sessionId, localPaths, remotePath);
  const totalBytes = plans.reduce((sum, plan) => sum + plan.size, 0);
  if (totalBytes > LARGE_UPLOAD_THRESHOLD_BYTES) {
    reportAgentToolStatus(
      ctx,
      `Large SFTP upload: ${fmtBytes(totalBytes)}; this may take a while`,
    );
  }

  const completed: Array<{ localPath: string; remotePath: string }> = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const transferId = newTransferId();
    const ordinal = plans.length > 1 ? `${index + 1}/${plans.length} ` : "";
    useTransferStore.getState().add({
      id: transferId,
      sessionId,
      direction: "upload",
      kind: plan.kind,
      localPath: plan.localPath,
      remotePath: plan.remotePath,
      size: plan.size,
      bytes: 0,
      rate: 0,
      eta: 0,
      state: "queued",
      startedAt: Date.now(),
      openAfter: false,
    });

    reportAgentToolStatus(ctx, `Uploading ${ordinal}${plan.name} -> ${plan.remotePath}`);
    try {
      const payload = await runTrackedSftpUpload({
        sessionId,
        transferId,
        localPath: plan.localPath,
        remotePath: plan.remotePath,
        isDir: plan.kind === "dir",
        onProgress: makeTransferProgressReporter(ctx, `Uploading ${ordinal}${plan.name}`),
      });
      if (payload && !payload.success) {
        throw new Error(payload.error ?? "upload failed");
      }
      const finalPath = payload?.finalPath || plan.remotePath;
      completed.push({ localPath: plan.localPath, remotePath: finalPath });
      void useSftpStore.getState().refreshPane(sessionId, "remote").catch(() => undefined);
      showSftpUploadNotification(finalPath);
      reportAgentToolStatus(ctx, `Completed upload ${ordinal}${plan.name} -> ${finalPath}`);
    } catch (err) {
      useTransferStore.getState().setState(
        transferId,
        "error",
        err instanceof Error ? err.message : String(err),
      );
      const prefix = completed.length > 0
        ? `Upload failed after ${completed.length}/${plans.length} completed`
        : "Upload failed";
      throw new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const largeNote = totalBytes > LARGE_UPLOAD_THRESHOLD_BYTES
    ? `large upload ${fmtBytes(totalBytes)}; `
    : "";
  return `${largeNote}uploaded ${completed.length} item(s):\n${formatUploadSummary(completed)}`;
}

async function executeSftpDownloadTool(
  args: Record<string, unknown>,
  ctx?: AgentToolContext,
): Promise<string> {
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
  reportAgentToolStatus(ctx, `Preparing SFTP download: ${remotePath} -> ${localPath}`);

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
      onProgress: makeTransferProgressReporter(ctx, `Downloading ${localName}`),
    });
    if (payload && !payload.success) {
      throw new Error(payload.error ?? "download failed");
    }
    const finalPath = payload?.finalPath || localPath;
    void useSftpStore.getState().refreshPane(sessionId, "local").catch(() => undefined);
    showSftpDownloadNotification(finalPath);
    reportAgentToolStatus(ctx, `Downloaded ${remotePath} -> ${finalPath}`);
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
  const [queue, setQueue] = useState<QueuedPermission[]>([]);
  const [deciding, setDeciding] = useState(false);
  const [captures, setCaptures] = useState<CaptureProgress[]>([]);
  const activeThreadId = useChatStore((state) => state.activeThreadId);

  // --- permission prompts (HITL) ---------------------------------------
  useEffect(() => {
    let unlistenCc: UnlistenFn | null = null;
    let unlistenAcp: UnlistenFn | null = null;
    let unlistenAcpDismissed: UnlistenFn | null = null;
    let disposed = false;
    void listen<PermissionPrompt>("agent-cc-permission", (event) => {
      // Dedupe by callId: a stray double-emit must not stack two cards.
      const prompt: QueuedPermission = { source: "cc", ...event.payload };
      setQueue((q) =>
        q.some((p) => p.source === prompt.source && p.callId === prompt.callId)
          ? q
          : [...q, prompt],
      );
    }).then((fn) => {
      // `listen` resolves async. If the effect was already torn down (React
      // StrictMode double-mount in dev), unregister immediately instead of
      // leaking this listener — a leak would fire every handler twice.
      if (disposed) void fn();
      else unlistenCc = fn;
    }).catch(() => {
      // `listen` can reject outside Tauri (e.g. jsdom tests); ignore — the
      // bridge is simply inert there.
    });
    void listen<AcpPermissionPrompt>("agent-acp-permission", (event) => {
      const prompt: QueuedPermission = { source: "acp", ...event.payload };
      setQueue((q) =>
        q.some(
          (p) =>
            p.source === prompt.source &&
            p.threadId === prompt.threadId &&
            p.callId === prompt.callId,
        )
          ? q
          : [...q, prompt],
      );
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenAcp = fn;
    }).catch(() => {
      // ACP gates are only emitted by the desktop backend; ignore a missing
      // event bridge in browser-only tests just like the CC listener above.
    });
    void listen<AcpPermissionDismissed>("agent-acp-permission-dismissed", (event) => {
      const { threadId, permissionOwnerId, callId } = event.payload;
      setQueue((q) =>
        q.filter((p) => {
          if (p.source !== "acp" || p.threadId !== threadId) return true;
          if (callId != null && p.callId !== callId) return true;
          return permissionOwnerId != null && p.permissionOwnerId !== permissionOwnerId;
        }),
      );
    }).then((fn) => {
      if (disposed) void fn();
      else unlistenAcpDismissed = fn;
    }).catch(() => {
      // The backend can dismiss a gate after an ACP timeout, stop, or close.
    });
    return () => {
      disposed = true;
      unlistenCc?.();
      unlistenAcp?.();
      unlistenAcpDismissed?.();
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
    async (prompt: Extract<QueuedPermission, { source: "cc" }>, decision: ActionCardDecision) => {
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
        setQueue((q) =>
          q.filter((p) => p.source !== prompt.source || p.callId !== prompt.callId),
        );
        setDeciding(false);
      }
    },
    [],
  );

  const decideAcp = useCallback(
    async (prompt: Extract<QueuedPermission, { source: "acp" }>, optionId: string) => {
      setDeciding(true);
      try {
        await invoke("acp_resolve_permission", {
          threadId: prompt.threadId,
          callId: prompt.callId,
          optionId,
        });
      } catch (e) {
        console.error("acp_resolve_permission failed:", e);
      } finally {
        setQueue((q) =>
          q.filter((p) => p.source !== prompt.source || p.callId !== prompt.callId),
        );
        setDeciding(false);
      }
    },
    [],
  );

  const cancelAcp = useCallback(
    async (prompt: Extract<QueuedPermission, { source: "acp" }>) => {
      setDeciding(true);
      try {
        await invoke("acp_cancel_permission", {
          threadId: prompt.threadId,
          callId: prompt.callId,
        });
      } catch (e) {
        console.error("acp_cancel_permission failed:", e);
      } finally {
        setQueue((q) =>
          q.filter((p) => p.source !== prompt.source || p.callId !== prompt.callId),
        );
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
  const safetyGatePlacement = useSafetyGatePlacement(Boolean(head));

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
        <div
          className="fixed z-[1000] shadow-lg"
          style={safetyGatePlacement.style}
          data-testid="ai-chat-safety-gate"
          data-anchor={safetyGatePlacement.anchored ? "chat-drawer" : "viewport"}
        >
          {head.source === "cc" ? (
            <ActionCard
              tool={head.tool}
              description={describe(head.tool, head.args)}
              preview={preview(head.args)}
              requiresConfirmation={true}
              executing={deciding}
              onDecide={(d) => void decide(head, d)}
            />
          ) : (
            <AcpPermissionCard
              prompt={head}
              executing={deciding}
              isActiveThread={head.threadId === activeThreadId}
              onSelect={(optionId) => void decideAcp(head, optionId)}
              onCancel={() => void cancelAcp(head)}
            />
          )}
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
      case "sftp_upload": {
        output = await executeSftpUploadTool(args, {
          threadId: dispatch.threadId,
          callId: dispatch.callId,
          tool: "sftp_upload",
        });
        ok = true;
        break;
      }
      case "sftp_download": {
        output = await executeSftpDownloadTool(args, {
          threadId: dispatch.threadId,
          callId: dispatch.callId,
          tool: "sftp_download",
        });
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
