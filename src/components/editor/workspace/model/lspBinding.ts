import { type LspFileState } from "./types";

export function lspPresetIdForPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lower)) return "typescript-javascript";
  if (lower.endsWith(".rs")) return "rust";
  if (/\.(py|pyi)$/.test(lower)) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (/\.(c|h|cc|cpp|cxx|hpp|hh|hxx)$/.test(lower)) return "cpp";
  if (/\.(kt|kts)$/.test(lower)) return "kotlin";
  if (/\.(scala|sc)$/.test(lower)) return "scala";
  if (/\.(cs|csx)$/.test(lower)) return "csharp";
  if (lower.endsWith(".swift")) return "swift";
  return null;
}

/**
 * Whether *typing* should schedule didOpen/didChange IPC.
 * - Active session → didChange (incremental).
 * - Open already in flight (syncing) → coalesce the latest buffer into the queue
 *   so the server is not left on a stale snapshot when startup finishes mid-type.
 * - No preset / unavailable / idle inactive → never (file-focus probe owns start).
 */
export function shouldLiveSyncLsp(
  languagePath: string,
  state: LspFileState | null | undefined,
): boolean {
  if (!lspPresetIdForPath(languagePath)) return false;
  if (state?.status?.active) return true;
  // Mid-open: keep feeding the sync queue with the latest buffer.
  if (state?.syncing) return true;
  return false;
}

/**
 * Whether the editor may probe didOpen / start a session for this buffer
 * (file focus, first open). Blocks permanently-unavailable presets.
 */
export function shouldProbeLsp(
  languagePath: string,
  state: LspFileState | null | undefined,
): boolean {
  if (!lspPresetIdForPath(languagePath)) return false;
  const status = state?.status;
  if (!status) return true;
  if (status.active) return true;
  if (!status.available) return false;
  // available && !active (exited / still starting): allow a focus-driven probe
  // but sticky start errors wait for Settings / prefs refresh.
  if (state?.error && !state.syncing) return false;
  return true;
}

/** True when completion/signature/hover should hit the language server. */
export function isLspFeatureReady(state: LspFileState | null | undefined): boolean {
  return !!state?.status?.active;
}

export function emptyLspFileState(): LspFileState {
  return {
    status: null,
    diagnostics: [],
    diagnosticScope: null,
    syncing: false,
    syncedText: null,
    error: null,
    errorGeneration: 0,
  };
}
