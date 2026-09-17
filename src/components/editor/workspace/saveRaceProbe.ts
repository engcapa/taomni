/**
 * ED-PARITY-002 QA-only save-race probe (isolated QA build only).
 *
 * `pnpm build --mode qa` (the qa-ui-auto `com.taomni.app.qa` binary) defines
 * `__TAOMNI_QA_SAVE_GATE__`, which is the only way this module installs its
 * `window.__taomniQaSaveGate` control object. Normal bundles compile the
 * install call to a dead branch and expose no runtime entry.
 *
 * The probe holds ONE explicit save-transaction delivery point:
 *   - `prepare`: after the prepare/history await, before the synchronous
 *     pre-write boundary and the byte writer.
 *   - `ack`: after the REAL native writer was invoked, before its real ack is
 *     delivered to the committer.
 *   - `watcher`: after the REAL watched-files notify was invoked and the ack
 *     was delivered, before the writeback merge.
 * It never fabricates acks or hashes and never calls the writer itself. The
 * runner alone types into the live editor while a hold is entered.
 *
 * The optional `fault` arm withholds one REAL successful write response at the
 * QA transport boundary (after the native writer acked) so the production
 * unknown-effect re-read path runs against real bytes. It is recorded as a
 * controlled QA fault, never as a natural OS failure.
 */
import { WorkspaceWriteError, type WorkspaceWriteAck } from "../../../lib/editor/workspace";

export type SaveRaceStage = "prepare" | "ack" | "watcher" | "fault";

/**
 * `unknown-response`: withhold one REAL successful write response immediately
 * (intended-bytes read-back).
 * `unknown-response-delay`: hold the response after the REAL write attempt
 * (success or typed failure) until the runner releases it, so the runner can
 * mutate the real disk before the production unknown-effect read-back runs
 * (old/foreign/unreadable classifications).
 */
export type SaveRaceFaultMode = "unknown-response" | "unknown-response-delay";

export interface SaveRaceArmRequest {
  stage: SaveRaceStage;
  /** Optional identity match; omitted fields match any value. */
  workspaceId?: string;
  fileKey?: string;
  transactionId?: string;
  /** Absolute path of the file under test, e.g. `<fixture root>/edit.txt`. */
  filePath?: string;
  /** fault stage only; defaults to `unknown-response`. */
  mode?: SaveRaceFaultMode;
  timeoutMs?: number;
}

export interface SaveRaceHoldIdentity {
  workspaceId: string;
  fileKey: string;
  transactionId: string;
  filePath: string;
}

export interface SaveRaceHoldRequest extends SaveRaceHoldIdentity {
  stage: Exclude<SaveRaceStage, "fault">;
  /** Samples the live buffer revision at enter and at release. */
  revision?: () => number | null;
  /** Returning false releases the hold as `owner-invalidated`. */
  stillValid?: () => boolean;
}

export type SaveRaceTraceEvent =
  | "arm"
  | "enter"
  | "release"
  | "writer-invoked"
  | "writer-failed"
  | "ack-delivered"
  | "watcher-invoked"
  | "unknown-readback"
  | "fault-pending"
  | "fault-injected"
  | "commit-settled"
  | "note"
  | "rearm-release"
  | "timeout-release"
  | "owner-invalidated";

export interface SaveRaceTraceEntry {
  seq: number;
  atMs: number;
  wallClockMs: number;
  event: SaveRaceTraceEvent;
  stage?: SaveRaceStage;
  workspaceId?: string;
  fileKey?: string;
  transactionId?: string;
  filePath?: string;
  revision?: number | null;
  detail?: Record<string, unknown>;
}

export interface SaveRaceGateStatus {
  installed: boolean;
  nowMs: number;
  armed: {
    stage: SaveRaceStage;
    workspaceId?: string;
    fileKey?: string;
    transactionId?: string;
    filePath?: string;
    mode?: SaveRaceFaultMode;
    timeoutMs: number;
  } | null;
  held: {
    stage: SaveRaceStage;
    workspaceId: string;
    fileKey: string;
    transactionId: string;
    filePath: string;
    enteredAtMs: number;
    enteredAgoMs: number;
  } | null;
}

interface SaveRaceGateControl {
  arm(request: SaveRaceArmRequest): { ok: boolean; stage?: SaveRaceStage; reason?: string };
  status(): SaveRaceGateStatus;
  release(request?: { reason?: string }): { ok: boolean; reason?: string };
  note(request: { label: string; value: unknown }): { ok: boolean };
  trace(): SaveRaceTraceEntry[];
}

const DEFAULT_HOLD_TIMEOUT_MS = 20_000;
const OWNER_POLL_INTERVAL_MS = 50;

function holdReleaseEvent(reason: string): SaveRaceTraceEvent {
  if (reason === "timeout-release") return "timeout-release";
  if (reason === "owner-invalidated") return "owner-invalidated";
  if (reason === "rearm-release") return "rearm-release";
  return "release";
}

