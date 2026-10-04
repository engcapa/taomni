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
type LocalSource = Exclude<ShellRestoreSource, { kind: "run-entry" }>;
type UnsupportedSource = Extract<ShellRestoreSource, { kind: "unsupported" }>;
export function useShellResumeComposer(session: UseWelcomeSessionResumeResult,
  openWorkspace: (workspace: CodeWorkspaceTabInfo, signal: AbortSignal) => Promise<ShellRestoreOutcome>,
  openUnsupported?: (source: UnsupportedSource) => Promise<ShellRestoreOutcome>): ShellResumeState {
  const layout = useShellLayoutStore((s) => s.layout);
  const latest = useRef({ session, openWorkspace, openUnsupported }); latest.current = { session, openWorkspace, openUnsupported };
  const operation = useRef<AbortController | null>(null);
  const focusRelease = useRef<(() => boolean) | null>(null);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; focusRelease.current?.(); focusRelease.current = null; }, []);
  const candidates = useRef<Array<[string, LocalSource]>>([]);
  const [outcomes, setOutcomes] = useState<ShellRestoreOutcome[]>([]);
  const outcomesRef = useRef(outcomes); outcomesRef.current = outcomes;
  const [state, setState] = useState<ShellResumeState["state"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionCount = "record" in session.view ? session.view.record.entries.length : 0;
  const sources = Object.entries(layout.restoreSources).filter((entry): entry is [string, LocalSource] => entry[1].kind !== "run-entry")
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
    const entryOrder = new Map([
      ...("record" in latest.current.session.view ? latest.current.session.view.record.entries.map((entry) => `run-entry:${entry.identity}`) : []),
      ...candidates.current.map(([identity]) => identity),
    ].map((identity, index) => [identity, index]));
    const publish = (result: ShellRestoreOutcome) => {
      if (operation.current !== controller) return;
      results = [...results.filter((outcome) => outcome.identity !== result.identity), result]
        .sort((a, b) => (entryOrder.get(a.identity) ?? Infinity) - (entryOrder.get(b.identity) ?? Infinity));
      setOutcomes([...results]);
    };
    setState("restoring"); setError(null); setOutcomes(results); setTotal(retry ? outcomesRef.current.length : sessionCount + wanted.length);
    try {
      const restoreLocal = async ([identity, source]: [string, LocalSource]) => {
        let result: ShellRestoreOutcome;
        const name = source.kind === "workspace" ? source.workspace.name ?? source.workspace.repoRoot : source.title;
        if (controller.signal.aborted) result = { identity, name, status: "cancelled", tabId: null };
        else {
          try {
            if (source.kind === "workspace") result = { ...await latest.current.openWorkspace({ ...source.workspace, workspaceInstanceId: source.workspaceInstanceId }, controller.signal), identity };
            else {
              if (!latest.current.openUnsupported) throw new Error("This view is not supported by this version.");
              result = { ...await latest.current.openUnsupported(source), identity };
            }
          } catch (failure) { result = { identity, name, status: controller.signal.aborted ? "cancelled" : "failed", tabId: null, error: String(failure) }; }
        }
        if (operation.current !== controller) return;
        publish(result);
      };
      // Independent workspaces must not wait behind an authentication prompt
      // or another workspace's slow readiness. Bound concurrent opens while
      // binding every outcome and final focus to its saved identity.
      let next = 0;
      const worker = async () => {
        while (next < wanted.length) await restoreLocal(wanted[next++]);
      };
      let sessionFailure: unknown;
      const restoreSessions = async () => {
        try {
          const sessionResults = retry ? await latest.current.session.retryFailed() : await latest.current.session.startRestore();
          for (const result of sessionResults) publish(fromSession(result));
        } catch (failure) { sessionFailure = failure; }
      };
      await Promise.all([restoreSessions(), ...Array.from({ length: Math.min(4, wanted.length) }, worker)]);
      if (operation.current !== controller) return;
      const failures = results.filter((o) => ["failed", "cancelled"].includes(o.status)).length;
      if (sessionFailure) setError(String(sessionFailure));
      setState(sessionFailure ? results.some((outcome) => outcome.status === "ready") ? "partial" : "failed" : failures === 0 ? "succeeded" : failures === results.length ? "failed" : "partial");
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
