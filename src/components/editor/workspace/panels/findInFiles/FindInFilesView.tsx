import { Ban, ChevronDown, ChevronRight, File, Loader2, Search } from "lucide-react";
import { type ReactNode } from "react";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { type WorkspaceSearchMatch } from "../../../../../lib/editor/workspaceSearch";
import { ContextMenu, type MenuItem } from "../../../../ContextMenu";
import { workspaceSearchMatchKey } from "../../buildReplaceEdits";
import { type FindInFilesScopeKind, type FindInFilesScopePlan } from "../../findInFilesScopeModel";
import { type ReplaceInFilesPlan, type ReplacePreviewSnapshot } from "../../replaceInFilesModel";
import { ReplacePreviewDialog } from "../ReplacePreviewDialog";
import { matchSegments, replaceScopeLabel } from "./formatting";
import { MATCHES_PER_FILE_STEP, MAX_TOTAL_MATCHES } from "./limits";
import { type MatchGroup, type MatchSegments, type SearchStatus, type SearchSummary } from "./types";
import { useFindReplaceActions } from "./useFindReplaceActions";
import { useFindSearchLifetime } from "./useFindSearchLifetime";

export interface FindInFilesViewProps {
  inputRef: import("react").RefObject<HTMLInputElement | null>;
  query: string;
  workspaceInstanceId: string | undefined;
  setQuery: import("react").Dispatch<import("react").SetStateAction<string>>;
  search: ReturnType<typeof useFindSearchLifetime>;
  searchHistory: string[];
  toggles: { label: string; icon: import("react").JSX.Element; value: boolean; set: import("react").Dispatch<import("react").SetStateAction<boolean>>; }[];
  scopeKind: FindInFilesScopeKind;
  setScopeKind: import("react").Dispatch<import("react").SetStateAction<FindInFilesScopeKind>>;
  scopeModuleId: string;
  factsModules: readonly import("../../projectStructureModel").ProjectStructureModuleV2[];
  setScopeModuleId: import("react").Dispatch<import("react").SetStateAction<string>>;
  scopeDirectory: string;
  setScopeDirectory: import("react").Dispatch<import("react").SetStateAction<string>>;
  includeGlobs: string;
  setIncludeGlobs: import("react").Dispatch<import("react").SetStateAction<string>>;
  excludeGlobs: string;
  setExcludeGlobs: import("react").Dispatch<import("react").SetStateAction<string>>;
  replacementInputRef: import("react").RefObject<HTMLInputElement | null>;
  replacement: string;
  setReplacement: import("react").Dispatch<import("react").SetStateAction<string>>;
  status: SearchStatus;
  roots: import("../../../../../types").CodeWorkspaceRootInfo[];
  onReplaceMatches: ((matches: WorkspaceSearchMatch[], replacement: string, edit: LspWorkspaceEdit, snapshot: ReplacePreviewSnapshot) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }>) | undefined;
  replaceAllButtonRef: import("react").RefObject<HTMLButtonElement | null>;
  includedMatches: WorkspaceSearchMatch[];
  replaceCommitting: boolean;
  replacePreparing: boolean;
  replace: ReturnType<typeof useFindReplaceActions>;
  cancelReplacePrepare: () => void;
  totalShown: number;
  summary: SearchSummary | null;
  groups: MatchGroup[];
  replaceCommitError: string | null;
  replacePreview: { edit: LspWorkspaceEdit; plan: ReplaceInFilesPlan; matches: WorkspaceSearchMatch[]; usageToMatchKey: ReadonlyMap<string, string>; stableToUsageId: ReadonlyMap<string, string>; initialExcludedKeys: ReadonlySet<string>; replacement: string; snapshot: ReplacePreviewSnapshot; } | null;
  replaceNotice: { appliedCount: number; fileCount: number; } | null;
  scopePlan: FindInFilesScopePlan;
  error: string | null;
  collapsedFiles: Record<string, boolean>;
  visibleLimitFor: (key: string, total: number) => number;
  toggleFileCollapsed: (key: string) => void;
  toggleFileExclusion: (matches: readonly WorkspaceSearchMatch[]) => void;
  excludedMatchKeys: ReadonlySet<string>;
  matchRefs: import("react").RefObject<Map<string, HTMLButtonElement>>;
  focusedMatchKey: string | null;
  setFocusedMatchKey: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  setContextMenu: import("react").Dispatch<import("react").SetStateAction<{ x: number; y: number; matchKey: string; } | null>>;
  toggleMatchExclusion: (matchKey: string) => void;
  visibleMatchKeys: string[];
  moveMatchFocus: (matchKey: string, delta: number) => void;
  onOpenMatch: (match: WorkspaceSearchMatch, options: { preview: boolean; }) => void;
  renderMatchLine: (match: WorkspaceSearchMatch, segments: MatchSegments) => ReactNode;
  showMoreForFile: (key: string, total: number) => void;
  showAllForFile: (key: string) => void;
  restoreReplaceButtonFocusRef: import("react").RefObject<boolean>;
  setReplacePreview: import("react").Dispatch<import("react").SetStateAction<{ edit: LspWorkspaceEdit; plan: ReplaceInFilesPlan; matches: WorkspaceSearchMatch[]; usageToMatchKey: ReadonlyMap<string, string>; stableToUsageId: ReadonlyMap<string, string>; initialExcludedKeys: ReadonlySet<string>; replacement: string; snapshot: ReplacePreviewSnapshot; } | null>>;
  setReplaceCommitError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  contextMenu: { x: number; y: number; matchKey: string; } | null;
  contextMenuMatch: WorkspaceSearchMatch | null;
  contextMenuItems: MenuItem[];
}

