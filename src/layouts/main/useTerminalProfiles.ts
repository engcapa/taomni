import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { Tab } from "../../types";
import { type SessionConfig } from "../../lib/ipc";
import { getSessionTerminalProfile, type TerminalProfile } from "../../lib/terminalProfile";


export interface UseTerminalProfilesContext {
  sessions: SessionConfig[];
  tabs: Tab[];
}

export function useTerminalProfiles(context: UseTerminalProfilesContext) {
  const { sessions, tabs } = context;
  const terminalProfilesBySessionId = useMemo(() => {
    const profiles = new Map<string, TerminalProfile | undefined>();
    for (const session of sessions) {
      profiles.set(session.id, getSessionTerminalProfile(session.options_json));
    }
    return profiles;
  }, [sessions]);
  const terminalProfileSignaturesBySessionId = useMemo(() => {
    const signatures = new Map<string, string | null>();
    for (const session of sessions) {
      const profile = getSessionTerminalProfile(session.options_json);
      signatures.set(session.id, profile ? JSON.stringify(profile) : null);
    }
    return signatures;
  }, [sessions]);
  const [terminalProfileOverrides, setTerminalProfileOverrides] = useState<Record<string, TerminalProfile>>({});
  const previousTerminalProfileSignaturesRef = useRef<Map<string, string | null> | null>(null);

  useEffect(() => {
    setTerminalProfileOverrides((current) => {
      const liveTabIds = new Set(tabs.map((tab) => tab.id));
      let changed = false;
      const next = { ...current };
      for (const tabId of Object.keys(next)) {
        if (!liveTabIds.has(tabId)) {
          delete next[tabId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tabs]);

  useEffect(() => {
    const previous = previousTerminalProfileSignaturesRef.current;
    previousTerminalProfileSignaturesRef.current = terminalProfileSignaturesBySessionId;
    if (!previous) return;

    setTerminalProfileOverrides((current) => {
      let changed = false;
      const next = { ...current };
      for (const tab of tabs) {
        if (tab.type !== "terminal" || !tab.sessionId || !(tab.id in next)) continue;
        const before = previous.get(tab.sessionId);
        const after = terminalProfileSignaturesBySessionId.get(tab.sessionId) ?? null;
        if (before !== undefined && before !== after) {
          delete next[tab.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [tabs, terminalProfileSignaturesBySessionId]);

  const handleTerminalProfileChange = useCallback((tabId: string, profile: TerminalProfile) => {
    setTerminalProfileOverrides((current) => {
      const currentProfile = current[tabId];
      if (currentProfile && JSON.stringify(currentProfile) === JSON.stringify(profile)) return current;
      return { ...current, [tabId]: profile };
    });
  }, []);
  return { terminalProfileOverrides, terminalProfilesBySessionId, handleTerminalProfileChange };
}
