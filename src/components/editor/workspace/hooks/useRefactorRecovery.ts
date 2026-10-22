import { useCallback,useEffect,useRef,useState } from "react";
import { type LspWorkspaceEdit,type LspWorkspaceEditOperation } from "../../../../lib/editor/lsp";
import { listRefactorRecoveryJournalsV2,isPendingRefactorRecoveryEntry,type RefactorRecoveryJournalEntryV2 } from "../refactorPlan";
import { classifyRefactorRecoveryPreconditions,type RefactorRecoveryPreconditionSummary } from "../refactorRecoveryController";
import { type WorkspaceEditPathSnapshot } from "../workspaceEditHistory";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { createRunRecoveryRestore } from "../controller/recoveryActions";
import { type WorkspaceEditApplyOptions } from "../controller/mutationTypes";
import { createRunRecoveryDismiss,createPromptRefactorRecoveryEntry } from "../controller/recoveryJournal";


export interface UseRefactorRecoveryContext {
  readWorkspaceEditPathSnapshot: (absolutePath: string) => Promise<WorkspaceEditPathSnapshot|null>;
  workspaceInstanceIdRef: import("react").RefObject<string>;
  replayWorkspaceEncodingRef: import("react").RefObject<Map<string,{ encoding: string; bom: boolean; eol?: "lf"|"crlf"|"cr"; }>|null>;
  replayWorkspaceRestoreRef: import("react").RefObject<boolean>;
  applyLspWorkspaceEditNow: (edit: LspWorkspaceEdit,options?: WorkspaceEditApplyOptions) => Promise<import("../workspaceEditApply").WorkspaceEditApplyOutcome[]>;
  restoreEchoSuppressorRef: import("react").RefObject<import("../refactorRecoveryController").RestoreEchoSuppressor>;
  applyLspResourceOperation: (operation: Exclude<LspWorkspaceEditOperation,{ kind: "text"; }>) => Promise<void>;
  refreshTree: () => void;
  setStatusMessage: (message: string) => void;
  workspaceInstanceId: string;
  roots: CodeWorkspaceRootInfo[];
}

