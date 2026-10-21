import type { Language } from "@codemirror/language";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import {
  newWorkspaceSearchId,
  subscribeWorkspaceSearch,
  workspaceSearchCancel,
  workspaceSearchStart,
  type WorkspaceSearchMatch,
  type WorkspaceSearchRoot,
} from "../../../../../lib/editor/workspaceSearch";
import { useProjectFactsStore, type WorkspaceProjectFactsEntry } from "../../../../../stores/projectFactsStore";
import { isFileInScopePlan, type FindInFilesScopeKind, type FindInFilesScopePlan } from "../../findInFilesScopeModel";
import { type ReplaceInFilesPlan, type ReplacePreviewSnapshot } from "../../replaceInFilesModel";
import { pushWorkspaceSearchHistory, readWorkspaceSearchHistory } from "../../workspaceLayoutPersistence";
import { groupKey, groupTitle } from "./formatting";
import { MAX_TOTAL_MATCHES, splitGlobs } from "./limits";
import { type MatchGroup, type SearchStatus, type SearchSummary } from "./types";

export interface UseFindSearchLifetimeContext {
  setReplacePreview: Dispatch<SetStateAction<{ edit: LspWorkspaceEdit; plan: ReplaceInFilesPlan; matches: WorkspaceSearchMatch[]; usageToMatchKey: ReadonlyMap<string, string>; stableToUsageId: ReadonlyMap<string, string>; initialExcludedKeys: ReadonlySet<string>; replacement: string; snapshot: ReplacePreviewSnapshot; } | null>>;
  setReplaceCommitError: Dispatch<SetStateAction<string | null>>;
  setExcludedMatchKeys: Dispatch<SetStateAction<ReadonlySet<string>>>;
  setReplaceNotice: Dispatch<SetStateAction<{ appliedCount: number; fileCount: number; } | null>>;
  setContextMenu: Dispatch<SetStateAction<{ x: number; y: number; matchKey: string; } | null>>;
  setFocusedMatchKey: Dispatch<SetStateAction<string | null>>;
  pendingMatchFocusRef: RefObject<string | null>;
  setSearchHistory: Dispatch<SetStateAction<string[]>>;
  workspaceInstanceId: string | undefined;
  query: string;
  roots: import("../../../../../types").CodeWorkspaceRootInfo[];
  setGroups: Dispatch<SetStateAction<MatchGroup[]>>;
  setSummary: Dispatch<SetStateAction<SearchSummary | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setFileExpand: Dispatch<SetStateAction<Record<string, number | "all">>>;
  setCollapsedFiles: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLanguagesByPath: Dispatch<SetStateAction<Record<string, Language | null>>>;
  setStatus: Dispatch<SetStateAction<SearchStatus>>;
  scopePlan: FindInFilesScopePlan;
  factsEntry: WorkspaceProjectFactsEntry | null;
  workspaceRoot: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  includeGlobs: string;
  excludeGlobs: string;
  factsModules: readonly import("../../projectStructureModel").ProjectStructureModuleV2[];
  scopeDirectory: string;
  scopeKind: FindInFilesScopeKind;
  scopeModuleId: string;
}

export function useFindSearchLifetime(context: UseFindSearchLifetimeContext) {
  const {
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
  } = context;
  const searchIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const groupsRef = useRef<Map<string, MatchGroup>>(new Map());
  const languagesRef = useRef<Record<string, Language | null>>({});

  const teardownSearch = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    const active = searchIdRef.current;
    searchIdRef.current = null;
    // ED-FIND-004: a superseded search invalidates any open replace preview
    // so a stale plan can never commit.
    setReplacePreview(null);
    setReplaceCommitError(null);
    setExcludedMatchKeys(new Set());
    setReplaceNotice(null);
    setContextMenu(null);
    setFocusedMatchKey(null);
    pendingMatchFocusRef.current = null;
    if (active) void workspaceSearchCancel(active).catch(() => { });
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
    setExcludedMatchKeys(new Set());
    setReplaceNotice(null);
    setContextMenu(null);
    setFocusedMatchKey(null);
    setSummary(null);
    setError(null);
    setFileExpand({});
    setCollapsedFiles({});
    languagesRef.current = {};
    setLanguagesByPath({});
    setStatus("searching");

    // ED-FIND-003 A1: the scope plan is built live (scopePlan memo) so the
    // notice below and the search consume one plan. Unresolved plans
    // (module scope without ready facts) fail closed here with a visible
    // reason and never reach the backend (A3).
    const plan = scopePlan;
    if (plan.status !== "ready") {
      setStatus("error");
      setError(plan.reason);
      return;
    }
    // Project scope spans every workspace root; module/directory scopes use
    // the exact plan roots. Client-side filtering below applies to
    // facts-derived scopes only, so other roots' matches are never dropped.
    const filterPlan = plan.kind === "project" ? null : plan;
    const planStructure = factsEntry?.structure ?? null;
    const searchRoots: WorkspaceSearchRoot[] = filterPlan === null
      ? roots.map((root) => ({ id: root.id, name: root.name, path: root.path }))
      : plan.roots.map((rootPath, index) => ({
        id: `scope-${index}`,
        name: rootPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? rootPath,
        path: rootPath,
      }));

    const searchId = newWorkspaceSearchId();
    searchIdRef.current = searchId;
    try {
      const unlisten = await subscribeWorkspaceSearch(searchId, (event) => {
        if (searchIdRef.current !== searchId) return;
        // ED-FIND-003 A4: facts-derived scopes stop publishing once the
        // snapshot moves under a running search. Filesystem scopes are
        // facts-independent and keep streaming.
        if (filterPlan !== null && filterPlan.generation !== undefined) {
          const liveGeneration = useProjectFactsStore
            .getState()
            .getWorkspaceFacts(workspaceRoot).generation;
          if (liveGeneration !== filterPlan.generation) {
            teardownSearch();
            setStatus("error");
            setError(
              `Project facts changed during search (G${filterPlan.generation} -> G${liveGeneration}); run the search again`,
            );
            return;
          }
        }
        if (event.kind === "batch") {
          for (const match of event.matches) {
            if (filterPlan !== null) {
              const absolute = `${(match.rootPath ?? "").replace(/\/+$/, "")}/${(match.path ?? "").replace(/^\/+/, "")}`;
              if (!isFileInScopePlan(absolute, filterPlan, planStructure)) continue;
            }
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
        searchRoots,
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
  }, [caseSensitive, excludeGlobs, factsEntry, factsModules, includeGlobs, query, regexp, roots, scopeDirectory, scopeKind, scopeModuleId, teardownSearch, wholeWord, workspaceInstanceId, workspaceRoot]);

  const cancelSearch = useCallback(() => {
    const active = searchIdRef.current;
    if (!active) return;
    void workspaceSearchCancel(active).catch(() => { });
  }, []);
  return { languagesRef, startSearch, cancelSearch };
}
