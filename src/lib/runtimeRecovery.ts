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

// The native contract measures UTF-8 bytes. Stop after the budget, even for
// unbounded OSC titles; never encode/copy a full terminal-provided string.
export function boundedUtf8(value: string, budget: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > budget) break;
    bytes += size;
    result += point >= 0xd800 && point <= 0xdfff ? "\ufffd" : character;
  }
  return result;
}

function identity(value: string | null | undefined): string | null {
  // Identities must never be truncated or normalized into a different ID.
  return value && value === boundedUtf8(value, 256) ? value : null;
}

function terminalId(state: Pick<AppState, "terminalRuntimeByTab">, tab: Tab): string | null {
  return state.terminalRuntimeByTab[tab.id]?.backendSessionId ?? tab.adoptedTerminal?.sessionId ?? null;
}

export function describeTabs(state: Pick<AppState, "tabs" | "activeTabId" | "terminalRuntimeByTab">): RecoveryDescription {
  const tabs = state.tabs.slice(0, 128).filter((tab) => identity(tab.id));
  return {
    tabs: tabs.map((tab: Tab) => ({
      id: tab.id,
      kind: tab.type,
      title: boundedUtf8(tab.title, 512),
      savedSessionId: identity(tab.sessionId),
      terminalSessionId: identity(terminalId(state, tab)),
    })),
    activeTabId: tabs.some((t) => t.id === state.activeTabId) ? state.activeTabId : null,
  };
}

function describeDetached(state: AppState, route: NonNullable<ReturnType<typeof detectDetachedRoute>>): RecoveryDescription {
  // DetachedSessionWindow registers its logical tab during the healthy handoff.
  // The route is only a window/handoff identity, never a saved config or PTY ID.
  const candidates = state.tabs.slice(0, 128).filter((tab) => tab.type === route.kind);
  const tab = candidates.find((entry) => entry.id === state.activeTabId)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (tab) return describeTabs({ tabs: [tab], activeTabId: tab.id, terminalRuntimeByTab: state.terminalRuntimeByTab });
  const id = identity(route.id);
  return { tabs: id ? [{ id, kind: route.kind, title: boundedUtf8(`${route.kind} — ${id}`, 512),
    savedSessionId: null, terminalSessionId: null }] : [], activeTabId: id };
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
      && (state.terminalRuntimeByTab === old.terminalRuntimeByTab
        || state.tabs.slice(0, 128).every((tab) => terminalId(state, tab) === terminalId(old, tab)))) return;
    const description = detached ? describeDetached(state, detached) : describeTabs(state);
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
