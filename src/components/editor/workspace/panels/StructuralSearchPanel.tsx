import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Braces, ChevronDown, ChevronRight, Loader2, Search, X } from "lucide-react";
import {
  cancelStructuralSearch,
  searchStructuralDocuments,
  structuralSearchPattern,
  type StructuralSearchDocument,
  type StructuralSearchResult,
} from "../../../../lib/editor/structuralSearch";
import { workspaceListFilesRecursive, workspaceReadFile } from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import type { StructuralQuery } from "../companionCapabilities";

interface StructuralSearchPanelProps {
  roots: CodeWorkspaceRootInfo[];
  active?: boolean;
  activeFile?: { rootId: string; path: string; text: string; loading?: boolean } | null;
  focusNonce?: number;
  onOpenResult: (result: StructuralSearchResult) => void;
  onClose: () => void;
}

type Status = "idle" | "searching" | "done" | "cancelled" | "unavailable" | "error";

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `ssr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function collectJavaDocuments(
  roots: CodeWorkspaceRootInfo[],
  activeFile: StructuralSearchPanelProps["activeFile"],
  currentFileOnly: boolean,
  signal: AbortSignal,
): Promise<{ documents: StructuralSearchDocument[]; unavailable?: string; error?: string; cancelled?: boolean }> {
  const documents: StructuralSearchDocument[] = [];
  const rootsToRead = currentFileOnly && activeFile
    ? roots.filter((root) => root.id === activeFile.rootId)
    : roots;
  if (currentFileOnly && activeFile && rootsToRead.length === 0) {
    return { documents: [], unavailable: "The active file is outside this workspace" };
  }

  for (const root of rootsToRead) {
    if (signal.aborted) return { documents: [], cancelled: true };
    let entries;
    if (currentFileOnly && activeFile) {
      entries = [{ path: activeFile.path, fileType: "file" as const }];
    } else {
      const listed = await workspaceListFilesRecursive(root.path, "", 24, 2_000);
      if (signal.aborted) return { documents: [], cancelled: true };
      if (listed.state !== "ready") {
        return {
          documents: [],
          ...(listed.state === "unavailable"
            ? { unavailable: listed.reason }
            : { error: listed.state === "failed" ? listed.message : "File listing cancelled" }),
        };
      }
      entries = listed.entries;
    }
    const javaEntries = entries.filter((entry) => (
      entry.fileType === "file" && entry.path.toLowerCase().endsWith(".java")
    ));
    for (const entry of javaEntries) {
      if (signal.aborted) return { documents: [], cancelled: true };
      try {
        const file = await workspaceReadFile(root.path, entry.path);
        if (signal.aborted) return { documents: [], cancelled: true };
        documents.push({
          rootId: root.id,
          rootName: root.name,
          rootPath: root.path,
          path: entry.path,
          text: file.text,
        });
      } catch (error) {
        return { documents: [], error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  if (activeFile && !activeFile.loading) {
    const index = documents.findIndex((document) => (
      document.rootId === activeFile.rootId && document.path === activeFile.path
    ));
    const root = roots.find((item) => item.id === activeFile.rootId);
    if (root && activeFile.path.toLowerCase().endsWith(".java")) {
      const document: StructuralSearchDocument = {
        rootId: root.id,
        rootName: root.name,
        rootPath: root.path,
        path: activeFile.path,
        text: activeFile.text,
      };
      if (index === -1) documents.push(document);
      else documents[index] = document;
    }
  }
  return { documents };
}

export function StructuralSearchPanel({
  roots,
  active = true,
  activeFile = null,
  focusNonce = 0,
  onOpenResult,
  onClose,
}: StructuralSearchPanelProps) {
  const [pattern, setPattern] = useState(structuralSearchPattern());
  const [textConstraint, setTextConstraint] = useState("");
  const [scope, setScope] = useState<"workspace" | "file">("workspace");
  const [status, setStatus] = useState<Status>("idle");
  const [results, setResults] = useState<StructuralSearchResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [backend, setBackend] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<{ id: string; controller: AbortController } | null>(null);

  useEffect(() => {
    if (focusNonce > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusNonce]);

  const grouped = useMemo(() => {
    const groups = new Map<string, StructuralSearchResult[]>();
    for (const result of results) {
      const key = `${result.rootId}:${result.path}`;
      const current = groups.get(key);
      if (current) current.push(result);
      else groups.set(key, [result]);
    }
    return [...groups.entries()];
  }, [results]);

  const cancel = useCallback(() => {
    const request = requestRef.current;
    if (!request) return;
    request.controller.abort();
    void cancelStructuralSearch(request.id).catch(() => {});
    requestRef.current = null;
    setStatus("cancelled");
    setMessage(null);
  }, []);

  useEffect(() => {
    if (!active) cancel();
  }, [active, cancel]);

  useEffect(() => () => {
    const request = requestRef.current;
    request?.controller.abort();
    if (request) void cancelStructuralSearch(request.id).catch(() => {});
  }, []);

  const search = useCallback(async () => {
    cancel();
    const requestId = newRequestId();
    const controller = new AbortController();
    requestRef.current = { id: requestId, controller };
    setStatus("searching");
    setMessage(null);
    setBackend(null);
    setResults([]);
    setExpandedFiles(new Set());
    const query: StructuralQuery = {
      schemaVersion: 1,
      languageId: "java",
      pattern,
      variables: {
        arg: {
          minCount: 1,
          maxCount: 1,
          ...(textConstraint.trim() ? { text: textConstraint.trim() } : {}),
        },
      },
      scope,
    };
    try {
      const loaded = await collectJavaDocuments(roots, activeFile, scope === "file", controller.signal);
      if (controller.signal.aborted || requestRef.current?.id !== requestId) return;
      if (loaded.cancelled) {
        setStatus("cancelled");
        return;
      }
      if (loaded.unavailable) {
        setStatus("unavailable");
        setMessage(loaded.unavailable);
        return;
      }
      if (loaded.error) {
        setStatus("error");
        setMessage(loaded.error);
        return;
      }
      const response = await searchStructuralDocuments({ query, documents: loaded.documents, requestId });
      if (controller.signal.aborted || requestRef.current?.id !== requestId) return;
      if (response.kind === "ready") {
        setStatus("done");
        setBackend(response.backend);
        setResults(response.results);
        setMessage(null);
        return;
      }
      if (response.kind === "unavailable") {
        setStatus("unavailable");
        setMessage(response.reason);
        setBackend(response.backend ?? null);
        return;
      }
      if (response.kind === "cancelled") {
        setStatus("cancelled");
        return;
      }
      setStatus("error");
      setMessage(response.message);
    } catch (error) {
      if (controller.signal.aborted || requestRef.current?.id !== requestId) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestRef.current?.id === requestId) requestRef.current = null;
    }
  }, [activeFile, cancel, pattern, roots, scope, textConstraint]);

  const statusLabel = status === "searching"
    ? "Searching…"
    : status === "cancelled"
      ? "Search cancelled"
    : status === "unavailable"
      ? "Unavailable"
      : status === "error"
        ? "Search failed"
        : status === "done"
          ? `${results.length} result${results.length === 1 ? "" : "s"}`
          : "Ready";

  return (
    <section
      className="h-full min-h-0 flex flex-col bg-[var(--taomni-code-bg)] text-[var(--taomni-code-text)]"
      data-testid="structural-search-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (status === "searching") cancel();
          else {
            cancel();
            onClose();
          }
        }
      }}
    >
      <header className="h-10 shrink-0 flex items-center gap-2 border-b border-[var(--taomni-code-border)] px-3">
        <Braces className="h-4 w-4 text-[var(--taomni-accent)]" />
        <span className="font-semibold text-xs">Structural Search</span>
        <span className="text-[10px] text-[var(--taomni-code-muted)]">Java AST</span>
        <span className="flex-1" />
        <button type="button" className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-code-active-line-bg)]" aria-label="Close structural search" title="Close structural search" onClick={() => { cancel(); onClose(); }}>
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="shrink-0 grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_150px_150px_auto] gap-2 border-b border-[var(--taomni-code-border)] p-2">
        <label className="min-w-0">
          <span className="sr-only">Structural search pattern</span>
          <input
            ref={inputRef}
            data-testid="structural-search-pattern"
            className="taomni-input h-8 w-full font-mono text-xs"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            placeholder="Java template"
            spellCheck={false}
          />
        </label>
        <label className="min-w-0">
          <span className="sr-only">Text constraint for arg</span>
          <input
            data-testid="structural-search-text"
            className="taomni-input h-8 w-full text-xs"
            value={textConstraint}
            onChange={(event) => setTextConstraint(event.target.value)}
            placeholder="Text: $arg$"
          />
        </label>
        <label className="min-w-0">
          <span className="sr-only">Structural search scope</span>
          <select data-testid="structural-search-scope" className="taomni-input h-8 w-full text-xs" value={scope} onChange={(event) => setScope(event.target.value as "workspace" | "file")}>
            <option value="workspace">In Project</option>
            <option value="file">Current File</option>
          </select>
        </label>
        {status === "searching" ? (
          <button type="button" className="taomni-btn h-8 px-2 inline-flex items-center gap-1" onClick={cancel} data-testid="structural-search-cancel">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cancel
          </button>
        ) : (
          <button type="button" className="taomni-btn h-8 px-2 inline-flex items-center gap-1" onClick={() => void search()} data-testid="structural-search-submit">
            <Search className="h-3.5 w-3.5" /> Search
          </button>
        )}
      </div>
      <div className="h-7 shrink-0 flex items-center gap-2 px-3 text-[10px] text-[var(--taomni-code-muted)]" data-testid="structural-search-status">
        <span>{statusLabel}</span>
        {backend ? <span>· {backend}</span> : null}
        {message ? <span className="truncate text-amber-400">· {message}</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="structural-search-results">
        {status === "done" && results.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-[var(--taomni-code-muted)]" data-testid="structural-search-empty">
            No structural matches
          </div>
        ) : grouped.map(([key, fileResults]) => {
          const first = fileResults[0]!;
          const expanded = expandedFiles.has(key);
          return (
            <section key={key} className="border-b border-[var(--taomni-code-border)]/60">
              <button
                type="button"
                className="w-full h-8 flex items-center gap-1.5 px-3 text-left text-xs hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={() => setExpandedFiles((current) => {
                  const next = new Set(current);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })}
                data-testid="structural-search-file"
                data-path={first.path}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                <span className="truncate font-medium">{first.rootName}/{first.path}</span>
                <span className="ml-auto text-[10px] text-[var(--taomni-code-muted)]">{fileResults.length}</span>
              </button>
              {expanded ? fileResults.map((result) => (
                <button
                  type="button"
                  key={`${result.from}:${result.to}`}
                  className="w-full flex items-start gap-2 px-8 py-1.5 text-left text-[11px] hover:bg-[var(--taomni-code-selection-match-bg)]"
                  data-testid="structural-search-result"
                  data-path={result.path}
                  onClick={() => onOpenResult(result)}
                >
                  <span className="w-12 shrink-0 text-right tabular-nums text-[var(--taomni-code-muted)]">{result.line}:{result.column + 1}</span>
                  <code className="min-w-0 truncate">{result.preview}</code>
                </button>
              )) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}
