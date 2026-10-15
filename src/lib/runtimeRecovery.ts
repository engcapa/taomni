import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type AppState } from "../stores/appStore";
import type { Tab } from "../types";
import { detectDetachedRoute } from "./detachedSession";

export interface RecoveryTab {
  id: string;
  kind: string;
  title: string;
  savedSessionId: string | null;
  terminalSessionId: string | null;
}
export interface RecoveryDescription {
  tabs: RecoveryTab[];
  activeTabId: string | null;
}
export interface RecoveryBootstrap {
  version: number;
  instanceId: string;
  generation: number;
  revision: number;
  recovering: boolean;
  description: RecoveryDescription | null;
  limitation: string;
}

export function describeTabs(state: Pick<AppState, "tabs" | "activeTabId" | "terminalRuntimeByTab">): RecoveryDescription {
  return {
    tabs: state.tabs.slice(0, 128).map((tab: Tab) => ({
      id: tab.id,
      kind: tab.type,
      title: tab.title.slice(0, 512),
      savedSessionId: tab.sessionId ?? null,
      terminalSessionId: state.terminalRuntimeByTab[tab.id]?.backendSessionId
        ?? tab.adoptedTerminal?.sessionId ?? null,
    })),
    activeTabId: state.tabs.slice(0, 128).some((t) => t.id === state.activeTabId) ? state.activeTabId : null,
  };
}

export function validateBootstrap(value: RecoveryBootstrap): RecoveryBootstrap {
  if (!value || value.version !== 1 || typeof value.instanceId !== "string"
    || !value.instanceId || !Number.isSafeInteger(value.generation) || value.generation < 0
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.recovering !== "boolean"
    || (value.description !== null && (!Array.isArray(value.description?.tabs)
      || value.description.tabs.length > 128
      || value.description.tabs.some((tab) => !tab || typeof tab.id !== "string"
        || typeof tab.kind !== "string" || typeof tab.title !== "string"
        || !(tab.terminalSessionId === null || typeof tab.terminalSessionId === "string")
        || !(tab.savedSessionId === null || typeof tab.savedSessionId === "string"))))) {
    throw new Error("Invalid recovery handshake; business pages were not started.");
  }
  return value;
}

export async function getRecoveryBootstrap(): Promise<RecoveryBootstrap> {
  // Fail explicitly rather than treating a failed IPC handshake as a cold start:
  // that could create duplicate shells or process the Outbox.
  return validateBootstrap(await invoke<RecoveryBootstrap>("recovery_get"));
}

/** Only bounded metadata changes are submitted; no timer, output or full-store serialization. */
export function trackRecoveryDescription(bootstrap: RecoveryBootstrap): () => void {
  if (bootstrap.recovering) return () => {};
  let revision = bootstrap.revision;
  let previous: RecoveryDescription | null = null;
  let pending: RecoveryDescription | null = null;
  let scheduled = false;
  let stopped = false;
  const detached = detectDetachedRoute();
  const submit = () => {
    if (stopped || !pending) { scheduled = false; return; }
    const description = pending;
    pending = null;
    void invoke("recovery_update", { instanceId: bootstrap.instanceId, revision: ++revision, description })
      .catch((error: unknown) => console.warn("[recovery] metadata unavailable", error))
      .finally(() => {
        scheduled = false;
        if (pending && !stopped) { scheduled = true; queueMicrotask(submit); }
      });
  };
  const update = (state: AppState, old?: AppState) => {
    if (old && state.tabs === old.tabs && state.activeTabId === old.activeTabId
      && state.terminalRuntimeByTab === old.terminalRuntimeByTab) return;
    const description = detached ? {
      tabs: [{
        id: detached.id, kind: detached.kind, title: `${detached.kind} — ${detached.id}`,
        savedSessionId: detached.id, terminalSessionId: null,
      }],
      activeTabId: detached.id,
    } : describeTabs(state);
    if (previous && sameDescription(previous, description)) return;
    previous = description;
    pending = description;
    if (!scheduled) { scheduled = true; queueMicrotask(submit); }
  };
  update(useAppStore.getState());
  const unsubscribe = useAppStore.subscribe(update);
  return () => { stopped = true; pending = null; unsubscribe(); };
}

function sameDescription(a: RecoveryDescription, b: RecoveryDescription): boolean {
  return a.activeTabId === b.activeTabId && a.tabs.length === b.tabs.length
    && a.tabs.every((tab, i) => {
      const other = b.tabs[i];
      return tab.id === other.id && tab.kind === other.kind && tab.title === other.title
        && tab.savedSessionId === other.savedSessionId && tab.terminalSessionId === other.terminalSessionId;
    });
}

let recoveryStartup = false;
export function markRecoveryStartup(value: boolean): void { recoveryStartup = value; }
export function isRecoveryStartup(): boolean { return recoveryStartup; }
