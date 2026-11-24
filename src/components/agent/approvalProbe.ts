/**
 * QA-only approval probe (issue #869).
 *
 * A real local-agent permission prompt needs the Claude Code CLI or a running
 * ACP agent, so browser preview and native QA runs cannot produce one on demand.
 * This probe creates the *trigger* only:
 *
 * - In the isolated QA build (`__TAOMNI_QA_AGENT_APPROVAL_PROBE__`) it invokes
 *   the QA-gated `qa_agent_approval_probe` command, which registers a real
 *   pending permission and emits the real `agent-cc-permission` event through the
 *   shipped thread -> window targeting. The card, the decision command and the
 *   resolved broadcast are the production ones.
 * - In browser preview it emits the same event shapes through the stubbed Tauri
 *   event bus so the renderer contract (window addressing, dedupe, dismissal)
 *   can be asserted without a desktop backend.
 *
 * The trigger is a hidden chord (Ctrl/Cmd+Alt+Shift+F9), so it adds no visible
 * control to any surface and cannot overlap product UI. Everything the case
 * needs to assert is written to `localStorage` under `qa.agentApproval.*`:
 *
 * - `threadId` (seeded by the case): thread to attribute the prompt to.
 * - `mode` (seeded by the case): `own` | `fallback` | `stale` | `foreign` |
 *   `duplicate` | `resolved` | `acp` | `acp-dismiss` | `tool` (desktop only:
 *   dispatches a real terminal side effect to the window that owns the terminal).
 * - `lastResult` (written by the probe): probe outcome, `{decision, delivery,
 *   windowLabel, ...}`; a resolved native decision therefore proves the real
 *   backend path completed.
 * - `lastPrompt` (written by the probe): last emitted prompt, used by
 *   `duplicate` and `resolved`.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../../lib/runtime";
import { currentWindowLabel } from "../../lib/windowLabel";

/**
 * Compiled in only for the isolated QA bundle and the browser preview server;
 * normal production builds compile the install branch away.
 */
export const QA_APPROVAL_PROBE_ENABLED = __TAOMNI_QA_AGENT_APPROVAL_PROBE__;

export const APPROVAL_PROBE_MODE_KEY = "qa.agentApproval.mode";
export const APPROVAL_PROBE_THREAD_KEY = "qa.agentApproval.threadId";
export const APPROVAL_PROBE_RESULT_KEY = "qa.agentApproval.lastResult";
export const APPROVAL_PROBE_LAST_KEY = "qa.agentApproval.lastPrompt";
/**
 * Journal of the last probe attempt, including the backend result. QA cases use
 * it to prove the trigger actually reached the backend (and whether a duplicate
 * trigger was skipped) without having to wait for a decision.
 */
export const APPROVAL_PROBE_ATTEMPT_KEY = "qa.agentApproval.lastAttempt";

/** Mode used when the case seeds none. */
export const APPROVAL_PROBE_DEFAULT_MODE = "own";
/** Thread used when the case seeds none. */
export const APPROVAL_PROBE_DEFAULT_THREAD = "qa-agent-approval-thread";
/** Label a `foreign` probe addresses, to prove other windows' events are ignored. */
export const APPROVAL_PROBE_FOREIGN_LABEL = "qa-other-window";

export type ApprovalProbeMode =
  | "own"
  | "fallback"
  | "stale"
  | "foreign"
  | "duplicate"
  | "resolved"
  | "acp"
  | "acp-dismiss"
  | "tool";

interface StoredPrompt {
  source: "cc" | "acp";
  event: string;
  payload: Record<string, unknown>;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* probe evidence is best-effort; the case still asserts the UI */
  }
}

function readStoredPrompt(): StoredPrompt | null {
  const raw = read(APPROVAL_PROBE_LAST_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredPrompt;
    return parsed && typeof parsed.event === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read a case-seeded value. Cases seed through the QA `seed_storage` verb, which
 * requires valid JSON, so a string seed is stored as `"own"`; accept both the
 * JSON-quoted and the plain form so a manually seeded value works too.
 */
function readSeed(key: string, fallback: string): string {
  const raw = (read(key) ?? fallback).trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    } catch {
      /* fall through to the raw value */
    }
  }
  return raw;
}

function probeMode(): string {
  return readSeed(APPROVAL_PROBE_MODE_KEY, APPROVAL_PROBE_DEFAULT_MODE);
}

function probeThread(): string {
  return readSeed(APPROVAL_PROBE_THREAD_KEY, APPROVAL_PROBE_DEFAULT_THREAD);
}

let probeSeq = 0;

/**
 * Whether a real Tauri backend answers IPC in this webview.
 *
 * `isTauriRuntime()` alone is not enough for unit tests: they install only the
 * window metadata (to exercise the label filter) without an IPC function, so the
 * probe must stay on the renderer-only path there.
 */
function hasDesktopBackend(): boolean {
  if (!isTauriRuntime()) return false;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}