export function useRefactorRecovery(context: UseRefactorRecoveryContext) {
  const {
    readWorkspaceEditPathSnapshot,
    workspaceInstanceIdRef,
    replayWorkspaceEncodingRef,
    replayWorkspaceRestoreRef,
    applyLspWorkspaceEditNow,
    restoreEchoSuppressorRef,
    applyLspResourceOperation,
    refreshTree,
    setStatusMessage,
    workspaceInstanceId,
    roots,
  }=context;

  // ED-AUDIT-014: pending refactor recovery entries are surfaced through the
  // review dialog when the workspace becomes ready. The runner is held in a
  // ref because it closes over callbacks defined above.
  const refactorRecoveryPromptRef=useRef<(
    (entry: RefactorRecoveryJournalEntryV2,ownerInstanceId: string) => Promise<void>
  )|null>(null);
  const handledRefactorRecoveryIdsRef=useRef<Set<string>>(new Set());
  const handledRefactorRecoveryOwnerRef=useRef<string|null>(null);
  // RC-02: one-entry review dialog state (figure A). The dialog owns the
  // A→B abandon confirm inline (cancel-focused); restore's second confirm
  // reuses the global app dialog. Async work stays in this owner.
  const [refactorRecoveryReview,setRefactorRecoveryReview]=useState<{
    entry: RefactorRecoveryJournalEntryV2;
    ownerInstanceId: string;
    preconditions: RefactorRecoveryPreconditionSummary|null;
    loading: boolean;
    error: string|null;
    busy: boolean;
  }|null>(null);
  const refactorRecoveryBusyRef=useRef<Set<string>>(new Set());
  const refactorRecoveryResolveRef=useRef<Map<string,() => void>>(new Map());
  const refactorRecoveryReviewRef=useRef<typeof refactorRecoveryReview|null>(null);
  refactorRecoveryReviewRef.current=refactorRecoveryReview;

  const closeRefactorRecoveryReview=useCallback((recoveryId: string) => {
    setRefactorRecoveryReview((current) => (
      current&&current.entry.recoveryId===recoveryId? null:current
    ));
    const resolve=refactorRecoveryResolveRef.current.get(recoveryId);
    if(resolve) {
      refactorRecoveryResolveRef.current.delete(recoveryId);
      resolve();
    }
  },[]);

  const classifyRecoveryEntry=useCallback(async (
    entry: RefactorRecoveryJournalEntryV2,
  ): Promise<RefactorRecoveryPreconditionSummary> => classifyRefactorRecoveryPreconditions(entry,async (path) => {
    const snapshot=await readWorkspaceEditPathSnapshot(path);
    return snapshot&&snapshot.text!==null? { text: snapshot.text }:null;
  },{
    pathExists: async (path) => {
      const snapshot=await readWorkspaceEditPathSnapshot(path);
      return snapshot===null? null:snapshot.exists;
    },
  }),[readWorkspaceEditPathSnapshot]);

  const runRecoveryRestore=useCallback(createRunRecoveryRestore({
    workspaceInstanceIdRef,
    refactorRecoveryBusyRef,
    setRefactorRecoveryReview,
    readWorkspaceEditPathSnapshot,
    replayWorkspaceEncodingRef,
    replayWorkspaceRestoreRef,
    applyLspWorkspaceEditNow,
    restoreEchoSuppressorRef,
    applyLspResourceOperation,
    refreshTree,
    setStatusMessage,
    closeRefactorRecoveryReview,
    classifyRecoveryEntry,
  }),[applyLspResourceOperation,applyLspWorkspaceEditNow,classifyRecoveryEntry,closeRefactorRecoveryReview,readWorkspaceEditPathSnapshot,refreshTree,setStatusMessage]);

  const runRecoveryDismiss=useCallback(createRunRecoveryDismiss({
    workspaceInstanceIdRef,
    refactorRecoveryBusyRef,
    setRefactorRecoveryReview,
    setStatusMessage,
    closeRefactorRecoveryReview,
  }),[closeRefactorRecoveryReview,setStatusMessage]);

  const keepRecoveryReview=useCallback((recoveryId: string) => {
    closeRefactorRecoveryReview(recoveryId);
  },[closeRefactorRecoveryReview]);

  const promptRefactorRecoveryEntry=useCallback(createPromptRefactorRecoveryEntry({
    workspaceInstanceIdRef,
    refactorRecoveryBusyRef,
    refactorRecoveryResolveRef,
    setRefactorRecoveryReview,
    classifyRecoveryEntry,
    closeRefactorRecoveryReview,
    setStatusMessage,
  }),[classifyRecoveryEntry,closeRefactorRecoveryReview,setStatusMessage]);
  refactorRecoveryPromptRef.current=promptRefactorRecoveryEntry;

  useEffect(() => {
    if(handledRefactorRecoveryOwnerRef.current!==workspaceInstanceId) {
      handledRefactorRecoveryOwnerRef.current=workspaceInstanceId;
      handledRefactorRecoveryIdsRef.current=new Set();
      // RC-02: workspace switch releases pending dialogs; stale async
      // results must never commit to the new instance.
      for(const resolve of refactorRecoveryResolveRef.current.values()) {
        try { resolve(); } catch { /* ignore */ }
      }
      refactorRecoveryResolveRef.current.clear();
      refactorRecoveryBusyRef.current.clear();
      setRefactorRecoveryReview(null);
    }
    let disposed=false;
    const discover=async () => {
      const rootPath=roots[0]?.path;
      const runner=refactorRecoveryPromptRef.current;
      if(!rootPath||!runner) return;
      const listing=listRefactorRecoveryJournalsV2(rootPath);
      const pending=listing.entries.filter(isPendingRefactorRecoveryEntry);
      for(const entry of pending) {
        if(disposed) return;
        if(workspaceInstanceIdRef.current!==workspaceInstanceId) return;
        if(handledRefactorRecoveryIdsRef.current.has(entry.recoveryId)) continue;
        handledRefactorRecoveryIdsRef.current.add(entry.recoveryId);
        await runner(entry,workspaceInstanceId);
      }
    };
    void discover();
    return () => {
      disposed=true;
    };
  },[roots,workspaceInstanceId]);
  return { promptRefactorRecoveryEntry,refactorRecoveryReview,keepRecoveryReview,refactorRecoveryReviewRef,runRecoveryRestore,runRecoveryDismiss };
}