let installed = false;
let armed: (SaveRaceArmRequest & { timeoutMs: number }) | null = null;
let held: {
  request: SaveRaceArmRequest & { timeoutMs: number };
  enteredAtMs: number;
  resolve: (reason: string) => void;
  timer: number;
  poll: number | null;
} | null = null;
let traceSeq = 0;
const traceEntries: SaveRaceTraceEntry[] = [];

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function pushTrace(entry: Omit<SaveRaceTraceEntry, "seq" | "atMs" | "wallClockMs">): void {
  traceSeq += 1;
  traceEntries.push({
    seq: traceSeq,
    atMs: monotonicNow(),
    wallClockMs: Date.now(),
    ...entry,
  });
}

function identityMatches(request: SaveRaceArmRequest, identity: SaveRaceHoldIdentity): boolean {
  if (request.workspaceId !== undefined && request.workspaceId !== identity.workspaceId) return false;
  if (request.fileKey !== undefined && request.fileKey !== identity.fileKey) return false;
  if (request.transactionId !== undefined && request.transactionId !== identity.transactionId) return false;
  if (request.filePath !== undefined && request.filePath !== identity.filePath) return false;
  return true;
}

function finishHold(reason: string): boolean {
  const current = held;
  if (!current) return false;
  held = null;
  // One-shot arm: any release consumes the pending arm.
  armed = null;
  window.clearTimeout(current.timer);
  if (current.poll !== null) window.clearInterval(current.poll);
  current.resolve(reason);
  return true;
}

/** Installs the QA-only gate. No-op when already installed. */
export function installSaveRaceProbe(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const control: SaveRaceGateControl = {
    arm(request) {
      if (!request || (request.stage !== "prepare" && request.stage !== "ack"
        && request.stage !== "watcher" && request.stage !== "fault")) {
        return { ok: false, reason: "unknown-stage" };
      }
      if (held) finishHold("rearm-release");
      armed = {
        ...request,
        timeoutMs: request.timeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS,
      };
      pushTrace({ event: "arm", ...armed });
      return { ok: true, stage: armed.stage };
    },
    status() {
      return {
        installed: true,
        nowMs: monotonicNow(),
        armed: armed
          ? {
            stage: armed.stage,
            workspaceId: armed.workspaceId,
            fileKey: armed.fileKey,
            transactionId: armed.transactionId,
            filePath: armed.filePath,
            mode: armed.mode,
            timeoutMs: armed.timeoutMs,
          }
          : null,
        held: held
          ? {
            stage: held.request.stage,
            workspaceId: held.request.workspaceId ?? "",
            fileKey: held.request.fileKey ?? "",
            transactionId: held.request.transactionId ?? "",
            filePath: held.request.filePath ?? "",
            enteredAtMs: held.enteredAtMs,
            enteredAgoMs: monotonicNow() - held.enteredAtMs,
          }
          : null,
      };
    },
    release(request) {
      const reason = request?.reason ?? "runner-release";
      return finishHold(reason)
        ? { ok: true }
        : { ok: false, reason: "nothing-held" };
    },
    note(request) {
      if (!request || typeof request.label !== "string" || request.label.length === 0) {
        return { ok: false };
      }
      pushTrace({ event: "note", detail: { label: request.label, value: request.value } });
      return { ok: true };
    },
    trace() {
      return traceEntries.map((entry) => ({ ...entry }));
    },
  };
  (window as unknown as { __taomniQaSaveGate?: SaveRaceGateControl }).__taomniQaSaveGate = control;
}

/** Test teardown only: removes the control object and clears probe state. */
export function uninstallSaveRaceProbe(): void {
  finishHold("probe-uninstalled");
  installed = false;
  armed = null;
  traceEntries.length = 0;
  traceSeq = 0;
  if (typeof window !== "undefined") {
    delete (window as unknown as { __taomniQaSaveGate?: unknown }).__taomniQaSaveGate;
  }
}

/**
 * Holds the named stage when (and only when) the QA control armed it for this
 * transaction. Resolves immediately in normal builds or for a non-matching
 * transaction, so production scheduling is unchanged.
 */
export async function holdSaveRaceStage(request: SaveRaceHoldRequest): Promise<void> {
  if (!installed || !armed || armed.stage !== request.stage) return;
  if (!identityMatches(armed, request)) return;
  const current = armed;
  // One-shot: consume the arm at enter so no later transaction is held.
  armed = null;
  await waitForArmedRelease(current, request.stage, {
    workspaceId: request.workspaceId,
    fileKey: request.fileKey,
    transactionId: request.transactionId,
    filePath: request.filePath,
  }, request.revision, request.stillValid);
}