function nextCallId(prefix: string): string {
  probeSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${probeSeq}`;
}

function ccPromptPayload(callId: string, threadId: string, windowLabel?: string): Record<string, unknown> {
  return {
    callId,
    threadId,
    tool: "Bash",
    args: { command: "echo qa-approved", description: "QA probe command (issue #869)" },
    trust: "manual",
    ...(windowLabel ? { windowLabel } : {}),
  };
}

function acpPromptPayload(callId: string, threadId: string, windowLabel?: string): Record<string, unknown> {
  return {
    callId,
    threadId,
    permissionOwnerId: "qa-approval-probe",
    sourceLabel: "ACP QA 探针",
    title: "写入 README.md（QA 探针）",
    kind: "edit",
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
      { optionId: "reject-always", kind: "reject_always" },
    ],
    ...(windowLabel ? { windowLabel } : {}),
  };
}

async function emitCc(payload: Record<string, unknown>): Promise<void> {
  writeJson(APPROVAL_PROBE_LAST_KEY, { source: "cc", event: "agent-cc-permission", payload } satisfies StoredPrompt);
  await emit("agent-cc-permission", payload);
}

async function emitAcp(payload: Record<string, unknown>): Promise<void> {
  writeJson(APPROVAL_PROBE_LAST_KEY, { source: "acp", event: "agent-acp-permission", payload } satisfies StoredPrompt);
  await emit("agent-acp-permission", payload);
}

/**
 * Browser-preview path: the desktop backend does not exist, so the probe emits
 * the production event shapes through the stub event bus. The label comes from
 * the stubbed window shim, which keeps the renderer's window filter real.
 */
async function runBrowserProbe(mode: string, threadId: string): Promise<void> {
  const label = currentWindowLabel();
  switch (mode) {
    case "own": {
      await emitCc(ccPromptPayload(nextCallId("qa-cc"), threadId, label ?? undefined));
      break;
    }
    case "fallback":
    case "stale": {
      // Broadcast fallback: no window label, so every window must answer.
      // `stale` is the desktop-only mode that records an owner window which no
      // longer exists; in preview the emitted event is identical.
      await emitCc(ccPromptPayload(nextCallId("qa-cc"), threadId));
      break;
    }
    case "foreign": {
      await emitCc(ccPromptPayload(nextCallId("qa-cc"), threadId, APPROVAL_PROBE_FOREIGN_LABEL));
      break;
    }
    case "duplicate": {
      const last = readStoredPrompt();
      if (!last) throw new Error("approval probe: duplicate requires a previous prompt");
      await emit(last.event, last.payload);
      break;
    }
    case "resolved": {
      const last = readStoredPrompt();
      if (!last) throw new Error("approval probe: resolved requires a previous prompt");
      await emit("agent-cc-permission-resolved", {
        callId: last.payload.callId ?? null,
        threadId: last.payload.threadId ?? threadId,
      });
      break;
    }
    case "acp": {
      await emitAcp(acpPromptPayload(nextCallId("qa-acp"), threadId, label ?? undefined));
      break;
    }
    case "acp-dismiss": {
      const last = readStoredPrompt();
      await emit("agent-acp-permission-dismissed", {
        threadId: last?.payload.threadId ?? threadId,
        permissionOwnerId: null,
        callId: null,
      });
      break;
    }
    default:
      throw new Error(`approval probe: unsupported browser mode ${mode}`);
  }
}

let probeInFlight = false;

/**
 * Run one probe cycle. Exported for unit tests; the installed chord calls it.
 *
 * A chord must not stack prompts: the `own`/`stale` modes stay in flight until a
 * card is decided, so a duplicated key event (observed with the WebKitGTK
 * automation transport after a window switch) would otherwise create a second
 * pending approval that later re-appears through the mount replay.
 */
export async function runApprovalProbe(): Promise<void> {
  if (probeInFlight) return;
  probeInFlight = true;
  const mode = probeMode();
  const threadId = probeThread();
  try {
    if (!hasDesktopBackend()) {
      await runBrowserProbe(mode, threadId);
      writeJson(APPROVAL_PROBE_RESULT_KEY, {
        threadId,
        mode,
        windowLabel: currentWindowLabel(),
        result: "emitted",
      });
      return;
    }
    writeJson(APPROVAL_PROBE_ATTEMPT_KEY, {
      threadId,
      mode,
      windowLabel: currentWindowLabel(),
    });
    const result = await invoke<Record<string, unknown>>("qa_agent_approval_probe", {
      threadId,
      mode,
    });
    writeJson(APPROVAL_PROBE_ATTEMPT_KEY, {
      threadId,
      mode,
      windowLabel: currentWindowLabel(),
      result: result ?? null,
    });
    // A duplicate trigger is rejected by the backend's single-flight guard; it
    // must not overwrite the outcome of the prompt that is actually pending.
    if (result && typeof result.skipped === "string") return;
    writeJson(APPROVAL_PROBE_RESULT_KEY, { threadId, mode, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(APPROVAL_PROBE_RESULT_KEY, { threadId, mode, error: message });
    writeJson(APPROVAL_PROBE_ATTEMPT_KEY, { threadId, mode, error: message });
  } finally {
    probeInFlight = false;
  }
}

function isProbeChord(event: KeyboardEvent): boolean {
  // WebKitGTK's automation transport does not always populate `code`, so accept
  // the physical key name as well as the printable key.
  const isF9 = event.code === "F9" || event.key === "F9";
  return isF9 && (event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey;
}

let installed = false;
let listener: ((event: KeyboardEvent) => void) | null = null;

/**
 * Install the hidden probe chord for this window. Idempotent; returns the
 * cleanup for the component effect.
 */
export function installApprovalProbe(): () => void {
  if (typeof window === "undefined") return () => {};
  if (installed) return () => {};
  listener = (event: KeyboardEvent) => {
    if (!isProbeChord(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void runApprovalProbe();
  };
  window.addEventListener("keydown", listener, true);
  installed = true;
  return () => uninstallApprovalProbe();
}

/** Test teardown only. */
export function uninstallApprovalProbe(): void {
  if (typeof window !== "undefined" && listener) {
    window.removeEventListener("keydown", listener, true);
  }
  listener = null;
  installed = false;
}
