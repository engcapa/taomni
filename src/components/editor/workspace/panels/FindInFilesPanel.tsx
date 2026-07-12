import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, CaseSensitive, File, Loader2, Regex, Search, WholeWord } from "lucide-react";
import {
  newWorkspaceSearchId,
  subscribeWorkspaceSearch,
  workspaceSearchCancel,
  workspaceSearchStart,
  type WorkspaceSearchMatch,
} from "../../../../lib/editor/workspaceSearch";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import {
  pushWorkspaceSearchHistory,
  readWorkspaceSearchHistory,
} from "../workspaceLayoutPersistence";
import { FilterClearButton } from "../workspaceChrome";

interface FindInFilesPanelProps {
  roots: CodeWorkspaceRootInfo[];
  onOpenMatch: (match: WorkspaceSearchMatch, options: { preview: boolean }) => void;
  /** Apply replacements for the current result set via the shared WorkspaceEdit path. */
  onReplaceMatches?: (matches: WorkspaceSearchMatch[], replacement: string) => void | Promise<void>;
  /** Bump to move focus into the query input (Ctrl+Shift+F). */
  focusNonce?: number;
  /** Bump the nonce to overwrite the include globs ("Find in Directory..."). */
  includePreset?: { value: string; nonce: number };
  /** Bump the nonce to seed the query field (Search Everywhere Text tab). */
  queryPreset?: { value: string; nonce: number };
  /** Workspace instance id for search history persistence. */
  workspaceInstanceId?: string;
}

interface MatchGroup {
  key: string;
  title: string;
  matches: WorkspaceSearchMatch[];
}

interface SearchSummary {
  filesScanned: number;
  totalMatches: number;
  truncated: boolean;
  cancelled: boolean;
}

type SearchStatus = "idle" | "searching" | "done" | "error";

/**
 * Rendering every match as a DOM row (no virtualization yet), so keep the
 * default total well below the backend's 10k ceiling.
 */
const MAX_TOTAL_MATCHES = 2_000;
const CONTEXT_BEFORE_MATCH = 24;

function splitGlobs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Slice the line around the match. Offsets from the backend are Unicode
 * code-point based, so slice via code points rather than UTF-16 indices.
 */
export function matchSegments(match: WorkspaceSearchMatch): { before: string; hit: string; after: string } {
  const chars = Array.from(match.lineText);
  const trimmed = match.lineText.trimStart();
  const leading = chars.length - Array.from(trimmed).length;
  const start = Math.max(match.matchStart, leading);
  const end = Math.max(match.matchEnd, start);
  const contextStart = Math.max(leading, start - CONTEXT_BEFORE_MATCH);
  const prefix = contextStart > leading ? "…" : "";
  return {
    before: prefix + chars.slice(contextStart, start).join(""),
    hit: chars.slice(start, end).join(""),
    after: chars.slice(end).join(""),
  };
}

function groupKey(match: WorkspaceSearchMatch): string {
  return `${match.rootId}:${match.path}`;
}

function groupTitle(match: WorkspaceSearchMatch): string {
  return `${match.rootName}/${match.path}`;
}