/** Shared hold body: enter trace, then wait for release/timeout/owner poll. */
async function waitForArmedRelease(
  request: SaveRaceArmRequest & { timeoutMs: number },
  stage: SaveRaceStage,
  identity: Partial<SaveRaceHoldIdentity>,
  revision: (() => number | null) | undefined,
  stillValid: (() => boolean) | undefined,
): Promise<string> {
  const enteredAtMs = monotonicNow();
  pushTrace({
    event: "enter",
    stage,
    workspaceId: identity.workspaceId ?? request.workspaceId,
    fileKey: identity.fileKey ?? request.fileKey,
    transactionId: identity.transactionId ?? request.transactionId,
    filePath: identity.filePath ?? request.filePath,
    revision: revision?.() ?? null,
    detail: { enteredAtMs },
  });
  return await new Promise<string>((resolve) => {
    let settled = false;
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      if (held !== null && held.resolve === finish) held = null;
      window.clearTimeout(timer);
      if (poll !== null) window.clearInterval(poll);
      if (armed === request) armed = null;
      pushTrace({
        event: holdReleaseEvent(reason),
        stage,
        workspaceId: identity.workspaceId ?? request.workspaceId,
        fileKey: identity.fileKey ?? request.fileKey,
        transactionId: identity.transactionId ?? request.transactionId,
        filePath: identity.filePath ?? request.filePath,
        revision: revision?.() ?? null,
        detail: { reason, heldMs: monotonicNow() - enteredAtMs },
      });
      resolve(reason);
    };
    const timer = window.setTimeout(() => finish("timeout-release"), request.timeoutMs);
    const poll = stillValid
      ? window.setInterval(() => {
        if (!stillValid()) finish("owner-invalidated");
      }, OWNER_POLL_INTERVAL_MS)
      : null;
    held = {
      request: { ...request },
      enteredAtMs,
      resolve: finish,
      timer,
      poll,
    };
  });
}

/** Records a save-transaction timeline event when the probe is installed. */
export function recordSaveRaceEvent(
  event: SaveRaceTraceEvent,
  identity: SaveRaceHoldIdentity,
  detail?: Record<string, unknown>,
): void {
  if (!installed) return;
  pushTrace({ event, ...identity, detail });
}

function realWriteFacts(
  ack: WorkspaceWriteAck | null,
  error: unknown,
): {
  writtenHash?: string;
  writtenByteLength?: number;
  intentHash?: string;
  oldHash?: string;
  errorKind: string | null;
} {
  const typed = error instanceof WorkspaceWriteError ? error : null;
  return {
    writtenHash: ack?.writtenHash ?? typed?.writtenHash,
    writtenByteLength: ack?.writtenByteLength ?? typed?.writtenByteLength,
    intentHash: ack?.intentHash ?? ack?.writtenHash ?? typed?.intentHash,
    oldHash: ack?.oldHash ?? typed?.oldHash,
    errorKind: typed?.kind ?? (error ? "untyped" : null),
  };
}

/**
 * QA-controlled response fault at the write-transport boundary. The REAL
 * writer attempt already ran:
 * - `unknown-response` (default): a real success is reported to the committer
 *   as a typed unknown-effect failure carrying the real hashes.
 * - `unknown-response-delay`: the response (success or real typed failure) is
 *   withheld until the runner releases the `fault` hold, so the runner can
 *   mutate the real disk before the production read-back classification runs.
 * The production unknown-effect read-back path then runs unmodified; nothing
 * is fabricated besides the withheld response itself.
 */
export async function applySaveRaceWriteFault(
  filePath: string,
  ack: WorkspaceWriteAck | null,
  realError: unknown,
): Promise<WorkspaceWriteAck> {
  const passThrough = (): WorkspaceWriteAck => {
    if (realError) throw realError;
    return ack as WorkspaceWriteAck;
  };
  if (!installed || !armed || armed.stage !== "fault") return passThrough();
  if (armed.filePath !== undefined && armed.filePath !== filePath) return passThrough();
  const current = armed;
  armed = null;
  const mode = current.mode ?? "unknown-response";
  const facts = realWriteFacts(ack, realError);
  const detail = {
    mode,
    realOutcome: ack ? "acked" : "failed",
    writtenHash: facts.writtenHash ?? null,
    writtenByteLength: facts.writtenByteLength ?? null,
    intentHash: facts.intentHash ?? null,
    oldHash: facts.oldHash ?? null,
    realErrorKind: facts.errorKind,
  };
  if (mode === "unknown-response-delay") {
    pushTrace({ event: "fault-pending", stage: "fault", filePath, detail });
    await waitForArmedRelease(current, "fault", { filePath }, undefined, undefined);
  }
  pushTrace({ event: "fault-injected", stage: "fault", filePath, detail });
  throw new WorkspaceWriteError(
    "io",
    "QA controlled fault: the native write response was withheld to exercise unknown-effect read-back",
    undefined,
    undefined,
    "unknown",
    facts.writtenHash,
    facts.writtenByteLength,
    facts.intentHash,
    facts.writtenByteLength,
    facts.oldHash,
  );
}

// Self-install only in the isolated QA bundle; normal builds compile this to
// `if (false)` and expose no control object.
if (__TAOMNI_QA_SAVE_GATE__) {
  installSaveRaceProbe();
}
