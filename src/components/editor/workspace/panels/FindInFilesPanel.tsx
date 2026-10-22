import type { Language } from "@codemirror/language";
import { CaseSensitive, Regex, WholeWord } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LspWorkspaceEdit } from "../../../../lib/editor/lsp";
import { highlightSearchLine, languageForSearchPath } from "../../../../lib/editor/searchLineHighlight";
import { type WorkspaceSearchMatch } from "../../../../lib/editor/workspaceSearch";
import { useProjectFactsStore, type WorkspaceProjectFactsEntry } from "../../../../stores/projectFactsStore";
import { type MenuItem } from "../../../ContextMenu";
import { workspaceSearchMatchKey } from "../buildReplaceEdits";
import { planFindInFilesScope, type FindInFilesScopeKind, type FindInFilesScopePlan } from "../findInFilesScopeModel";
import { type ReplaceInFilesPlan, type ReplacePreviewSnapshot } from "../replaceInFilesModel";
import { readWorkspaceSearchHistory } from "../workspaceLayoutPersistence";
import { FindInFilesView } from "./findInFiles/FindInFilesView";
import { DEFAULT_MATCHES_PER_FILE, EMPTY_FACTS_MODULES, MATCHES_PER_FILE_STEP, splitGlobs } from "./findInFiles/limits";
import { type FindInFilesPanelProps, type MatchGroup, type MatchSegments, type SearchStatus, type SearchSummary } from "./findInFiles/types";
import { useFindReplaceActions } from "./findInFiles/useFindReplaceActions";
import { useFindSearchLifetime } from "./findInFiles/useFindSearchLifetime";

