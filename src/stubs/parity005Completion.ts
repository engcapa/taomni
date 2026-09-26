import type {
  LspCompletionItem,
  LspCompletionResolveResult,
  LspCompletionResult,
  LspDocumentStatus,
  LspRange,
} from "../lib/editor/lsp";
import { recentCompletionInvocations, recentCompletionTelemetry } from "../components/editor/workspace/lspCompletion";
import { completionStatus } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { useProjectFactsStore, type WorkspaceProjectFactsEntry } from "../stores/projectFactsStore";

const root = "/preview/parity005";
const enabledKey = "taomni.qa.parity005.enabled";
const modeKey = "taomni.qa.parity005.mode";

type Phase = "fetch" | "resolve";
type Pending = { phase: Phase; release: () => void };
const pending: Pending[] = [];
const events: Array<{
  phase: Phase;
  path: string;
  mode: string;
  identity: string;
  ordinal: number | null;
  requestedScope: string | null;
}> = [];
let readyFacts: WorkspaceProjectFactsEntry | null = null;

function mode(): string {
  try { return JSON.parse(localStorage.getItem(modeKey) ?? '"normal"') as string; }
  catch { return "normal"; }
}

export function parity005Enabled(path?: string): boolean {
  try {
    return localStorage.getItem(enabledKey) === "true" && (path === undefined || path.startsWith(`${root}/`));
  } catch { return false; }
}

function hold<T>(phase: Phase, result: () => T): Promise<T> {
  return new Promise((resolve) => pending.push({ phase, release: () => resolve(result()) }));
}

declare global {
  interface Window {
    __taomniQaParity005?: {
      observe: () => {
        events: typeof events;
        pending: Phase[];
        invocations: ReturnType<typeof recentCompletionInvocations>;
        telemetry: ReturnType<typeof recentCompletionTelemetry>;
        editor: { status: string | null; caret: number; focused: boolean } | null;
        facts: { status: string; generation: number; isStale: boolean; reason: string | null };
      };
      setMode: (value: string) => void;
      setFactsStatus: (value: "ready" | "loading" | "degraded" | "failed" | "stale") => number;
      release: (phase: Phase) => number;
    };
  }
}

if (typeof window !== "undefined") {
  window.__taomniQaParity005 = {
    observe: () => ({
      events: [...events],
      pending: pending.map((entry) => entry.phase),
      invocations: recentCompletionInvocations(),
      telemetry: recentCompletionTelemetry(),
      editor: (() => {
        const content = document.querySelector<HTMLElement>('[data-testid="code-workspace-editor"] .cm-content');
        const view = content ? EditorView.findFromDOM(content) : null;
        return view ? {
          status: completionStatus(view.state),
          caret: view.state.selection.main.head,
          focused: view.hasFocus,
        } : null;
      })(),
      facts: (() => {
        const entry = useProjectFactsStore.getState().getWorkspaceFacts(root);
        return { status: entry.status, generation: entry.generation, isStale: entry.isStale, reason: entry.reason };
      })(),
    }),
    setMode: (value) => localStorage.setItem(modeKey, JSON.stringify(value)),
    setFactsStatus: (value) => {
      if (!parity005Enabled(`${root}/src/main/java/parity005/Main.java`)) return -1;
      const current = useProjectFactsStore.getState().getWorkspaceFacts(root);
      if (current.status === "ready" && !current.isStale) readyFacts = current;
      const base = value === "ready" ? readyFacts ?? current : current;
      const generation = current.generation + 1;
      useProjectFactsStore.setState((state) => ({
        workspaces: {
          ...state.workspaces,
          [root]: {
            ...base,
            generation,
            status: value === "stale" ? "ready" : value,
            reason: value === "ready" ? null : `B-005 controlled facts ${value}`,
            isStale: value === "stale",
            abortController: null,
          },
        },
      }));
      return generation;
    },
    release: (phase) => {
      const entries = pending.filter((entry) => entry.phase === phase);
      for (const entry of entries) {
        pending.splice(pending.indexOf(entry), 1);
        entry.release();
      }
      return entries.length;
    },
  };
}

function range(line: number, from: number, to: number): LspRange {
  return { start: { line, character: from }, end: { line, character: to } };
}

export function parity005Status(path: string): LspDocumentStatus {
  return {
    path,
    uri: `file://${path}`,
    presetId: "java",
    languageId: "java",
    displayName: "Java (B-005 fixture)",
    available: true,
    active: true,
    semanticReady: true,
    selectedCommandId: "parity005-controlled",
    selectedCommand: null,
    installHint: null,
    error: null,
  };
}

