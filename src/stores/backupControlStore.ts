import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-shell";
import { remoteBackup, type AuthorizationSession, type BackupJob } from "../lib/remoteBackup";
import { useBackupSettingsStore } from "./backupSettingsStore";

export const authTerminal = (s: AuthorizationSession) => ["connected", "failed", "cancelled", "expired", "interrupted"].includes(s.phase);
export const authClean = (s: AuthorizationSession) => s.cleanupComplete ?? authTerminal(s);
export const authBlocking = (s: AuthorizationSession) => !s.dismissedAt && (!authTerminal(s) || !authClean(s));

export function mergeRevision<T extends { id: string; revision: number }>(old: T[], incoming: T[]): T[] {
  const map = new Map(old.map((v) => [v.id, v]));
  for (const value of incoming) if (!map.has(value.id) || map.get(value.id)!.revision < value.revision) map.set(value.id, value);
  return [...map.values()];
}

interface ControlState {
  sessions: AuthorizationSession[];
  jobs: BackupJob[];
  error: string | null;
  refresh: () => Promise<void>;
  connect: (targetId: string, selection?: string, restart?: boolean) => Promise<void>;
  cancelAuthorization: (id: string) => Promise<void>;
  forget: (id: string) => Promise<void>;
}
let requested = "";
const opened = new Set<string>();
function openRequested(values: AuthorizationSession[]) {
  const session = values.find((s) => s.id === requested);
  if (!session?.verificationUrl || session.dismissedAt || session.cancelRequested || opened.has(session.verificationUrl)) return;
  opened.add(session.verificationUrl);
  void open(session.verificationUrl).catch(() => useBackupControlStore.setState({ error: "BACKUP_BROWSER_OPEN_FAILED" }));
}

export const useBackupControlStore = create<ControlState>((set, get) => ({
  sessions: [], jobs: [], error: null,
  refresh: async () => {
    try {
      const [sessions, jobs] = await Promise.all([remoteBackup.authorizations(), remoteBackup.jobs()]);
      set({ sessions: mergeRevision(get().sessions, sessions), jobs: mergeRevision(get().jobs, jobs) });
      openRequested(get().sessions);
    } catch (e) { set({ error: String(e) }); }
  },
  connect: async (targetId, selection, restart) => {
    await useBackupSettingsStore.getState().flush();
    const session = await remoteBackup.authorize(targetId, selection, restart);
    requested = session.id;
    set({ sessions: mergeRevision(get().sessions, [session]), error: null });
    openRequested(get().sessions);
    await useBackupSettingsStore.getState().refresh();
  },
  cancelAuthorization: async (id) => { await remoteBackup.cancelAuthorization(id); await get().refresh(); },
  forget: async (id) => {
    const value = await remoteBackup.forgetAuthorization(id);
    set({ sessions: mergeRevision(get().sessions, [value]) });
  },
}));

// One observation owner for the whole Backup section. Backend tasks outlive it.
export function observeBackupControl(): () => void {
  let disposed = false;
  const stops: UnlistenFn[] = [];
  const refresh = () => { if (!disposed) void useBackupControlStore.getState().refresh(); };
  void Promise.allSettled([
    listen<AuthorizationSession>("backup-authorization", ({ payload }) => {
      if (disposed) return;
      useBackupControlStore.setState((s) => ({ sessions: mergeRevision(s.sessions, [payload]) }));
      openRequested(useBackupControlStore.getState().sessions);
      if (authTerminal(payload)) void useBackupSettingsStore.getState().refresh();
    }),
    listen<BackupJob>("backup-job-progress", ({ payload }) => {
      if (!disposed) {
        useBackupControlStore.setState((s) => ({ jobs: mergeRevision(s.jobs, [payload]) }));
        if (["completed", "failed", "cancelled"].includes(payload.phase)) void useBackupSettingsStore.getState().refresh();
      }
    }),
    listen("backup-connection-changed", () => { if (!disposed) void useBackupSettingsStore.getState().refresh(); }),
  ]).then((results) => {
    for (const result of results) {
      if (result.status === "fulfilled") { if (disposed) result.value(); else stops.push(result.value); }
      else if (!disposed) useBackupControlStore.setState({ error: String(result.reason) });
    }
    refresh();
  });
  refresh();
  const timer = window.setInterval(refresh, 2000);
  return () => { disposed = true; window.clearInterval(timer); stops.forEach((stop) => stop()); };
}
