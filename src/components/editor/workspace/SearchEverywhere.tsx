import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Braces, Command as CommandIcon, File, Type } from "lucide-react";
import { QuickPickOverlay } from "./QuickPickOverlay";
import { rankFuzzy } from "./fuzzyMatch";
import { isClassSymbolKind, symbolKindLabel } from "./symbolKinds";
import type { ActionResult } from "./workspaceActionRegistry";
import type { ActionSnapshotItem } from "./workspaceActionHost";
import {
  workspaceSemanticIndexBuildIsCurrent,
  workspaceSemanticIndexStatusLabel,
  type WorkspaceSemanticIndexSnapshot,
} from "./workspaceSemanticIndex";

export interface GoToFileItem {
  rootId: string;
  rootName: string;
  path: string;
}

export interface GoToSymbolItem {
  name: string;
  kind: number;
  containerName: string | null;
  path: string;
  uri: string;
  line: number;
  character: number;
  resolved: boolean;
  resolveToken: string | null;
}

export interface GoToSymbolQueryResult {
  symbols: GoToSymbolItem[];
  semanticGeneration: number | null;
  semanticRevision: number | null;
  sessionCount: number;
  providerCount: number;
  skippedProviderCount: number;
  failedProviderCount: number;
  complete: boolean;
  truncated: boolean;
  diagnostics: string[];
}

export type SearchEverywhereMode = "all" | "classes" | "files" | "symbols" | "actions" | "text";

interface SearchEverywhereProps {
  open: boolean;
  initialMode?: SearchEverywhereMode;
  items: GoToFileItem[];
  loading: boolean;
  truncated?: boolean;
  /**
   * Instance-scoped host snapshot (§8.17.3): the ONLY actions input. The
   * legacy WorkspaceCommand[] migration adapter is gone; execution goes
   * through the same frozen evaluations via onRunCommand.
   */
  actionSnapshots: ActionSnapshotItem[];
  /** When true, Classes/Symbols tabs are shown and fetchSymbols is used. */
  symbolsAvailable?: boolean;
  semanticIndex?: WorkspaceSemanticIndexSnapshot;
  fetchSymbols?: (query: string) => Promise<GoToSymbolQueryResult>;
  onClose: () => void;
  onOpenFile: (item: GoToFileItem, options?: { split: boolean }) => void;
  onOpenSymbol?: (item: GoToSymbolItem, options?: { split: boolean }) => void;
  onRunCommand?: (commandId: string) => void | Promise<ActionResult>;
  /** ED-PARITY-013 DEC-013-03: Alt+Enter on an action = Assign Shortcut. */
  onAssignShortcut?: (commandId: string) => void;
  /** Text tab: hand query to Find in Files. */
  onSearchText?: (query: string) => void;
}

const MAX_RESULTS = 50;

type SearchItem =
  | { kind: "file"; value: GoToFileItem }
  | { kind: "action"; value: ActionSnapshotItem }
  | { kind: "symbol"; value: GoToSymbolItem };

function searchItemText(item: SearchItem): string {
  if (item.kind === "file") return `${item.value.rootName}/${item.value.path}`;
  if (item.kind === "action") {
    return `${item.value.category} ${item.value.title} ${item.value.keywords?.join(" ") ?? ""}`;
  }
  return `${item.value.name} ${item.value.containerName ?? ""} ${item.value.path}`;
}

/**
 * IDEA-style action match for the All tab: every query word must occur in the
 * action title or keywords. Scattered-letter fuzzy matching let "total" pull
 * in "Move to Line Start".
 */