function candidate(path: string, variant = 0): LspCompletionItem {
  const mid = path.endsWith("/Mid.java");
  const emptyPlaceholder = !mid && mode() === "empty-placeholder";
  const identity = mid ? "parity005-mid-1" : emptyPlaceholder ? "parity005-empty-1"
    : variant === 1 ? "parity005-buffer-2" : variant === 2 ? "parity005-joiner-3" : "parity005-combined-1";
  const label = mid ? "StringUtils" : variant === 1 ? "StringBuffer" : variant === 2 ? "StringJoiner" : "StringBuilder";
  const newText = mid ? "StringUtils" : variant > 0 ? label
    : emptyPlaceholder ? "StringBuilder(${1:})$0" : 'StringBuilder(${1:"x"}, ${2:1})$0';
  const insert = mid ? range(4, 8, 17) : range(4, 8, 12);
  const replace = mid ? range(4, 8, 23) : insert;
  return {
    label, kind: 7, detail: mid ? "org.apache.commons.lang3.StringUtils"
      : variant === 2 ? "java.util.StringJoiner" : `java.lang.${label}`,
    documentation: `B-005 controlled completion: ${identity}`,
    insertText: newText, insertTextFormat: mid || variant > 0 ? 1 : 2,
    filterText: label, sortText: `000${variant + 1}`,
    textEdit: { range: insert, newText },
    insertReplaceEdit: mid ? { insert, replace, newText } : null,
    additionalTextEdits: [],
    raw: { label, data: { parity005Identity: identity, path } },
  };
}

function resolvedCandidate(path: string, raw?: unknown): LspCompletionItem {
  const mid = path.endsWith("/Mid.java");
  const identity = (raw as { data?: { parity005Identity?: string } } | null)?.data?.parity005Identity;
  const variant = identity === "parity005-buffer-2" ? 1 : identity === "parity005-joiner-3" ? 2 : 0;
  return {
    ...candidate(path, variant),
    additionalTextEdits: [{
      range: range(1, 0, 0),
      newText: mid
        ? "import org.apache.commons.lang3.StringUtils;\n"
        : variant === 2 ? "import java.util.StringJoiner;\n"
          : variant === 1 ? "import java.lang.StringBuffer;\n" : "import java.lang.StringBuilder;\n",
    }],
  };
}

export function parity005Completion(
  path: string,
  request?: { invocationOrdinal?: number; requestedScope?: string },
): Promise<LspCompletionResult> | LspCompletionResult {
  const currentMode = mode();
  const mid = path.endsWith("/Mid.java");
  events.push({
    phase: "fetch", path, mode: currentMode,
    identity: mid ? "parity005-mid-1" : "parity005-combined-1",
    ordinal: request?.invocationOrdinal ?? null,
    requestedScope: request?.requestedScope ?? null,
  });
  const result = (): LspCompletionResult => ({
    status: parity005Status(path),
    isIncomplete: false,
    items: mode() === "empty" ? [] : mid || currentMode !== "normal"
      ? [candidate(path)] : [candidate(path), candidate(path, 1), candidate(path, 2)],
  });
  return currentMode === "fetch-hold" ? hold("fetch", result) : result();
}

export function parity005Resolve(path: string, raw?: unknown): Promise<LspCompletionResolveResult> | LspCompletionResolveResult {
  const currentMode = mode();
  const mid = path.endsWith("/Mid.java");
  const identity = (raw as { data?: { parity005Identity?: string } } | null)?.data?.parity005Identity;
  events.push({
    phase: "resolve", path, mode: currentMode,
    identity: identity ?? (mid ? "parity005-mid-1" : "parity005-combined-1"),
    ordinal: null, requestedScope: null,
  });
  const result = (): LspCompletionResolveResult => {
    const selected = mode();
    if (selected === "resolve-null") return { kind: "unavailable", reason: "resolver-returned-null" };
    if (selected === "resolve-error") return { kind: "failed", message: "B-005 controlled provider error" };
    if (selected === "resolve-timeout") return { kind: "timeout" };
    if (selected === "resolve-overlap") {
      const item = resolvedCandidate(path, raw);
      item.additionalTextEdits = [{ range: item.textEdit!.range, newText: "overlap" }];
      return { kind: "resolved", item };
    }
    if (selected === "resolve-invalid") {
      const item = resolvedCandidate(path, raw);
      item.textEdit = { range: range(400, 8, 12), newText: item.textEdit!.newText };
      return { kind: "resolved", item };
    }
    return { kind: "resolved", item: resolvedCandidate(path, raw) };
  };
  return currentMode === "resolve-hold" ? hold("resolve", result) : result();
}

export const parity005Root = root;
