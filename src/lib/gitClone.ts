/**
 * Workspace Git clone IPC and form model.
 *
 * The Rust `git/clone.rs` module owns Git, the vault and the filesystem. This
 * module keeps renderer-side types and deterministic validation/derivation so
 * the dialog, store and tests share one contract.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface GitCloneDefaults {
  gitAvailable: boolean;
  gitVersion: string | null;
  userName: string | null;
  userEmail: string | null;
  defaultBranch: string;
  cloneRoot: string;
  appProxyEnabled: boolean;
  appProxyUrl: string | null;
  appProxyError: string | null;
  vaultState: "empty" | "locked" | "unlocked" | string;
  savedTokenAvailable: boolean;
}

export interface GitCloneProbeRequest {
  url: string;
  proxyMode: GitCloneProxyMode;
  httpProxy?: string | null;
  httpsProxy?: string | null;
  token?: string | null;
  tokenUsername?: string | null;
  useSavedToken: boolean;
}

export interface GitCloneProbeResult {
  defaultBranch: string | null;
  headOid: string | null;
  branches: string[];
}

export type GitCloneProxyMode = "app" | "custom" | "none";

export interface GitCloneRequest {
  taskId: string;
  url: string;
  destination: string;
  workspaceName: string;
  branch?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  proxyMode: GitCloneProxyMode;
  httpProxy?: string | null;
  httpsProxy?: string | null;
  token?: string | null;
  tokenUsername?: string | null;
  useSavedToken: boolean;
  rememberToken: boolean;
}

export interface GitCloneResult {
  taskId: string;
  destination: string;
  repoRoot: string;
  branch: string | null;
  defaultBranch: string | null;
  headOid: string | null;
  remoteUrl: string;
  durationMs: number;
  tokenRemembered: boolean;
}

export type GitClonePhase =
  | "preparing"
  | "connecting"
  | "counting"
  | "receiving"
  | "resolving"
  | "updating"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface GitCloneProgress {
  taskId: string;
  phase: GitClonePhase;
  percent: number | null;
  indeterminate: boolean;
  message: string;
  objectsDone: number | null;
  objectsTotal: number | null;
}

export type GitCloneUrlError = "required" | "invalid" | "credentials" | "whitespace";
export type GitCloneBranchError = "invalid";
export type GitCloneNameError = "required" | "invalid";

export function gitCloneDefaults(): Promise<GitCloneDefaults> {
  return invoke<GitCloneDefaults>("git_clone_defaults");
}

export function gitCloneProbe(request: GitCloneProbeRequest): Promise<GitCloneProbeResult> {
  return invoke<GitCloneProbeResult>("git_clone_probe", { request });
}

export function gitCloneRepository(request: GitCloneRequest): Promise<GitCloneResult> {
  return invoke<GitCloneResult>("git_clone_repository", { request });
}

export function gitCloneCancel(taskId: string): Promise<void> {
  return invoke("git_clone_cancel", { taskId });
}

/** One module-level listener per renderer; the store filters by task id. */
export function listenGitCloneProgress(
  callback: (progress: GitCloneProgress) => void,
): Promise<UnlistenFn> {
  return listen<GitCloneProgress>("git-clone-progress", (event) => callback(event.payload));
}

