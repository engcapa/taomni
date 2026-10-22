import { type WorkspaceFile } from "./model";

export type WorkspaceWriteErrorKind = "hash-mismatch" | "encoding" | "permission" | "io";

/**
 * Native disk-effect fact on a typed write error (§8.18.1). `none` proves the
 * target bytes were untouched; `unknown` means the bridge cannot prove whether
 * the replace happened and the caller must re-read/verify before retrying.
 */
export type WorkspaceWriteEffect = "none" | "unknown";

export interface WorkspaceWriteErrorData {
  kind: WorkspaceWriteErrorKind;
  message: string;
  expectedHash?: string;
  actualHash?: string;
  effect?: WorkspaceWriteEffect;
  /** Set when bytes provably landed but the decoded read-back failed. */
  writtenHash?: string;
  writtenByteLength?: number;
  /**
   * §8.19.1 unified fact model: SHA-256 of exactly the encoded bytes the
   * native writer intended to put on disk. Present on every byte-writer
   * failure after encoding succeeded, so an `unknown`-effect failure can
   * still record a non-null intended hash in the recovery ledger.
   */
  intentHash?: string;
  intentByteLength?: number;
  /** Pre-mutation target bytes hash observed by the native writer. */
  oldHash?: string;
}

/** Success response of the encoded byte writers (native write ack). */
export interface WorkspaceWriteAck {
  file: WorkspaceFile;
  writtenHash: string;
  writtenByteLength: number;
  /** §8.19.1: equals `writtenHash` on success (native always sends it). */
  intentHash?: string;
  /** Pre-mutation target bytes hash observed by the writer; null for creates. */
  oldHash?: string | null;
  atomicReplaceUsed: boolean;
}

export class WorkspaceWriteError extends Error implements WorkspaceWriteErrorData {
  readonly kind: WorkspaceWriteErrorKind;
  readonly expectedHash?: string;
  readonly actualHash?: string;
  readonly effect?: WorkspaceWriteEffect;
  readonly writtenHash?: string;
  readonly writtenByteLength?: number;
  readonly intentHash?: string;
  readonly intentByteLength?: number;
  readonly oldHash?: string;

  constructor(
    kind: WorkspaceWriteErrorKind,
    message: string,
    expectedHash?: string,
    actualHash?: string,
    effect?: WorkspaceWriteEffect,
    writtenHash?: string,
    writtenByteLength?: number,
    intentHash?: string,
    intentByteLength?: number,
    oldHash?: string,
  ) {
    super(message);
    this.name = "WorkspaceWriteError";
    this.kind = kind;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
    this.effect = effect;
    this.writtenHash = writtenHash;
    this.writtenByteLength = writtenByteLength;
    this.intentHash = intentHash;
    this.intentByteLength = intentByteLength;
    this.oldHash = oldHash;
    Object.setPrototypeOf(this, WorkspaceWriteError.prototype);
  }
}

export class WorkspaceHashMismatchError extends WorkspaceWriteError {
  readonly expected: string;
  readonly actual: string;

  constructor(message: string, expected = "", actual = "") {
    super("hash-mismatch", message, expected, actual);
    this.name = "WorkspaceHashMismatchError";
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, WorkspaceHashMismatchError.prototype);
  }
}

export function isWorkspaceHashMismatchError(err: unknown): boolean {
  if (err instanceof WorkspaceHashMismatchError) return true;
  if (err instanceof WorkspaceWriteError && err.kind === "hash-mismatch") return true;
  if (typeof err === "object" && err !== null && (err as { kind?: string; }).kind === "hash-mismatch") return true;
  if (err instanceof Error && err.message.startsWith("hash-mismatch:")) return true;
  return false;
}

export function parseWorkspaceWriteError(err: unknown): WorkspaceWriteError {
  if (err instanceof WorkspaceWriteError) return err;
  const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown; }).message) : String(err));
  const match = msg.match(/expected hash\s+([^\s,;]+)[,\s]+found\s+([^\s,;]+)/i);

  if (isWorkspaceHashMismatchError(err)) {
    if (err instanceof WorkspaceHashMismatchError) return err;
    const exp = (err as { expectedHash?: string; expected?: string; })?.expectedHash ?? (err as { expected?: string; })?.expected ?? match?.[1];
    const act = (err as { actualHash?: string; actual?: string; })?.actualHash ?? (err as { actual?: string; })?.actual ?? match?.[2];
    return new WorkspaceHashMismatchError(msg, exp ?? "", act ?? "");
  }
  if (typeof err === "object" && err !== null) {
    const raw = err as Record<string, unknown>;
    const kind = typeof raw.kind === "string" ? raw.kind : undefined;
    const message = typeof raw.message === "string" ? raw.message : msg;
    const effect = raw.effect === "none" || raw.effect === "unknown" ? raw.effect : undefined;
    const writtenHash = typeof raw.writtenHash === "string" ? raw.writtenHash : undefined;
    const writtenByteLength = typeof raw.writtenByteLength === "number" ? raw.writtenByteLength : undefined;
    const intentHash = typeof raw.intentHash === "string" ? raw.intentHash : undefined;
    const intentByteLength = typeof raw.intentByteLength === "number" ? raw.intentByteLength : undefined;
    const oldHash = typeof raw.oldHash === "string" ? raw.oldHash : undefined;
    if (kind === "hash-mismatch" || kind === "encoding" || kind === "permission" || kind === "io") {
      if (kind === "hash-mismatch") {
        return new WorkspaceHashMismatchError(message, String(raw.expectedHash ?? match?.[1] ?? ""), String(raw.actualHash ?? match?.[2] ?? ""));
      }
      return new WorkspaceWriteError(kind, message, undefined, undefined, effect, writtenHash, writtenByteLength, intentHash, intentByteLength, oldHash);
    }
  }
  if (msg.startsWith("hash-mismatch:")) {
    return new WorkspaceHashMismatchError(msg, match?.[1] ?? "", match?.[2] ?? "");
  }
  if (msg.includes("not representable") || msg.includes("encoding")) {
    return new WorkspaceWriteError("encoding", msg);
  }
  if (msg.includes("permission denied") || msg.includes("PermissionDenied")) {
    return new WorkspaceWriteError("permission", msg);
  }
  return new WorkspaceWriteError("io", msg);
}