export function FindInFilesView(props: FindInFilesViewProps) {
  const {
    inputRef,
    query,
    workspaceInstanceId,
    setQuery,
    search,
    searchHistory,
    toggles,
    scopeKind,
    setScopeKind,
    scopeModuleId,
    factsModules,
    setScopeModuleId,
    scopeDirectory,
    setScopeDirectory,
    includeGlobs,
    setIncludeGlobs,
    excludeGlobs,
    setExcludeGlobs,
    replacementInputRef,
    replacement,
    setReplacement,
    status,
    roots,
    onReplaceMatches,
    replaceAllButtonRef,
    includedMatches,
    replaceCommitting,
    replacePreparing,
    replace,
    cancelReplacePrepare,
    totalShown,
    summary,
    groups,
    replaceCommitError,
    replacePreview,
    replaceNotice,
    scopePlan,
    error,
    collapsedFiles,
    visibleLimitFor,
    toggleFileCollapsed,
    toggleFileExclusion,
    excludedMatchKeys,
    matchRefs,
    focusedMatchKey,
    setFocusedMatchKey,
    setContextMenu,
    toggleMatchExclusion,
    visibleMatchKeys,
    moveMatchFocus,
    onOpenMatch,
    renderMatchLine,
    showMoreForFile,
    showAllForFile,
    restoreReplaceButtonFocusRef,
    setReplacePreview,
    setReplaceCommitError,
    contextMenu,
    contextMenuMatch,
    contextMenuItems,
  } = props;
  return ((
    <div data-testid="code-workspace-find-in-files-panel" className="relative h-full min-h-0 flex flex-col text-[11px]">
      <div className="shrink-0 flex flex-wrap items-center gap-1.5 border-b border-[var(--taomni-code-border)] px-2 py-1.5">
        <div className="flex min-w-44 flex-1 items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--taomni-code-muted)]" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            list={workspaceInstanceId ? "code-workspace-search-history" : undefined}
            placeholder="Search in files (Enter to run)"
            aria-label="Search query"
            className="h-6 min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search.startSearch();
              else if (event.key === "Escape") search.cancelSearch();
            }}
          />
          {workspaceInstanceId && searchHistory.length > 0 && (
            <datalist id="code-workspace-search-history">
              {searchHistory.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          )}
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
        <label className="inline-flex h-6 items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <span className="sr-only">Search scope</span>
          <select
            aria-label="Search scope"
            data-testid="code-workspace-find-scope-select"
            value={scopeKind}
            onChange={(event) => setScopeKind(event.target.value as FindInFilesScopeKind)}
            className="h-full bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none"
          >
            <option value="project">Project</option>
            <option value="module">Module</option>
            <option value="directory">Directory</option>
          </select>
        </label>
        {scopeKind === "module" && (
          <label className="inline-flex h-6 min-w-24 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
            <span className="sr-only">Search module</span>
            <select
              aria-label="Search module"
              data-testid="code-workspace-find-module-select"
              value={scopeModuleId || factsModules[0]?.id || ""}
              onChange={(event) => setScopeModuleId(event.target.value)}
              className="h-full min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none"
            >
              {factsModules.length === 0 && <option value="">No modules</option>}
              {factsModules.map((mod) => (
                <option key={mod.id} value={mod.id}>{mod.id}</option>
              ))}
            </select>
          </label>
        )}
        {scopeKind === "directory" && (
          <label className="inline-flex h-6 w-40 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
            <input
              type="text"
              value={scopeDirectory}
              placeholder="subdir (empty = root)"
              aria-label="Search directory"
              data-testid="code-workspace-find-directory-input"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
              onChange={(event) => setScopeDirectory(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void search.startSearch()}
            />
          </label>
        )}
        <label className="inline-flex h-6 w-32 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            type="search"
            value={includeGlobs}
            placeholder="include: *.ts, src/**"
            aria-label="Include globs"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setIncludeGlobs(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void search.startSearch()}
          />
        </label>
        <label className="inline-flex h-6 w-32 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            type="search"
            value={excludeGlobs}
            placeholder="exclude: dist/**"
            aria-label="Exclude globs"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setExcludeGlobs(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void search.startSearch()}
          />
        </label>
        <label className="inline-flex h-6 w-36 items-center gap-0.5 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5">
          <input
            ref={replacementInputRef}
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace text"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--taomni-code-text)] outline-none placeholder:text-[var(--taomni-code-muted)]"
            onChange={(event) => setReplacement(event.target.value)}
          />
        </label>
        {status === "searching" ? (
          <button
            type="button"
            aria-label="Cancel search"
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
            onClick={search.cancelSearch}
          >
            <Ban className="h-3.5 w-3.5" />
            <span>Cancel</span>
          </button>
        ) : (
          <button
            type="button"
            aria-label="Run search"
            data-testid="code-workspace-find-run-search"
            disabled={!query.trim() || roots.length === 0}
            className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
            onClick={() => void search.startSearch()}
          >
            <Search className="h-3.5 w-3.5" />
            <span>Search</span>
          </button>
        )}
        {onReplaceMatches && (
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              aria-label="Preview replace all matches"
              data-testid="code-workspace-find-replace-all"
              ref={replaceAllButtonRef}
              disabled={includedMatches.length === 0 || replaceCommitting || replacePreparing || status === "searching"}
              className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)] disabled:opacity-50"
              onClick={() => void replace.replaceAll()}
            >
              {replacePreparing && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              <span>{replacePreparing ? "Preparing…" : "Replace All"}</span>
            </button>
            {replacePreparing && (
              <button
                type="button"
                aria-label="Cancel preparing replace"
                data-testid="code-workspace-replace-prepare-cancel"
                className="h-6 inline-flex items-center gap-1 rounded px-1.5 text-[11px] text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                onClick={cancelReplacePrepare}
              >
                <span>Cancel</span>
              </button>
            )}
            {replacePreparing && (
              <span
                data-testid="code-workspace-replace-preparing"
                className="flex items-center gap-1 text-[11px] text-[var(--taomni-code-muted)]"
              >
                <span>Preparing…</span>
              </span>
            )}
          </div>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-[var(--taomni-code-muted)]">
          {status === "searching" && <Loader2 className="h-3 w-3 animate-spin" />}
          {status === "searching" && `${totalShown} so far`}
          {status === "done" && summary && (
            `${summary.totalMatches} result${summary.totalMatches === 1 ? "" : "s"} · ${groups.length} file${groups.length === 1 ? "" : "s"}`
          )}
        </span>
      </div>
      {replaceCommitError && !replacePreview ? (
        <div
          role="alert"
          data-testid="code-workspace-replace-error"
          className="border-b border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-500"
        >
          {replaceCommitError}
        </div>
      ) : null}
      {replaceNotice && (
        <div
          data-testid="code-workspace-find-replaced-notice"
          className="shrink-0 border-b border-[var(--taomni-code-border)] px-2 py-1 text-[10px] text-[var(--taomni-code-muted)]"
        >
          Replaced {replaceNotice.appliedCount} occurrence{replaceNotice.appliedCount === 1 ? "" : "s"} in {replaceNotice.fileCount} file{replaceNotice.fileCount === 1 ? "" : "s"}
        </div>
      )}
      {(summary?.truncated || summary?.cancelled) && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] text-amber-500">
          {summary.cancelled ? "Search cancelled — results are partial." : `Match limit reached (${MAX_TOTAL_MATCHES}) — refine the query to see everything.`}
        </div>
      )}
      {scopePlan.status !== "ready" && (
        <div
          data-testid="code-workspace-find-scope-notice"
          className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] text-amber-500"
        >
          {scopePlan.reason} — switch scope or refresh project facts.
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {error && (
          <div data-testid="code-workspace-find-error" className="mx-2 mb-1 rounded border border-red-500/30 bg-red-500/10 p-2 text-red-500">{error}</div>
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
        {groups.map((group) => {
          const total = group.matches.length;
          const collapsed = Boolean(collapsedFiles[group.key]);
          const visibleLimit = visibleLimitFor(group.key, total);
          const visibleMatches = collapsed ? [] : group.matches.slice(0, visibleLimit);
          const hiddenCount = collapsed ? total : Math.max(0, total - visibleLimit);
          const Chevron = collapsed ? ChevronRight : ChevronDown;
          return (
            <section key={group.key} data-testid="code-workspace-find-file-group" data-file={group.title}>
              <button
                type="button"
                className="h-6 w-full flex items-center gap-2 px-3 font-medium text-[var(--taomni-code-muted)] hover:bg-[var(--taomni-code-active-line-bg)]"
                title={group.title}
                aria-expanded={!collapsed}
                aria-label={collapsed ? `Expand ${group.title}` : `Collapse ${group.title}`}
                onClick={() => toggleFileCollapsed(group.key)}
                onKeyDown={(event) => {
                  if (event.key !== "Delete") return;
                  event.preventDefault();
                  toggleFileExclusion(group.matches);
                }}
              >
                <Chevron className="h-3.5 w-3.5 shrink-0" />
                <File className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{group.title}</span>
                <span className="shrink-0 text-[10px] tabular-nums" data-testid="code-workspace-find-file-count">
                  {collapsed || hiddenCount === 0
                    ? `${total}`
                    : `${visibleLimit}/${total}`}
                </span>
              </button>
              {visibleMatches.map((match, index) => {
                const segments = matchSegments(match);
                const matchKey = workspaceSearchMatchKey(match);
                const excluded = excludedMatchKeys.has(matchKey);
                return (
                  <button
                    key={matchKey || `${match.lineNumber}:${match.column}:${index}`}
                    type="button"
                    ref={(element) => {
                      if (element) matchRefs.current.set(matchKey, element);
                      else matchRefs.current.delete(matchKey);
                    }}
                    data-testid="code-workspace-find-match-row"
                    data-match-key={matchKey}
                    data-excluded={excluded ? "true" : "false"}
                    aria-selected={focusedMatchKey === matchKey}
                    tabIndex={0}
                    className={`h-6 w-full min-w-0 flex items-center gap-2 px-4 text-left hover:bg-[var(--taomni-code-active-line-bg)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--taomni-accent)] ${excluded ? "text-[var(--taomni-code-muted)] line-through" : ""}`}
                    title={`${group.title}:${match.lineNumber}:${match.column}`}
                    onFocus={() => setFocusedMatchKey(matchKey)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setFocusedMatchKey(matchKey);
                      setContextMenu({ x: event.clientX, y: event.clientY, matchKey });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Delete") {
                        event.preventDefault();
                        toggleMatchExclusion(matchKey);
                        const indexInVisible = visibleMatchKeys.indexOf(matchKey);
                        moveMatchFocus(matchKey, indexInVisible >= 0 && indexInVisible < visibleMatchKeys.length - 1 ? 1 : -1);
                      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        moveMatchFocus(matchKey, event.key === "ArrowDown" ? 1 : -1);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        onOpenMatch(match, { preview: false });
                      }
                    }}
                    onClick={() => onOpenMatch(match, { preview: true })}
                    onDoubleClick={() => onOpenMatch(match, { preview: false })}
                  >
                    <span className="shrink-0 font-mono text-[10px] text-[var(--taomni-code-muted)]">
                      {match.lineNumber}:{match.column}
                    </span>
                    <span className="taomni-find-line min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--taomni-code-text)]">
                      {renderMatchLine(match, segments)}
                    </span>
                  </button>
                );
              })}
              {!collapsed && hiddenCount > 0 && (
                <div className="flex items-center gap-2 px-4 py-0.5 text-[10px] text-[var(--taomni-code-muted)]">
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
                    aria-label={`Show more matches in ${group.title}`}
                    data-testid="code-workspace-find-show-more"
                    onClick={() => showMoreForFile(group.key, total)}
                  >
                    Show more ({Math.min(MATCHES_PER_FILE_STEP, hiddenCount)} of {hiddenCount})
                  </button>
                  <button
                    type="button"
                    className="rounded px-1 py-0.5 hover:bg-[var(--taomni-code-active-line-bg)] hover:text-[var(--taomni-code-text)]"
                    aria-label={`Show all matches in ${group.title}`}
                    data-testid="code-workspace-find-show-all"
                    onClick={() => showAllForFile(group.key)}
                  >
                    Show all
                  </button>
                </div>
              )}
            </section>
          );
        })}
      </div>
      {replacePreview && (
        <div className="fixed inset-0 z-[940] flex items-center justify-center bg-black/40 p-4">
          <ReplacePreviewDialog
            edit={replacePreview.edit}
            replacement={replacePreview.replacement}
            scopeLabel={replaceScopeLabel(replacePreview.snapshot)}
            query={replacePreview.snapshot.query.query}
            initialExcludedKeys={replacePreview.initialExcludedKeys}
            committing={replaceCommitting}
            commitError={replaceCommitError}
            onCommit={(excluded) => void replace.commitReplacePreview(excluded)}
            onCancel={() => {
              restoreReplaceButtonFocusRef.current = true;
              setReplacePreview(null);
              setReplaceCommitError(null);
            }}
          />
        </div>
      )}
      {contextMenu && contextMenuMatch && contextMenuItems.length > 0 && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          appearance="code-candidates"
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  ));
}