export function actionMatchesQuery(query: string, action: Pick<ActionSnapshotItem, "title" | "keywords">): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${action.title} ${action.keywords?.join(" ") ?? ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * ED-PARITY-014 DEC-014-01: All ranks each contributor on its own and lists
 * symbols, then files, then actions (IDEA order); actions only when their
 * words match the query.
 */
export function rankAllModeItems(query: string, all: SearchItem[]): SearchItem[] {
  if (!query.trim()) return all.slice(0, MAX_RESULTS);
  const symbols = rankFuzzy(query, all.filter((item) => item.kind === "symbol"), searchItemText, MAX_RESULTS);
  const files = rankFuzzy(query, all.filter((item) => item.kind === "file"), searchItemText, MAX_RESULTS);
  const actions = rankFuzzy(
    query,
    all.filter((item) => item.kind === "action" && actionMatchesQuery(query, item.value)),
    searchItemText,
    MAX_RESULTS,
  );
  return [...symbols, ...files, ...actions].slice(0, MAX_RESULTS);
}

function selectedItemPath(item: SearchItem | null): string {
  if (!item) return "";
  if (item.kind === "file") return `${item.value.rootName}/${item.value.path}`;
  if (item.kind === "symbol") return `${item.value.path}${item.value.resolved ? `:${item.value.line + 1}` : ""}`;
  return `${item.value.category} › ${item.value.title}`;
}

function itemKey(item: SearchItem): string {
  if (item.kind === "file") return `file:${item.value.rootId}:${item.value.path}`;
  if (item.kind === "action") return `action:${item.value.id}`;
  return `symbol:${item.value.uri}:${item.value.name}:${item.value.resolved ? `${item.value.line}:${item.value.character}` : item.value.resolveToken ?? "unresolved"}`;
}

const MODE_TABS: { id: SearchEverywhereMode; label: string }[] = [
  { id: "all", label: "All" },
  { id: "classes", label: "Classes" },
  { id: "files", label: "Files" },
  { id: "symbols", label: "Symbols" },
  { id: "actions", label: "Actions" },
  { id: "text", label: "Text" },
];

export function SearchEverywhere({
  open,
  initialMode = "files",
  items,
  loading,
  truncated = false,
  actionSnapshots,
  symbolsAvailable = false,
  semanticIndex,
  fetchSymbols,
  onClose,
  onOpenFile,
  onOpenSymbol,
  onRunCommand,
  onAssignShortcut,
  onSearchText,
}: SearchEverywhereProps) {
  const [mode, setMode] = useState<SearchEverywhereMode>(initialMode);
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<GoToSymbolItem[]>([]);
  const [symbolSnapshot, setSymbolSnapshot] = useState<{
    generation: number;
    revision: number;
  } | null>(null);
  const [symbolQueryStatus, setSymbolQueryStatus] = useState<Pick<GoToSymbolQueryResult, "sessionCount" | "providerCount" | "skippedProviderCount" | "failedProviderCount" | "complete" | "truncated" | "diagnostics">>({
    sessionCount: 0,
    providerCount: 0,
    skippedProviderCount: 0,
    failedProviderCount: 0,
    complete: false,
    truncated: false,
    diagnostics: [],
  });
  const [symbolsLoading, setSymbolsLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode);
    setQuery("");
    setSymbols([]);
    setSymbolSnapshot(null);
    setSymbolQueryStatus({ sessionCount: 0, providerCount: 0, skippedProviderCount: 0, failedProviderCount: 0, complete: false, truncated: false, diagnostics: [] });
  }, [initialMode, open]);

  // Always show all tabs. When symbols are unavailable, the Classes and
  // Symbols tabs degrade gracefully with an informative empty message
  // instead of disappearing, matching IntelliJ IDEA behavior.
  const visibleTabs = MODE_TABS;

  // Async workspace symbols for Classes / Symbols / All.
  useEffect(() => {
    if (!open || !symbolsAvailable || !fetchSymbols) return;
    if (mode !== "classes" && mode !== "symbols" && mode !== "all") return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setSymbolsLoading(true);
      setSymbolSnapshot(null);
      void fetchSymbols(query.trim())
        .then((next) => {
          if (!cancelled) {
            setSymbols(next.symbols);
            setSymbolQueryStatus({
              sessionCount: next.sessionCount,
              providerCount: next.providerCount,
              skippedProviderCount: next.skippedProviderCount,
              failedProviderCount: next.failedProviderCount,
              complete: next.complete,
              truncated: next.truncated,
              diagnostics: next.diagnostics ?? [],
            });
            setSymbolSnapshot(
              next.semanticGeneration == null || next.semanticRevision == null
                ? null
                : {
                  generation: next.semanticGeneration,
                  revision: next.semanticRevision,
                },
            );
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSymbols([]);
            setSymbolSnapshot(null);
            setSymbolQueryStatus({ sessionCount: 0, providerCount: 0, skippedProviderCount: 0, failedProviderCount: 0, complete: false, truncated: false, diagnostics: [] });
          }
        })
        .finally(() => {
          if (!cancelled) setSymbolsLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [fetchSymbols, mode, open, query, symbolsAvailable]);

  const symbolItems: SearchItem[] = useMemo(() => {
    const source = mode === "classes"
      ? symbols.filter((item) => isClassSymbolKind(item.kind))
      : symbols;
    return source.map((value) => ({ kind: "symbol" as const, value }));
  }, [mode, symbols]);

  const actionCommands: ActionSnapshotItem[] = useMemo(
    () => actionSnapshots.filter((entry) => entry.state.availability === "available"),
    [actionSnapshots],
  );

  const searchItems: SearchItem[] = useMemo(() => {
    if (mode === "files") return items.map((value) => ({ kind: "file", value }));
    if (mode === "actions") return actionCommands.map((value) => ({ kind: "action", value }));
    if (mode === "classes" || mode === "symbols") return symbolItems;
    if (mode === "text") return [];
    // All: files + symbols + actions, ranked together.
    return [
      ...items.map((value) => ({ kind: "file" as const, value })),
      ...symbolItems,
      ...actionCommands.map((value) => ({ kind: "action" as const, value })),
    ];
  }, [actionCommands, items, mode, symbolItems]);

  const filterItems = useCallback(
    (q: string, all: SearchItem[]) => {
      if (mode === "text") return [];
      if (mode === "all") return rankAllModeItems(q, all);
      return rankFuzzy(q, all, searchItemText, MAX_RESULTS);
    },
    [mode],
  );

  const isLoading = mode === "files"
    ? loading
    : mode === "classes" || mode === "symbols" || mode === "all"
      ? symbolsLoading || (mode === "all" && loading)
      : false;
  const symbolSnapshotCurrent = !!semanticIndex
    && !!symbolSnapshot
    && workspaceSemanticIndexBuildIsCurrent(semanticIndex, symbolSnapshot);
  const symbolSnapshotLabel = symbolSnapshot
    ? symbolSnapshotCurrent
      ? `Ready · generation ${symbolSnapshot.generation}`
      : `Stale · result generation ${symbolSnapshot.generation}`
    : semanticIndex
      ? workspaceSemanticIndexStatusLabel(semanticIndex)
      : null;

  return (
    <QuickPickOverlay
      open={open}
      testId="code-workspace-search-everywhere"
      inputLabel={
        mode === "classes" ? "Go to class"
          : mode === "symbols" ? "Go to symbol"
            : mode === "actions" ? "Search actions"
              : mode === "text" ? "Find in files"
                : mode === "all" ? "Search everywhere"
                  : "Go to file"
      }
      placeholder={
        mode === "text"
          ? "Type text and press Enter to search in files"
          : mode === "classes" || mode === "symbols"
            ? "Supports camelCase abbreviations"
            : mode === "actions"
              ? "Search workspace actions"
              : "Supports camelCase abbreviations"
      }
      items={searchItems}
      loading={isLoading}
      filterItems={filterItems}
      itemKey={itemKey}
      onQueryChange={setQuery}
      renderItem={(item) => {
        if (item.kind === "action") {
          return (
            <>
              <CommandIcon className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--taomni-code-text)]">{item.value.title}</span>
              <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">{item.value.category}</span>
              {item.value.keybinding && (
                <kbd
                  data-testid={`search-everywhere-shortcut-${item.value.id}`}
                  className="shrink-0 rounded border border-[var(--taomni-code-border)] px-1 text-[10px] text-[var(--taomni-code-muted)]"
                >
                  {item.value.keybinding}
                </kbd>
              )}
            </>
          );
        }
        if (item.kind === "symbol") {
          return (
            <>
              {isClassSymbolKind(item.value.kind)
                ? <Box className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
                : <Braces className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />}
              <span className="shrink-0 text-[var(--taomni-code-text)]">{item.value.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
                {item.value.containerName ? `${item.value.containerName} · ` : ""}
                {item.value.path}{item.value.resolved ? `:${item.value.line + 1}` : ""}
              </span>
              <span className="shrink-0 text-[10px] text-[var(--taomni-code-muted)]">
                {symbolKindLabel(item.value.kind)}
              </span>
            </>
          );
        }
        const name = item.value.path.split("/").pop() ?? item.value.path;
        const dir = item.value.path.slice(0, item.value.path.length - name.length).replace(/\/$/, "");
        return (
          <>
            <File className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
            <span className="shrink-0 text-[var(--taomni-code-text)]">{name}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--taomni-code-muted)]">
              {item.value.rootName}{dir ? `/${dir}` : ""}
            </span>
          </>
        );
      }}
      emptyText={(q) => {
        if (mode === "text") {
          return q.trim()
            ? "Press Enter to search this text in files"
            : "Type a query, then Enter to open Find in Files";
        }
        if (mode === "actions") {
          return actionCommands.length === 0 ? "No available workspace actions" : "No matching actions";
        }
        if (mode === "classes" || mode === "symbols") {
          if (symbolsLoading) return "Querying language server…";
          if (!symbolsAvailable) return "Language server initializing or unavailable — use Files tab to search by filename";
          return q.trim() ? "No matching symbols" : "Type to search workspace symbols";
        }
        if (mode === "all") {
          if (isLoading) return "Searching…";
          return q.trim() ? "No matching results" : "Type to search files, symbols, and actions";
        }
        if (loading) return "Indexing workspace files...";
        if (items.length === 0) return "No files in workspace roots";
        return "No matching files";
      }}
      header={
        <div className="flex h-8 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-[var(--taomni-code-border)] px-2">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mode === tab.id}
              data-active={mode === tab.id || undefined}
              className="h-7 shrink-0 rounded-t px-2.5 text-[11px] text-[var(--taomni-code-muted)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
              onClick={() => setMode(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      }
      footer={(selected) => {
        // ED-PARITY-014 DEC-014-02: IDEA footer = selected item's path plus
        // the split action; provider/index diagnostics live in the tooltip.
        const providerStatus = [
          symbolSnapshotLabel,
          `${symbolQueryStatus.providerCount}/${symbolQueryStatus.sessionCount} provider${symbolQueryStatus.sessionCount === 1 ? "" : "s"}${symbolQueryStatus.complete ? " · complete" : " · incomplete"}`
            + (symbolQueryStatus.failedProviderCount > 0 ? ` (${symbolQueryStatus.failedProviderCount} failed)` : "")
            + (symbolQueryStatus.skippedProviderCount > 0 ? ` (${symbolQueryStatus.skippedProviderCount} skipped)` : "")
            + (symbolQueryStatus.truncated ? " · truncated" : ""),
          `${symbols.length} symbol${symbols.length === 1 ? "" : "s"}`,
          ...(symbolQueryStatus.diagnostics ?? []),
        ].filter(Boolean).join("\n");
        return (
          <>
            <span data-testid="search-everywhere-selected-path" className="min-w-0 flex-1 truncate" title={selectedItemPath(selected)}>
              {selectedItemPath(selected)}
            </span>
            {(mode === "actions" || mode === "all") && onAssignShortcut && (
              <span data-testid="search-everywhere-assign-shortcut-hint" className="shrink-0">Alt+Enter assign shortcut</span>
            )}
            {(mode === "all" || mode === "files" || mode === "classes" || mode === "symbols") && (
              <span className="shrink-0">Open In Right Split Ctrl+Enter</span>
            )}
            {mode === "files" && (
              <span className="shrink-0">{truncated ? "file index truncated · " : ""}{items.length} file{items.length === 1 ? "" : "s"}</span>
            )}
            {mode === "actions" && <span className="shrink-0">{actionCommands.length} action{actionCommands.length === 1 ? "" : "s"}</span>}
            {(mode === "all" || mode === "classes" || mode === "symbols") && (
              <span
                data-testid="search-everywhere-symbol-provider-status"
                role="img"
                aria-label={providerStatus}
                title={providerStatus}
                data-complete={symbolQueryStatus.complete}
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${symbolQueryStatus.complete ? "bg-emerald-500/70" : "bg-amber-500"}`}
              />
            )}
            {mode === "text" && <Type className="inline h-3 w-3 shrink-0" />}
          </>
        );
      }}
      onClose={onClose}
      onPick={(item, options) => {
        if (item.kind === "file") {
          if (options) onOpenFile(item.value, options);
          else onOpenFile(item.value);
        }
        else if (item.kind === "action") onRunCommand?.(item.value.id);
        else if (options) onOpenSymbol?.(item.value, options);
        else onOpenSymbol?.(item.value);
      }}
      onAltEnter={onAssignShortcut
        ? (item) => {
          if (item.kind === "action") onAssignShortcut(item.value.id);
        }
        : undefined}
      onEnterEmpty={(q) => {
        if (mode === "text" && q.trim()) onSearchText?.(q.trim());
      }}
    />
  );
}