export function newGitCloneTaskId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `git-clone-${crypto.randomUUID()}`;
  }
  return `git-clone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

function looksLikeScpUrl(value: string): boolean {
  if (value.includes("://")) return false;
  const index = value.indexOf(":");
  if (index <= 0) return false;
  const authority = value.slice(0, index);
  const path = value.slice(index + 1);
  return authority.includes("@") && !authority.includes("/") && path.length > 0 && !path.startsWith("//");
}

/** Best effort workspace name from a remote/local clone URL. */
export function deriveRepoNameFromUrl(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "repository";
  let candidate = "";
  if (trimmed.includes("://")) {
    try {
      const url = new URL(trimmed);
      const path = url.pathname.replace(/[\\/]+$/, "");
      candidate = path.split(/[\\/]/).pop() ?? "";
      candidate = decodeURIComponent(candidate);
    } catch {
      candidate = trimmed.split(/[\\/]/).pop() ?? "";
    }
  } else if (looksLikeScpUrl(trimmed)) {
    candidate = trimmed.slice(trimmed.indexOf(":") + 1).split("/").filter(Boolean).pop() ?? "";
  } else {
    candidate = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
  }
  candidate = candidate.replace(/\.git$/i, "").trim();
  return candidate || "repository";
}

export function validateCloneUrl(value: string): GitCloneUrlError | null {
  const trimmed = value.trim();
  if (!trimmed) return "required";
  if (trimmed.startsWith("-") || /[\u0000-\u001f\u007f]/.test(trimmed)) return "invalid";
  if (isAbsolutePath(trimmed) && !trimmed.includes("://") && !looksLikeScpUrl(trimmed)) {
    return null;
  }
  if (looksLikeScpUrl(trimmed)) {
    return /\s/.test(trimmed) ? "whitespace" : null;
  }
  if (/\s/.test(trimmed)) return "whitespace";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "invalid";
  }
  if (!["http:", "https:", "ssh:", "git:", "file:"].includes(parsed.protocol)) return "invalid";
  if ((parsed.protocol === "http:" || parsed.protocol === "https:")
    && (parsed.username || parsed.password)) {
    return "credentials";
  }
  if (parsed.protocol !== "file:" && !parsed.hostname) return "invalid";
  return null;
}

export function validateBranchName(value: string): GitCloneBranchError | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith("-")
    || trimmed.startsWith("/")
    || trimmed.endsWith("/")
    || trimmed.endsWith(".")
    || trimmed.includes("..")
    || trimmed.includes("@{")
    || trimmed.includes("//")
    || /[\s~^:?*[\]\\]/.test(trimmed)
    || /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return "invalid";
  }
  return null;
}

export function validateWorkspaceName(value: string): GitCloneNameError | null {
  const trimmed = value.trim();
  if (!trimmed) return "required";
  if (trimmed.length > 120) return "invalid";
  if (/[\\/]/.test(trimmed) || trimmed.includes("..") || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return "invalid";
  }
  return null;
}

/** Display-only destination preview. The backend owns real path semantics. */
export function joinClonePath(parent: string, name: string): string {
  const trimmedParent = parent.trim().replace(/[\\/]+$/, "");
  if (!trimmedParent) return name.trim();
  const windows = /^[A-Za-z]:[\\/]/.test(trimmedParent) || trimmedParent.startsWith("\\\\");
  const normalizedParent = windows
    ? trimmedParent.replace(/\//g, "\\")
    : trimmedParent;
  const separator = windows ? "\\" : "/";
  return `${normalizedParent}${separator}${name.trim()}`;
}

export function isAbsoluteClonePath(value: string): boolean {
  return isAbsolutePath(value.trim());
}

export function clonePhaseTitleKey(phase: GitClonePhase | "cancelling" | "idle"): string {
  switch (phase) {
    case "preparing":
      return "gitClone.phasePreparing";
    case "connecting":
      return "gitClone.phaseConnecting";
    case "counting":
      return "gitClone.phaseCounting";
    case "receiving":
      return "gitClone.phaseReceiving";
    case "resolving":
      return "gitClone.phaseResolving";
    case "updating":
      return "gitClone.phaseUpdating";
    case "finalizing":
      return "gitClone.phaseFinalizing";
    case "completed":
      return "gitClone.phaseCompleted";
    case "failed":
      return "gitClone.phaseFailed";
    case "cancelled":
      return "gitClone.phaseCancelled";
    case "cancelling":
      return "gitClone.phaseCancelling";
    default:
      return "gitClone.phaseIdle";
  }
}