export function FindInFilesPanel({
  roots,
  onOpenMatch,
  onReplaceMatches,
  onPrepareReplacePreimages,
  focusNonce = 0,
  focusTarget = "query",
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
  const [excludedMatchKeys, setExcludedMatchKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedMatchKey, setFocusedMatchKey] = useState<string | null>(null);
  const [replaceNotice, setReplaceNotice] = useState<{ appliedCount: number; fileCount: number; } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; matchKey: string; } | null>(null);
  const [summary, setSummary] = useState<SearchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** ED-FIND-004/005: frozen replace preview (plan + source edit + matches +
   * scope/query/replacement snapshot). */
  const [replacePreview, setReplacePreview] = useState<{
    edit: LspWorkspaceEdit;
    plan: ReplaceInFilesPlan;
    matches: WorkspaceSearchMatch[];
    usageToMatchKey: ReadonlyMap<string, string>;
    stableToUsageId: ReadonlyMap<string, string>;
    initialExcludedKeys: ReadonlySet<string>;
    replacement: string;
    snapshot: ReplacePreviewSnapshot;
  } | null>(null);
  const [replaceCommitting, setReplaceCommitting] = useState(false);
  const [replaceCommitError, setReplaceCommitError] = useState<string | null>(null);
  const [replacePreparing, setReplacePreparing] = useState(false);
  const replacePrepareTokenRef = useRef(0);
  const replacePreparingRef = useRef(false);
  const replaceAbortControllerRef = useRef<AbortController | null>(null);

  const invalidateReplacePrepare = useCallback(() => {
    replacePrepareTokenRef.current++;
    if (replaceAbortControllerRef.current) {
      replaceAbortControllerRef.current.abort();
      replaceAbortControllerRef.current = null;
    }
    if (replacePreparingRef.current) {
      replacePreparingRef.current = false;
      setReplacePreparing(false);
    }
  }, []);

  const cancelReplacePrepare = useCallback(() => {
    invalidateReplacePrepare();
  }, [invalidateReplacePrepare]);

  // Invalidate on unmount
  useEffect(() => {
    return () => {
      invalidateReplacePrepare();
    };
  }, [invalidateReplacePrepare]);
  /** ED-FIND-003: selected search scope. Module scope requires ready facts. */
  const [scopeKind, setScopeKind] = useState<FindInFilesScopeKind>("project");
  const [scopeModuleId, setScopeModuleId] = useState("");
  const [scopeDirectory, setScopeDirectory] = useState("");
  const workspaceRoot = roots[0]?.path ?? "";
  const factsEntry: WorkspaceProjectFactsEntry | null = useProjectFactsStore(
    (state) => (workspaceRoot ? (state.workspaces[workspaceRoot] ?? null) : null),
  );
  const factsModules = factsEntry?.structure?.modules ?? EMPTY_FACTS_MODULES;

  // ED-FIND-003 A1: the selected scope plan, rebuilt live so the panel can
  // fail closed before touching the backend. startSearch consumes the same
  // plan object the notice below renders.
  const scopePlan: FindInFilesScopePlan = useMemo(() => {
    const maskValue = splitGlobs(includeGlobs).join(",") || undefined;
    const directoryInput = scopeDirectory.trim();
    const targetDirectory = scopeKind !== "directory"
      ? undefined
      : !directoryInput
        ? workspaceRoot || undefined
        : /^(?:[a-zA-Z]:[\\/]|[/\\])/.test(directoryInput)
          ? directoryInput
          : workspaceRoot
            ? `${workspaceRoot.replace(/\/+$/, "")}/${directoryInput.replace(/^\/+/, "")}`
            : directoryInput;
    return planFindInFilesScope(
      {
        kind: scopeKind,
        workspaceRoot,
        targetDirectory,
        moduleId: scopeModuleId || factsModules[0]?.id,
        fileMask: maskValue,
        expectedGeneration: factsEntry?.generation,
      },
      factsEntry,
    );
  }, [factsEntry, factsModules, includeGlobs, scopeDirectory, scopeKind, scopeModuleId, workspaceRoot]);
  /** Per-file expand state: collapsed (default), numeric limit, or "all". */
  const [fileExpand, setFileExpand] = useState<Record<string, number | "all">>({});
  const [collapsedFiles, setCollapsedFiles] = useState<Record<string, boolean>>({});
  /** path → language (null = plain text / unknown). */
  const [languagesByPath, setLanguagesByPath] = useState<Record<string, Language | null>>({});
  const [searchHistory, setSearchHistory] = useState<string[]>(() => (
    workspaceInstanceId ? readWorkspaceSearchHistory(workspaceInstanceId) : []
  ));

  const inputRef = useRef<HTMLInputElement>(null);
  const replacementInputRef = useRef<HTMLInputElement>(null);
  const replaceAllButtonRef = useRef<HTMLButtonElement>(null);
  const restoreReplaceButtonFocusRef = useRef(false);
  const matchRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const pendingMatchFocusRef = useRef<string | null>(null);

  // Before paint, so typing right after Ctrl+Shift+F lands in the query; a
  // panel whose tool window shows in a later commit retries on the next frame.
  useLayoutEffect(() => {
    if (!focusNonce) return;
    const focusField = () => {
      const target = focusTarget === "replace" && query.trim()
        ? replacementInputRef.current
        : inputRef.current;
      target?.focus();
      target?.select();
      return !!target && document.activeElement === target;
    };
    if (focusField()) return;
    const frame = requestAnimationFrame(() => {
      focusField();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusNonce, focusTarget]);

  useLayoutEffect(() => {
    if (replacePreview || !restoreReplaceButtonFocusRef.current) return;
    restoreReplaceButtonFocusRef.current = false;
    replaceAllButtonRef.current?.focus();
  }, [replacePreview]);

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
  const search = useFindSearchLifetime({
    setReplacePreview,
    setReplaceCommitError,
    setExcludedMatchKeys,
    setReplaceNotice,
    setContextMenu,
    setFocusedMatchKey,
    pendingMatchFocusRef,
    setSearchHistory,
    workspaceInstanceId,
    query,
    roots,
    setGroups,
    setSummary,
    setError,
    setFileExpand,
    setCollapsedFiles,
    setLanguagesByPath,
    setStatus,
    scopePlan,
    factsEntry,
    workspaceRoot,
    caseSensitive,
    wholeWord,
    regexp,
    includeGlobs,
    excludeGlobs,
    factsModules,
    scopeDirectory,
    scopeKind,
    scopeModuleId,
  });

  const totalShown = useMemo(
    () => groups.reduce((sum, group) => sum + group.matches.length, 0),
    [groups],
  );

  const allMatches = useMemo(
    () => groups.flatMap((group) => group.matches),
    [groups],
  );

  const includedMatches = useMemo(
    () => allMatches.filter((match) => !excludedMatchKeys.has(workspaceSearchMatchKey(match))),
    [allMatches, excludedMatchKeys],
  );

  useEffect(() => {
    const pending = pendingMatchFocusRef.current;
    if (!pending) return;
    const element = matchRefs.current.get(pending);
    if (element) {
      element.focus();
      pendingMatchFocusRef.current = null;
    }
  }, [groups, excludedMatchKeys]);

  // ED-REPAIR-005: invalidate any in-flight prepare request when inputs, matches, or workspace changes
  useEffect(() => {
    invalidateReplacePrepare();
  }, [
    query,
    replacement,
    caseSensitive,
    wholeWord,
    regexp,
    includeGlobs,
    excludeGlobs,
    scopeKind,
    scopeModuleId,
    scopeDirectory,
    allMatches,
    workspaceInstanceId,
    roots,
    invalidateReplacePrepare,
  ]);

  const visibleLimitFor = useCallback((key: string, total: number): number => {
    const expand = fileExpand[key];
    if (expand === "all") return total;
    if (typeof expand === "number") return Math.min(total, expand);
    return Math.min(total, DEFAULT_MATCHES_PER_FILE);
  }, [fileExpand]);

  const visibleMatchKeys = useMemo(
    () => groups.flatMap((group) => {
      if (collapsedFiles[group.key]) return [];
      const limit = visibleLimitFor(group.key, group.matches.length);
      return group.matches.slice(0, limit).map(workspaceSearchMatchKey);
    }),
    [collapsedFiles, groups, visibleLimitFor],
  );

  const toggleMatchExclusion = useCallback((matchKey: string) => {
    setExcludedMatchKeys((current) => {
      const next = new Set(current);
      if (next.has(matchKey)) next.delete(matchKey);
      else next.add(matchKey);
      return next;
    });
  }, []);

  const toggleFileExclusion = useCallback((matches: readonly WorkspaceSearchMatch[]) => {
    const keys = matches.map(workspaceSearchMatchKey);
    setExcludedMatchKeys((current) => {
      const next = new Set(current);
      const allExcluded = keys.length > 0 && keys.every((key) => next.has(key));
      for (const key of keys) {
        if (allExcluded) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, []);

  const moveMatchFocus = useCallback((matchKey: string, delta: number) => {
    const index = visibleMatchKeys.indexOf(matchKey);
    if (index < 0 || visibleMatchKeys.length === 0) return;
    const targetIndex = Math.max(0, Math.min(visibleMatchKeys.length - 1, index + delta));
    const targetKey = visibleMatchKeys[targetIndex];
    if (!targetKey) return;
    pendingMatchFocusRef.current = targetKey;
    requestAnimationFrame(() => matchRefs.current.get(targetKey)?.focus());
  }, [visibleMatchKeys]);

  const toggleFileCollapsed = useCallback((key: string) => {
    setCollapsedFiles((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const showMoreForFile = useCallback((key: string, total: number) => {
    setFileExpand((prev) => {
      const current = prev[key];
      const base = current === "all"
        ? total
        : typeof current === "number"
          ? current
          : DEFAULT_MATCHES_PER_FILE;
      const next = base + MATCHES_PER_FILE_STEP;
      return { ...prev, [key]: next >= total ? "all" : next };
    });
  }, []);

  const showAllForFile = useCallback((key: string) => {
    setFileExpand((prev) => ({ ...prev, [key]: "all" }));
  }, []);

  // Lazily resolve CodeMirror languages for result paths so lines can share
  // the same grammar as the editor (and use --taomni-code-syntax-* colors).
  useEffect(() => {
    const paths = new Set<string>();
    for (const group of groups) {
      if (group.matches[0]) paths.add(group.matches[0].path);
    }
    let cancelled = false;
    for (const path of paths) {
      if (Object.prototype.hasOwnProperty.call(search.languagesRef.current, path)) continue;
      void languageForSearchPath(path).then((language) => {
        if (cancelled) return;
        search.languagesRef.current = { ...search.languagesRef.current, [path]: language };
        setLanguagesByPath((prev) => (
          Object.prototype.hasOwnProperty.call(prev, path) ? prev : { ...prev, [path]: language }
        ));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [groups]);

  const renderMatchLine = useCallback((match: WorkspaceSearchMatch, segments: MatchSegments): ReactNode => {
    const hasLanguage = Object.prototype.hasOwnProperty.call(languagesByPath, match.path);
    const language = hasLanguage ? languagesByPath[match.path] ?? null : null;
    const spans = hasLanguage && language
      ? highlightSearchLine(segments.text, segments.hitStart, segments.hitEnd, language)
      : null;

    // Plain fallback (language not resolved yet, or unknown extension): before/hit/after
    // already carry … elision markers from matchSegments.
    if (!spans) {
      return (
        <>
          {segments.before}
          <mark
            className="rounded-sm border border-[var(--taomni-code-find-match-border)] bg-[var(--taomni-code-find-match-bg)] px-0.5 font-semibold text-[var(--taomni-code-find-match-fg)]"
            data-testid="code-workspace-find-match-hit"
          >
            {segments.hit}
          </mark>
          {segments.after}
        </>
      );
    }

    return (
      <>
        {segments.elidedStart ? "…" : null}
        {spans.map((span, index) => {
          if (span.hit) {
            return (
              <mark
                key={`h-${index}`}
                className="rounded-sm border border-[var(--taomni-code-find-match-border)] bg-[var(--taomni-code-find-match-bg)] px-0.5 font-semibold text-[var(--taomni-code-find-match-fg)]"
                data-testid="code-workspace-find-match-hit"
              >
                {span.text}
              </mark>
            );
          }
          if (span.className) {
            return (
              <span key={`t-${index}`} className={span.className}>
                {span.text}
              </span>
            );
          }
          return <span key={`p-${index}`}>{span.text}</span>;
        })}
        {segments.elidedEnd ? "…" : null}
      </>
    );
  }, [languagesByPath]);
  const replace = useFindReplaceActions({
    onReplaceMatches,
    includedMatches,
    replacePreview,
    replacePreparingRef,
    setReplacePreparing,
    setReplaceCommitError,
    replacePrepareTokenRef,
    replaceAbortControllerRef,
    scopePlan,
    query,
    caseSensitive,
    wholeWord,
    regexp,
    includeGlobs,
    excludeGlobs,
    replacement,
    allMatches,
    workspaceInstanceId,
    onPrepareReplacePreimages,
    setReplacePreview,
    excludedMatchKeys,
    setReplaceCommitting,
    setGroups,
    setExcludedMatchKeys,
    setSummary,
    setReplaceNotice,
    pendingMatchFocusRef,
    inputRef,
  });

  const contextMenuMatch = contextMenu
    ? allMatches.find((match) => workspaceSearchMatchKey(match) === contextMenu.matchKey) ?? null
    : null;
  const contextMenuItems: MenuItem[] = contextMenuMatch
    ? [{
      label: excludedMatchKeys.has(workspaceSearchMatchKey(contextMenuMatch)) ? "Restore" : "Exclude",
      testId: excludedMatchKeys.has(workspaceSearchMatchKey(contextMenuMatch))
        ? "code-workspace-find-row-restore"
        : "code-workspace-find-row-exclude",
      onClick: () => {
        toggleMatchExclusion(workspaceSearchMatchKey(contextMenuMatch));
        setContextMenu(null);
      },
    }]
    : [];

  const toggles = [
    { label: "Match case", icon: <CaseSensitive className="h-3.5 w-3.5" />, value: caseSensitive, set: setCaseSensitive },
    { label: "Whole word", icon: <WholeWord className="h-3.5 w-3.5" />, value: wholeWord, set: setWholeWord },
    { label: "Regular expression", icon: <Regex className="h-3.5 w-3.5" />, value: regexp, set: setRegexp },
  ];

  return <FindInFilesView
    inputRef={inputRef}
    query={query}
    workspaceInstanceId={workspaceInstanceId}
    setQuery={setQuery}
    search={search}
    searchHistory={searchHistory}
    toggles={toggles}
    scopeKind={scopeKind}
    setScopeKind={setScopeKind}
    scopeModuleId={scopeModuleId}
    factsModules={factsModules}
    setScopeModuleId={setScopeModuleId}
    scopeDirectory={scopeDirectory}
    setScopeDirectory={setScopeDirectory}
    includeGlobs={includeGlobs}
    setIncludeGlobs={setIncludeGlobs}
    excludeGlobs={excludeGlobs}
    setExcludeGlobs={setExcludeGlobs}
    replacementInputRef={replacementInputRef}
    replacement={replacement}
    setReplacement={setReplacement}
    status={status}
    roots={roots}
    onReplaceMatches={onReplaceMatches}
    replaceAllButtonRef={replaceAllButtonRef}
    includedMatches={includedMatches}
    replaceCommitting={replaceCommitting}
    replacePreparing={replacePreparing}
    replace={replace}
    cancelReplacePrepare={cancelReplacePrepare}
    totalShown={totalShown}
    summary={summary}
    groups={groups}
    replaceCommitError={replaceCommitError}
    replacePreview={replacePreview}
    replaceNotice={replaceNotice}
    scopePlan={scopePlan}
    error={error}
    collapsedFiles={collapsedFiles}
    visibleLimitFor={visibleLimitFor}
    toggleFileCollapsed={toggleFileCollapsed}
    toggleFileExclusion={toggleFileExclusion}
    excludedMatchKeys={excludedMatchKeys}
    matchRefs={matchRefs}
    focusedMatchKey={focusedMatchKey}
    setFocusedMatchKey={setFocusedMatchKey}
    setContextMenu={setContextMenu}
    toggleMatchExclusion={toggleMatchExclusion}
    visibleMatchKeys={visibleMatchKeys}
    moveMatchFocus={moveMatchFocus}
    onOpenMatch={onOpenMatch}
    renderMatchLine={renderMatchLine}
    showMoreForFile={showMoreForFile}
    showAllForFile={showAllForFile}
    restoreReplaceButtonFocusRef={restoreReplaceButtonFocusRef}
    setReplacePreview={setReplacePreview}
    setReplaceCommitError={setReplaceCommitError}
    contextMenu={contextMenu}
    contextMenuMatch={contextMenuMatch}
    contextMenuItems={contextMenuItems}
  />;
}

export { type MatchSegments } from "./findInFiles/types";

export { matchSegments } from "./findInFiles/formatting";

export { DEFAULT_MATCHES_PER_FILE, MATCHES_PER_FILE_STEP } from "./findInFiles/limits";
