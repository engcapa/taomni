import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { consumeDetachedHandoff, clearDetachedHandoff, subscribePanelWindow } from "../../lib/detachedSession";
import { closeCurrentDetachedWindow } from "../../lib/detachWindowing";
import { matchesPanelWindow, signalPanelWindow, waitPanelWindow } from "../../lib/shell/panelWindowTransaction";
import { getGitShellController, validateGitShellSnapshot, type GitShellSnapshot } from "../../lib/shell/gitShellState";
import type { PanelWindowEnvelope } from "../../lib/shell/types";
import type { GitWorkspaceRootInfo } from "../../types";
import { WorkspaceGitManager } from "../git/WorkspaceGitManager";
import { GitPanel } from "../git/GitPanel";
import { isTauriRuntime } from "../../lib/runtime";
import { useAppTheme } from "../../lib/appTheme";
import { useT } from "../../lib/i18n";

export interface GitDetachedPayload {
  title: string; roots: GitWorkspaceRootInfo[]; activeRepoRoot?: string;
  envelope: PanelWindowEnvelope; snapshot: GitShellSnapshot | null;
  singleRepository?: boolean;
}
export function GitDetachedWindow({ id }: { id: string }) {
  const [payload] = useState(() => consumeDetachedHandoff<GitDetachedPayload>("git", id));
  const [error, setError] = useState<string | null>(null), [committed, setCommitted] = useState(false);
  const closing = useRef(false), t = useT(), theme = useAppTheme();
  const scopeId = payload ? `${payload.envelope.panelId}:window:${id}` : id;
  useEffect(() => { document.documentElement.dataset.appTheme = theme.resolvedTheme; }, [theme.resolvedTheme]);
  const reattach = useCallback(async () => {
    if (!payload || closing.current) return;
    closing.current = true; setError(null);
    try {
      const ack = waitPanelWindow(payload.envelope, "reattached");
      signalPanelWindow(payload.envelope, "request-reattach", getGitShellController(scopeId)?.snapshot());
      await ack;
      clearDetachedHandoff("git", id);
      if (isTauriRuntime()) await closeCurrentDetachedWindow(); else window.close();
    } catch (failure) { setError(String(failure)); closing.current = false; }
  }, [payload, id, scopeId]);
  useEffect(() => {
    if (!payload) return;
    return subscribePanelWindow((message) => {
      if (!matchesPanelWindow(payload.envelope, message.envelope)) return;
      if (message.envelope.event === "commit") { const snapshot = validateGitShellSnapshot(message.data); if (snapshot) getGitShellController(scopeId)?.restore(snapshot); setCommitted(true); clearDetachedHandoff("git", id); }
      if (message.envelope.event === "request-focus") { if (isTauriRuntime()) void getCurrentWindow().show().then(() => getCurrentWindow().setFocus()); else window.focus(); }
      if (message.envelope.event === "request-reattach") void reattach();
      if (message.envelope.event === "cancel") { if (isTauriRuntime()) void closeCurrentDetachedWindow(); else window.close(); }
    });
  }, [payload, scopeId, id, reattach]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let off: (() => void) | undefined, disposed = false;
    void getCurrentWindow().onCloseRequested((event) => { event.preventDefault(); void reattach(); }).then((fn) => { if (disposed) fn(); else off = fn; });
    return () => { disposed = true; off?.(); };
  }, [reattach]);
  const ready = useCallback((failure?: string) => {
    if (!payload) return;
    if (failure) { setError(failure); signalPanelWindow({ ...payload.envelope, errorCode: failure }, "failed"); }
    else signalPanelWindow(payload.envelope, "ready");
  }, [payload]);
  if (!payload) return <p role="alert" data-testid="shell-window-error" className="p-5">{t("shell.targetUnavailable")}</p>;
  return <div data-testid="shell-git-window" data-phase={committed ? "ready" : "initializing"} className="h-screen w-screen flex flex-col" style={{ background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}>
    <header className="flex items-center gap-2 p-2 border-b"><strong className="flex-1 truncate">{payload.title}</strong><button data-testid="shell-window-reattach" onClick={() => void reattach()}>{t("shell.reattach")}</button></header>
    {error && <p role="alert" data-testid="shell-window-error">{error}</p>}
    <div className="flex-1 min-h-0">{payload.singleRepository ? <GitPanel repoRoot={payload.activeRepoRoot ?? payload.roots[0].repoRoot} shellScopeId={scopeId} initialShellSnapshot={payload.snapshot} onReady={ready} /> : <WorkspaceGitManager roots={payload.roots} workspaceName={payload.title} activeRepoRoot={payload.activeRepoRoot} shellScopeId={scopeId} initialShellSnapshot={payload.snapshot} onReady={ready} />}</div>
  </div>;
}