export function FindInFilesPanel({
  roots,
  onOpenMatch,
  onReplaceMatches,
  focusNonce = 0,
  includePreset,
  queryPreset,
  workspaceInstanceId,
}: FindInFilesPanelProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [includeGlobs, setIncludeGlobs] = useState("");
  const [excludeGlobs, setExcludeGlobs] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [groups, setGroups] = useState<MatchGroup[]>([]);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => (
    workspaceInstanceId ? readWorkspaceSearchHistory(workspaceInstanceId) : []
  ));

  const inputRef = useRef<HTMLInputElement>(null);
  const searchIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const groupsRef = useRef<Map<string, MatchGroup>>(new Map());

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  const appliedPresetNonceRef = useRef(0);
  useEffect(() => {
    if (!includePreset || includePreset.nonce === 0) return;
    if (includePreset.nonce === appliedPresetNonceRef.current) return;
    appliedPresetNonceRef.current = includePreset.nonce;
    setIncludeGlobs(includePreset.value);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [includePreset]);

  const appliedQueryPresetNonceRef = useRef(0);
  useEffect(() => {
    if (!queryPreset || queryPreset.nonce === 0) return;
    if (queryPreset.nonce === appliedQueryPresetNonceRef.current) return;
    appliedQueryPresetNonceRef.current = queryPreset.nonce;
    setQuery(queryPreset.value);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [queryPreset]);

  const teardownSearch = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    const active = searchIdRef.current;
    searchIdRef.current = null;
    if (active) void workspaceSearchCancel(active).catch(() => {});
  }, []);

  useEffect(() => teardownSearch, [teardownSearch]);

  useEffect(() => {
    setSearchHistory(workspaceInstanceId ? readWorkspaceSearchHistory(workspaceInstanceId) : []);
  }, [workspaceInstanceId]);

  const startSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed || roots.length === 0) return;
    if (workspaceInstanceId) {
      setSearchHistory(pushWorkspaceSearchHistory(workspaceInstanceId, trimmed));
    }
    teardownSearch();
    groupsRef.current = new Map();
    setGroups([]);
    setSummary(null);
    setError(null);
    setStatus("searching");

    const searchId = newWorkspaceSearchId();
    searchIdRef.current = searchId;
    try {
      const unlisten = await subscribeWorkspaceSearch(searchId, (event) => {
        if (searchIdRef.current !== searchId) return;
        if (event.kind === "batch") {
          for (const match of event.matches) {
            const key = groupKey(match);
            const group = groupsRef.current.get(key);
            if (group) group.matches.push(match);
            else groupsRef.current.set(key, { key, title: groupTitle(match), matches: [match] });
          }
          setGroups([...groupsRef.current.values()]);
          return;
        }
        unlistenRef.current?.();
        unlistenRef.current = null;
        searchIdRef.current = null;
        if (event.kind === "error") {
          setStatus("error");
          setError(event.error ?? "Search failed");
          return;
        }
        setStatus("done");
        setSummary({
          filesScanned: event.filesScanned,
          totalMatches: event.totalMatches,
          truncated: event.truncated,
          cancelled: event.cancelled,
        });
      });
      if (searchIdRef.current !== searchId) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
      await workspaceSearchStart(
        searchId,
        roots.map((root) => ({ id: root.id, name: root.name, path: root.path })),
        trimmed,
        {
          caseSensitive,
          wholeWord,
          regexp,
          includeGlobs: splitGlobs(includeGlobs),
          excludeGlobs: splitGlobs(excludeGlobs),
          maxTotalMatches: MAX_TOTAL_MATCHES,
        },
      );
    } catch (err) {
      if (searchIdRef.current === searchId) {
        unlistenRef.current?.();
        unlistenRef.current = null;
        searchIdRef.current = null;
        setStatus("error");
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [caseSensitive, excludeGlobs, includeGlobs, query, regexp, roots, teardownSearch, wholeWord, workspaceInstanceId]);

  const cancelSearch = useCallback(() => {
    const active = searchIdRef.current;
    if (!active) return;
    void workspaceSearchCancel(active).catch(() => {});
  }, []);

  const totalShown = useMemo(
    () => groups.reduce((sum, group) => sum + group.matches.length, 0),
    [groups],
  );

  const allMatches = useMemo(
    () => groups.flatMap((group) => group.matches),
    [groups],
  );

  const replaceAll = useCallback(async () => {
    if (!onReplaceMatches || allMatches.length === 0 || replacing) return;
    const files = new Set(allMatches.map((match) => `${match.rootId}:${match.path}`)).size;
    const ok = window.confirm(
      `Replace ${allMatches.length} occurrence${allMatches.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}?`,
    );
    if (!ok) return;
    setReplacing(true);
    try {
      await onReplaceMatches(allMatches, replacement);
    } finally {
      setReplacing(false);
    }
  }, [allMatches, onReplaceMatches, replacement, replacing]);

  const toggles = [
    { label: "Match case", icon: <CaseSensitive className="h-3.5 w-3.5" />, value: caseSensitive, set: setCaseSensitive },
    { label: "Whole word", icon: <WholeWord className="h-3.5 w-3.5" />, value: wholeWord, set: setWholeWord },
    { label: "Regular expression", icon: <Regex className="h-3.5 w-3.5" />, value: regexp, set: setRegexp },
  ];

  return (
    <div data-testid="code-workspace-find-in-files-panel" className="h-full min-h-0 flex flex-col text-[11px]">
      <div className="shrink-0 flex flex-wrap items-center gap-1.5 border-b border-[var(--taomni-code-border)] px-2 py-1.5">
        <div className="flex min-w-44 flex-1 items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <input
            ref={inputRef}
            value={query}
            list={workspaceInstanceId ? "code-workspace-search-history" : undefined}
            placeholder="Search in files (Enter to run)"
            aria-label="Search query"
            className="h-6 min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void startSearch();
              else if (event.key === "Escape") cancelSearch();
            }}
          />
          {workspaceInstanceId && searchHistory.length > 0 && (
            <datalist id="code-workspace-search-history">
              {searchHistory.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          )}
          <FilterClearButton
            value={query}
            label="Clear search query"
            testId="code-workspace-find-query-clear"
            onClear={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          />
          {toggles.map((toggle) => (
            <button
              key={toggle.label}
              type="button"
              title={toggle.label}
              aria-label={toggle.label}
              aria-pressed={toggle.value}
              data-active={toggle.value || undefined}
              className="h-5 w-5 shrink-0 inline-flex items-center justify-center rounded text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] data-[active=true]:bg-[var(--taomni-code-selection-match-bg)] data-[active=true]:text-[var(--taomni-code-text)]"
              onClick={() => toggle.set((current) => !current)}
            >
              {toggle.icon}
            </button>
          ))}
        </div>
        <label className="inline-flex h-6 w-32 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            value={includeGlobs}
            placeholder="include: *.ts, src/**"
            aria-label="Include globs"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setIncludeGlobs(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void startSearch()}
          />
          <FilterClearButton
            value={includeGlobs}
            label="Clear include globs"
            testId="code-workspace-find-include-clear"
            onClear={() => setIncludeGlobs("")}
          />
        </label>
        <label className="inline-flex h-6 w-32 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            value={excludeGlobs}
            placeholder="exclude: dist/**"
            aria-label="Exclude globs"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setExcludeGlobs(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void startSearch()}
          />
          <FilterClearButton
            value={excludeGlobs}
            label="Clear exclude globs"
            testId="code-workspace-find-exclude-clear"
            onClear={() => setExcludeGlobs("")}
          />
        </label>
        <label className="inline-flex h-6 w-36 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace text"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setReplacement(event.target.value)}
          />
          <FilterClearButton
            value={replacement}
            label="Clear replace text"
            testId="code-workspace-find-replace-clear"
            onClear={() => setReplacement("")}
          />
        </label>
        {status === "searching" ? (
          <button
            type="button"
            aria-label="Cancel search"
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={cancelSearch}
          >
            <Ban className="h-3.5 w-3.5" />
            <span>Cancel</span>
          </button>
        ) : (
          <button
            type="button"
            aria-label="Run search"
            disabled={!query.trim() || roots.length === 0}
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
            onClick={() => void startSearch()}
          >
            <Search className="h-3.5 w-3.5" />
            <span>Search</span>
          </button>
        )}
        {onReplaceMatches && (
          <button
            type="button"
            aria-label="Replace all matches"
            disabled={allMatches.length === 0 || replacing || status === "searching"}
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
            onClick={() => void replaceAll()}
          >
            <span>{replacing ? "Replacing…" : "Replace All"}</span>
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--taomni-code-muted)]">
          {status === "searching" && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === "searching" && `${totalShown} so far`}
          {status === "done" && summary && (
            `${summary.totalMatches} result${summary.totalMatches === 1 ? "" : "s"} · ${groups.length} file${groups.length === 1 ? "" : "s"}`
          )}
        </span>
      </div>
      {(summary?.truncated || summary?.cancelled) && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] text-amber-500">
          {summary.cancelled ? "Search cancelled — results are partial." : `Match limit reached (${MAX_TOTAL_MATCHES}) — refine the query to see everything.`}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {error && (
          <div className="mx-2 mb-1 rounded border border-red-500/30 bg-red-500/10 p-2 text-red-500">{error}</div>
        )}
        {!error && groups.length === 0 && (
          <div className="px-3 py-2 text-[var(--taomni-code-muted)]">
            {roots.length === 0
              ? "Add a folder to the workspace to search its files"
              : status === "done"
                ? "No results"
                : status === "searching"
                  ? "Searching..."
                  : "Search file contents across all workspace roots"}
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key}>
            <div className="h-6 flex items-center gap-2 px-3 font-medium text-[var(--taomni-code-muted)]" title={group.title}>
              <File className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{group.title}</span>
              <span className="shrink-0 text-[10px] tabular-nums">{group.matches.length}</span>
            </div>
            {group.matches.map((match, index) => {
              const segments = matchSegments(match);
              return (
                <button
                  key={`${match.lineNumber}:${match.column}:${index}`}
                  type="button"
                  className="h-6 w-full min-w-0 flex items-center gap-2 px-4 text-left hover:bg-[var(--taomni-code-active-line-bg)]"
                  title={`${group.title}:${match.lineNumber}:${match.column}`}
                  onClick={() => onOpenMatch(match, { preview: true })}
                  onDoubleClick={() => onOpenMatch(match, { preview: false })}
                >
                  <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                    {match.lineNumber}:{match.column}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--taomni-code-text)]">
                    {segments.before}
                    <mark className="rounded-sm bg-[var(--taomni-code-selection-match-bg)] px-px text-inherit">
                      {segments.hit}
                    </mark>
                    {segments.after}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
