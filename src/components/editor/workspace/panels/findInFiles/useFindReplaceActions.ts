import { useCallback } from "react";
import type { LspWorkspaceEdit } from "../../../../../lib/editor/lsp";
import { type WorkspaceSearchMatch } from "../../../../../lib/editor/workspaceSearch";
import { workspaceSearchMatchKey } from "../../buildReplaceEdits";
import { type FindInFilesScopePlan } from "../../findInFilesScopeModel";
import {
  buildReplaceInFilesWorkspaceEdit,
  createReplaceInFilesPlan,
  replaceEditSignature,
  replaceMatchAbsolutePath,
  replaceScopeIdentityFromPlan,
  searchMatchesToReplaceInputs,
  validateReplacePreviewSelection,
  type ReplaceFilePreimage,
  type ReplaceInFilesPlan,
  type ReplacePreviewSnapshot,
} from "../../replaceInFilesModel";
import { usageJoinKeyForMatch } from "./formatting";
import { splitGlobs } from "./limits";
import { type MatchGroup, type SearchSummary } from "./types";

export interface UseFindReplaceActionsContext {
  onReplaceMatches: ((matches: WorkspaceSearchMatch[], replacement: string, edit: LspWorkspaceEdit, snapshot: ReplacePreviewSnapshot) => Promise<{ ok: boolean; appliedCount?: number; fileCount?: number; message?: string; }>) | undefined;
  includedMatches: WorkspaceSearchMatch[];
  replacePreview: { edit: LspWorkspaceEdit; plan: ReplaceInFilesPlan; matches: WorkspaceSearchMatch[]; usageToMatchKey: ReadonlyMap<string, string>; stableToUsageId: ReadonlyMap<string, string>; initialExcludedKeys: ReadonlySet<string>; replacement: string; snapshot: ReplacePreviewSnapshot; } | null;
  replacePreparingRef: import("react").RefObject<boolean>;
  setReplacePreparing: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setReplaceCommitError: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  replacePrepareTokenRef: import("react").RefObject<number>;
  replaceAbortControllerRef: import("react").RefObject<AbortController | null>;
  scopePlan: FindInFilesScopePlan;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  includeGlobs: string;
  excludeGlobs: string;
  replacement: string;
  allMatches: WorkspaceSearchMatch[];
  workspaceInstanceId: string | undefined;
  onPrepareReplacePreimages: ((paths: readonly string[], options?: import("../../replaceInFilesModel").ReplacePrepareOptions) => Promise<readonly ReplaceFilePreimage[]>) | undefined;
  setReplacePreview: import("react").Dispatch<import("react").SetStateAction<{ edit: LspWorkspaceEdit; plan: ReplaceInFilesPlan; matches: WorkspaceSearchMatch[]; usageToMatchKey: ReadonlyMap<string, string>; stableToUsageId: ReadonlyMap<string, string>; initialExcludedKeys: ReadonlySet<string>; replacement: string; snapshot: ReplacePreviewSnapshot; } | null>>;
  excludedMatchKeys: ReadonlySet<string>;
  setReplaceCommitting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setGroups: import("react").Dispatch<import("react").SetStateAction<MatchGroup[]>>;
  setExcludedMatchKeys: import("react").Dispatch<import("react").SetStateAction<ReadonlySet<string>>>;
  setSummary: import("react").Dispatch<import("react").SetStateAction<SearchSummary | null>>;
  setReplaceNotice: import("react").Dispatch<import("react").SetStateAction<{ appliedCount: number; fileCount: number; } | null>>;
  pendingMatchFocusRef: import("react").RefObject<string | null>;
  inputRef: import("react").RefObject<HTMLInputElement | null>;
}

