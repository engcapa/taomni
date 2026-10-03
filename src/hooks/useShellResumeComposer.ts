import { useEffect, useRef, useState } from "react";
import type { EntryOutcome, UseWelcomeSessionResumeResult } from "./useWelcomeSessionResume";
import { useShellLayoutStore } from "../stores/shellLayoutStore";
import { useAppStore } from "../stores/appStore";
import type { ShellRestoreSource } from "../lib/shell/types";
import type { CodeWorkspaceTabInfo } from "../types";
import { beginRestoreFocus } from "../lib/shell/restoreFocus";

export interface ShellRestoreOutcome {
  identity: string; name: string; status: "ready" | "partial" | "failed" | "cancelled"; tabId: string | null; error?: string;
}
export interface ShellResumeState {
  state: "loading" | "empty" | "available" | "restoring" | "awaiting-auth" | "succeeded" | "partial" | "failed";
  total: number; outcomes: ShellRestoreOutcome[]; error: string | null;
  start(): Promise<void>; retry(): Promise<void>; cancel(): void; clear(): Promise<void>;
}
type WorkspaceSource = Extract<ShellRestoreSource, { kind: "workspace" }>;
export function useShellResumeComposer(session: UseWelcomeSessionResumeResult,
  openWorkspace: (workspace: CodeWorkspaceTabInfo, signal: AbortSignal) => Promise<ShellRestoreOutcome>): ShellResumeState {
  const layout = useShellLayoutStore((s) => s.layout);
  const latest = useRef({ session, openWorkspace }); latest.current = { session, openWorkspace };
  const operation = useRef<AbortController | null>(null);
  const focusRelease = useRef<(() => boolean) | null>(null);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; focusRelease.current?.(); focusRelease.current = null; }, []);
  const candidates = useRef<Array<[string, WorkspaceSource]>>([]);
  const [outcomes, setOutcomes] = useState<ShellRestoreOutcome[]>([]);
  const outcomesRef = useRef(outcomes); outcomesRef.current = outcomes;
  const [state, setState] = useState<ShellResumeState["state"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionCount = "record" in session.view ? session.view.record.entries.length : 0;
  const sources = Object.entries(layout.restoreSources).filter((entry): entry is [string, WorkspaceSource] => entry[1].kind === "workspace")
    .sort(([a], [b]) => (layout.restoredTabs[a]?.order ?? 0) - (layout.restoredTabs[b]?.order ?? 0));
  const [total, setTotal] = useState<number | null>(null);
  const fromSession = (result: EntryOutcome): ShellRestoreOutcome => ({ identity: `run-entry:${result.identity}`, name: result.displayName, status: result.status, tabId: result.tabId, error: result.issue?.message });
  const run = async (retry: boolean) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    const releaseFocus = beginRestoreFocus(); focusRelease.current = releaseFocus;
    const lastActiveRef = useShellLayoutStore.getState().layout.lastActiveRestoreRef;
    if (!retry) candidates.current = sources;
    const wanted = retry ? candidates.current.filter(([ref]) => outcomesRef.current.some((o) => o.identity === ref && ["failed", "cancelled"].includes(o.status))) : candidates.current;
    let results = retry ? outcomesRef.current.filter((o) => !wanted.some(([ref]) => ref === o.identity)) : [];
    setState("restoring"); setError(null); setOutcomes(results); setTotal(retry ? outcomesRef.current.length : sessionCount + wanted.length);
    try {
      const sessionResults = retry ? await latest.current.session.retryFailed() : await latest.current.session.startRestore();
      for (const result of sessionResults) { const converted = fromSession(result); results = [...results.filter((o) => o.identity !== converted.identity), converted]; }
      setOutcomes([...results]);
      for (const [identity, source] of wanted) {
        let result: ShellRestoreOutcome;
        if (controller.signal.aborted) result = { identity, name: source.workspace.name ?? source.workspace.repoRoot, status: "cancelled", tabId: null };
        else {
          try { result = { ...await latest.current.openWorkspace({ ...source.workspace, workspaceInstanceId: source.workspaceInstanceId }, controller.signal), identity }; }
          catch (failure) { result = { identity, name: source.workspace.name ?? source.workspace.repoRoot, status: controller.signal.aborted ? "cancelled" : "failed", tabId: null, error: String(failure) }; }
        }
        if (operation.current !== controller) return;
        results = [...results.filter((o) => o.identity !== identity), result]; setOutcomes([...results]);
      }
      const failures = results.filter((o) => ["failed", "cancelled"].includes(o.status)).length;
      setState(failures === 0 ? "succeeded" : failures === results.length ? "failed" : "partial");
      const active = results.find((o) => o.identity === lastActiveRef && ["ready", "partial"].includes(o.status)) ?? results.find((o) => o.status === "ready");
      if (releaseFocus() && !controller.signal.aborted && active?.tabId) useAppStore.getState().setActiveTab(active.tabId);
    } catch (failure) { if (operation.current === controller) { setState("failed"); setError(String(failure)); } }
    finally { releaseFocus(); if (focusRelease.current === releaseFocus) focusRelease.current = null; if (operation.current === controller) operation.current = null; }
  };
  const clear = async () => {
    if (operation.current) return;
    try {
      await latest.current.session.clearRecord();
      const shell = useShellLayoutStore.getState();
      shell.updateLayout((value) => ({ ...value, restoreSources: {}, restoredTabs: {}, panelOverrides: {}, lastActiveRestoreRef: undefined }));
      shell.flush();
      if (useShellLayoutStore.getState().warning === "write") throw new Error("Session record cleared, but layout restore intentions could not be saved. Retry clearing.");
      candidates.current = []; setOutcomes([]); setState("empty"); setTotal(0); setError(null);
    } catch (failure) { setError(String(failure)); }
  };
  return { state: operation.current && session.view.state === "awaiting-auth" ? "awaiting-auth" : state ?? (session.view.state === "loading" ? "loading" : sessionCount + sources.length ? "available" : "empty"),
    total: total ?? sessionCount + sources.length, outcomes, error, start: () => run(false), retry: () => run(true),
    cancel: () => { operation.current?.abort(); latest.current.session.cancelRestore(); }, clear };
}
