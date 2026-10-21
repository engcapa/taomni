import { useCallback, useEffect, useRef } from "react";
import { type TerminalLocalPathUploadRequest } from "../../components/terminal/TerminalPanel";
import { t as tr } from "../../lib/i18n";
import { encodeBase64, writeTerminal } from "../../lib/ipc";
import { terminalCwdTitlePrefix } from "../../lib/terminalCwd";
import { loadTerminalDefaultProfile, type TerminalProfile } from "../../lib/terminalProfile";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import type { Tab } from "../../types";
import { localShellSupportsCwdProbe } from "./sessionPolicy";
import { useMainLayoutState } from "./useMainLayoutState";


export interface UseMainTerminalIntegrationContext {
  layout: ReturnType<typeof useMainLayoutState>;
}

export function useMainTerminalIntegration(context: UseMainTerminalIntegrationContext) {
  const { layout } = context;

  const toggleAttachedSidebar = useCallback((tabId: string) => {
    layout.setAttachedSidebars((prev) => ({ ...prev, [tabId]: !prev[tabId] }));
  }, []);

  const prevTabIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const currentIds = layout.tabs.filter((t) => t.type === "terminal").map((t) => t.id);
    const prevIds = prevTabIdsRef.current;

    // Find closed tabs
    const closedIds = prevIds.filter((id) => !currentIds.includes(id));
    if (closedIds.length > 0) {
      const store = useSftpStore.getState();
      for (const closedId of closedIds) {
        const sftpSessionId = `attached-${closedId}`;
        const detachedSessionId = `attached-${closedId}__detached`;
        void store.detach(sftpSessionId);
        void store.detach(detachedSessionId);
      }
      layout.setSftpDetachedTabs((prev) => {
        const next = { ...prev };
        for (const closedId of closedIds) {
          delete next[closedId];
        }
        return next;
      });
      layout.setPendingSftpUploadRequests((prev) => {
        const next = { ...prev };
        for (const closedId of closedIds) {
          delete next[`attached-${closedId}`];
          delete next[`attached-${closedId}__detached`];
        }
        return next;
      });
    }

    prevTabIdsRef.current = currentIds;
  }, [layout.tabs]);

  const handleTerminalCwd = useCallback((tabId: string, cwd: string) => {
    layout.terminalCwdsRef.current[tabId] = cwd;
    layout.setTerminalCwds((prev) => (prev[tabId] === cwd ? prev : { ...prev, [tabId]: cwd }));
    layout.setTerminalCwdVersions((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    // Mirror into the app store so the AI chat store can read the bound tab's
    // live cwd when sending a turn to Claude Code (Phase 3.3).
    useAppStore.getState().setTabCwd(tabId, cwd);
    layout.assignTerminalAutoTitle(tabId, cwd);
    // Hand the freshly reported cwd to anyone awaiting it (e.g. a pending tab
    // duplication) before broadcasting to other windows.
    const resolvers = layout.cwdQueryResolversRef.current[tabId];
    if (resolvers && resolvers.length > 0) {
      layout.cwdQueryResolversRef.current[tabId] = [];
      for (const resolve of resolvers) resolve(cwd);
    }
    // Mirror the new cwd to any same-origin window (e.g. a detached SFTP
    // popup) so it can offer the same last-known terminal cwd for explicit
    // sync even though only the main window hosts the terminal. We publish
    // under both the raw tab
    // id AND the `attached-${tabId}` key, because a detached window that
    // was split off from an attached SSH sidebar uses the prefixed id as
    // its SFTP session id and would otherwise never see these updates.
    void import("../../lib/sftpSync").then(({ broadcastCwdHint }) => {
      broadcastCwdHint(tabId, cwd);
      broadcastCwdHint(`attached-${tabId}`, cwd);
    });
  }, [layout.assignTerminalAutoTitle]);

  // Ask a terminal tab for its current working directory and resolve once the
  // shell reports back via OSC 7. Resolves null if the terminal isn't ready or
  // the reply doesn't arrive in time (so callers can fall back gracefully).
  const queryTerminalCwd = useCallback((tabId: string): Promise<string | null> => {
    return new Promise((resolve) => {
      if (!layout.terminalSessionIds.current[tabId]) {
        resolve(null);
        return;
      }
      const list = layout.cwdQueryResolversRef.current[tabId] ?? [];
      list.push(resolve);
      layout.cwdQueryResolversRef.current[tabId] = list;
      layout.setTerminalCwdRequestTokens((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
      window.setTimeout(() => {
        const pending = layout.cwdQueryResolversRef.current[tabId];
        if (pending && pending.includes(resolve)) {
          layout.cwdQueryResolversRef.current[tabId] = pending.filter((r) => r !== resolve);
          resolve(null);
        }
      }, 1200);
    });
  }, []);

  const duplicateTerminalProfileFor = useCallback((source: Tab): TerminalProfile | undefined => {
    if (source.type !== "terminal") return undefined;
    const liveProfile = layout.terminalProfileOverrides[source.id]
      ?? (source.sessionId ? layout.terminalProfilesBySessionId.get(source.sessionId) : undefined)
      ?? source.terminalProfile;
    return liveProfile ?? loadTerminalDefaultProfile();
  }, [layout.terminalProfileOverrides, layout.terminalProfilesBySessionId]);

  // Duplicate a tab. Terminal tabs try to open the copy in the source's current
  // directory. Shell integration makes shells report their cwd via OSC 7 on
  // every prompt, so we read the last-known cwd (terminalCwdsRef) with no
  // injection — nothing to echo, and a half-typed line in the source is never
  // touched. Only when no cwd was ever reported (integration absent, e.g.
  // cmd/zsh/custom local shells) do we fall back to a one-shot probe, and only
  // for local shells: the probe is skipped if a command is typed, and SSH never
  // probes its source (a duplicate with no known cwd just opens in the remote
  // default directory).
  const handleDuplicateTab = useCallback(
    async (tabId: string) => {
      const source = useAppStore.getState().tabs.find((t) => t.id === tabId);
      if (!source) return;
      let initialCwd: string | undefined;
      if (source.type === "terminal" && !source.adoptedTerminal) {
        const tracked = layout.terminalCwdsRef.current[tabId];
        if (tracked) {
          initialCwd = tracked;
        } else if (!source.ssh && !source.commandTerminal && localShellSupportsCwdProbe(source.localShell)) {
          const cwd = await queryTerminalCwd(tabId);
          initialCwd = cwd ?? undefined;
        }
      }
      const terminalProfile = duplicateTerminalProfileFor(source);
      const terminalTitlePrefix = initialCwd ? terminalCwdTitlePrefix(initialCwd) ?? undefined : undefined;
      layout.duplicateTab(tabId, {
        ...(initialCwd ? { terminalInitialCwd: initialCwd } : {}),
        ...(terminalProfile ? { terminalProfile } : {}),
        ...(terminalTitlePrefix ? { terminalTitlePrefix } : {}),
      });
    },
    [layout.duplicateTab, duplicateTerminalProfileFor, queryTerminalCwd],
  );

  const requestTerminalCwd = useCallback((tabId: string): boolean => {
    if (!layout.terminalSessionIds.current[tabId]) {
      layout.setStatusMessage(tr("status.terminalNotReady"));
      return false;
    }
    layout.setTerminalCwdRequestTokens((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    return true;
  }, [layout.setStatusMessage]);

  const handleTerminalLocalPathUpload = useCallback(
    async (tabId: string, request: TerminalLocalPathUploadRequest): Promise<void> => {
      if (request.paths.length === 0) return;
      const remoteDir = request.cwd ?? layout.terminalCwdsRef.current[tabId] ?? null;
      if (!remoteDir) {
        throw new Error(tr("status.terminalCwdUnknown"));
      }

      const sftpSessionId = `attached-${tabId}`;
      const id = ++layout.sftpUploadRequestSeqRef.current;
      layout.setTerminalSplitActive(false);
      layout.setSftpDetachedTabs((prev) => ({ ...prev, [tabId]: false }));
      layout.setAttachedSidebars((prev) => ({ ...prev, [tabId]: true }));
      layout.setPendingSftpUploadRequests((prev) => ({
        ...prev,
        [sftpSessionId]: {
          id,
          paths: request.paths,
          remoteDir,
        },
      }));
    },
    [layout.setTerminalSplitActive, tr],
  );

  const broadcastToSelectedTerminals = useCallback((data: string, sourceTabId?: string) => {
    const {
      multiExecSelectedTabIds: selectedIds,
      terminalSplitActive: splitActive,
      terminalSplitInputLockedTabIds: lockedIds,
    } = useAppStore.getState();
    for (const tabId of selectedIds) {
      if (tabId === sourceTabId) continue; // skip the source terminal — it handles its own input
      if (splitActive && lockedIds.has(tabId)) continue;
      const sessionId = layout.terminalSessionIds.current[tabId];
      if (sessionId) {
        writeTerminal(sessionId, encodeBase64(data)).catch(console.error);
      }
    }
  }, []);

  const handleTerminalOutput = useCallback((tabId: string) => {
    if (tabId === useAppStore.getState().activeTabId) return;
    layout.setTabHasNewOutput(tabId, true);
  }, [layout.setTabHasNewOutput]);
  return {
    handleDuplicateTab,
    toggleAttachedSidebar,
    broadcastToSelectedTerminals,
    handleTerminalCwd,
    handleTerminalOutput,
    handleTerminalLocalPathUpload,
    queryTerminalCwd,
    requestTerminalCwd,
  };
}