export function useFindReplaceActions(context: UseFindReplaceActionsContext) {
  const {
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
  } = context;

  const replaceAll = useCallback(async () => {
    if (!onReplaceMatches || includedMatches.length === 0 || replacePreview || replacePreparingRef.current) return;
    // ED-REPAIR-005: synchronously claim preparing state to prevent duplicate calls in the same event loop
    replacePreparingRef.current = true;
    setReplacePreparing(true);
    setReplaceCommitError(null);
    const token = ++replacePrepareTokenRef.current;
    if (replaceAbortControllerRef.current) {
      replaceAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    replaceAbortControllerRef.current = abortController;

    const frozenScope = replaceScopeIdentityFromPlan(scopePlan);
    const frozenQuery = {
      query: query.trim(),
      caseSensitive,
      wholeWord,
      regexp,
      includeGlobs: splitGlobs(includeGlobs),
      excludeGlobs: splitGlobs(excludeGlobs),
    };
    const frozenReplacement = replacement;
    const frozenMatches = allMatches;
    const frozenMatchKeys = allMatches.map(workspaceSearchMatchKey);
    const frozenInstanceId = workspaceInstanceId ?? "";
    const preparedAt = Date.now();

    // ED-FIND-004 A1: freeze the preimage — model matches, edit, and plan —
    // at dialog open. Commit reconfirms against live disk state (A2/A3).
    // ED-MAIN-004: an illegal backend match offset is reported with a reason
    // instead of being clamped into a different valid range.
    let modelMatches: ReturnType<typeof searchMatchesToReplaceInputs>;
    try {
      modelMatches = searchMatchesToReplaceInputs(frozenMatches);
    } catch (error) {
      if (token !== replacePrepareTokenRef.current) return;
      replacePreparingRef.current = false;
      setReplacePreparing(false);
      setReplaceCommitError(error instanceof Error ? error.message : String(error));
      return;
    }
    const edit = buildReplaceInFilesWorkspaceEdit({ matches: modelMatches, replacementText: frozenReplacement });
    const plan = createReplaceInFilesPlan(edit);
    // ED-MAIN-005: freeze the per-file preimage before the preview can be
    // confirmed. A prepare failure is visible and commits nothing.
    let preimages: readonly ReplaceFilePreimage[] = [];
    if (onPrepareReplacePreimages) {
      try {
        preimages = await onPrepareReplacePreimages(
          [...new Set(modelMatches.map((match) => match.filePath))],
          { token, workspaceInstanceId: frozenInstanceId, signal: abortController.signal },
        );
      } catch (error) {
        if (token !== replacePrepareTokenRef.current) return;
        replacePreparingRef.current = false;
        setReplacePreparing(false);
        setReplaceCommitError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (token !== replacePrepareTokenRef.current) return;
    replacePreparingRef.current = false;
    setReplacePreparing(false);
    setReplaceCommitError(null);

    // Join preview usage ids back to search-match keys for exclusion.
    const remaining = new Map<string, WorkspaceSearchMatch[]>();
    for (const match of frozenMatches) {
      const key = usageJoinKeyForMatch(match);
      const list = remaining.get(key);
      if (list) list.push(match);
      else remaining.set(key, [match]);
    }
    const usageToMatchKey = new Map<string, string>();
    const stableToUsageId = new Map<string, string>();
    for (const usage of plan.preview.usages) {
      const key = `${usage.path}:${usage.range.start.line}:${usage.range.start.character}:${usage.range.end.line}:${usage.range.end.character}`;
      const list = remaining.get(key);
      const target = list?.shift();
      if (target) {
        usageToMatchKey.set(usage.id, workspaceSearchMatchKey(target));
        if (!stableToUsageId.has(key)) stableToUsageId.set(key, usage.id);
      }
      if (list && list.length === 0) remaining.delete(key);
    }
    const snapshot: ReplacePreviewSnapshot = {
      scope: frozenScope,
      query: frozenQuery,
      replacement: frozenReplacement,
      matchKeys: frozenMatchKeys,
      matchCount: modelMatches.length,
      editSignature: replaceEditSignature(edit),
      capturedAt: preparedAt,
      preimages,
      requestIdentity: {
        token,
        workspaceInstanceId: frozenInstanceId,
        scope: frozenScope,
        query: frozenQuery,
        replacement: frozenReplacement,
        matchKeys: frozenMatchKeys,
        matchCount: modelMatches.length,
        preparedAt,
      },
    };
    setReplacePreview({
      edit,
      plan,
      matches: frozenMatches,
      usageToMatchKey,
      stableToUsageId,
      initialExcludedKeys: new Set(
        frozenMatches
          .filter((match) => excludedMatchKeys.has(workspaceSearchMatchKey(match)))
          .map(usageJoinKeyForMatch),
      ),
      replacement: frozenReplacement,
      snapshot,
    });
  }, [
    allMatches,
    caseSensitive,
    excludedMatchKeys,
    excludeGlobs,
    includeGlobs,
    includedMatches.length,
    onPrepareReplacePreimages,
    onReplaceMatches,
    query,
    regexp,
    replacePreview,
    replacement,
    scopePlan,
    wholeWord,
    workspaceInstanceId,
  ]);

  const commitReplacePreview = useCallback(async (excludedStableKeys: ReadonlySet<string>) => {
    const preview = replacePreview;
    if (!preview || !onReplaceMatches) return;
    // Stable content keys back to the ORIGINAL plan usage ids (positional
    // ids shift across recomputes, so the dialog never sees them).
    const excludedUsageIds = new Set<string>();
    for (const stableKey of excludedStableKeys) {
      const usageId = preview.stableToUsageId.get(stableKey);
      if (usageId) excludedUsageIds.add(usageId);
    }
    const excludedMatchKeys = new Set<string>();
    for (const usageId of excludedUsageIds) {
      const key = preview.usageToMatchKey.get(usageId);
      if (key) excludedMatchKeys.add(key);
    }
    const filteredMatches = preview.matches.filter(
      (match) => !excludedMatchKeys.has(workspaceSearchMatchKey(match)),
    );
    const filteredEdit = createReplaceInFilesPlan(
      preview.edit,
      excludedUsageIds,
    ).filteredEdit;
    // ED-IMPROVE-005: the frozen snapshot is the only source of truth; the
    // selected set must be a subset of it with one frozen-replacement edit
    // per match. Live replacement/query/scope changes cannot alter it.
    const selection = validateReplacePreviewSelection(
      preview.snapshot,
      new Set(filteredMatches.map(workspaceSearchMatchKey)),
      filteredEdit,
      preview.edit,
    );
    if (!selection.ok) {
      setReplaceCommitError(selection.reason ?? "Replace selection is stale; reopen the preview");
      return;
    }
    setReplaceCommitting(true);
    setReplaceCommitError(null);
    try {
      const result = await onReplaceMatches(
        filteredMatches,
        preview.replacement,
        filteredEdit,
        preview.snapshot,
      );
      if (result.ok) {
        const committedKeys = new Set(filteredMatches.map(workspaceSearchMatchKey));
        const remainingMatches = allMatches.filter((match) => !committedKeys.has(workspaceSearchMatchKey(match)));
        const remainingFirstKey = remainingMatches[0] ? workspaceSearchMatchKey(remainingMatches[0]) : null;
        setGroups((current) => current
          .map((group) => ({
            ...group,
            matches: group.matches.filter((match) => !committedKeys.has(workspaceSearchMatchKey(match))),
          }))
          .filter((group) => group.matches.length > 0));
        setExcludedMatchKeys((current) => new Set(
          [...current].filter((key) => !committedKeys.has(key)),
        ));
        setSummary((current) => current ? {
          ...current,
          totalMatches: remainingMatches.length,
        } : current);
        setReplaceNotice({
          appliedCount: result.appliedCount ?? filteredMatches.length,
          fileCount: result.fileCount ?? new Set(filteredMatches.map((match) => replaceMatchAbsolutePath(match))).size,
        });
        setReplacePreview(null);
        setReplaceCommitError(null);
        if (remainingFirstKey) {
          pendingMatchFocusRef.current = remainingFirstKey;
        } else {
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      } else {
        setReplaceCommitError(result.message ?? "Replace blocked");
      }
    } finally {
      setReplaceCommitting(false);
    }
  }, [allMatches, onReplaceMatches, replacePreview]);
  return { replaceAll, commitReplacePreview };
}
