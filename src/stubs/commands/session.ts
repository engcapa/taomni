import type { SessionConfig, SessionGroup, IpcRunSnapshotRecord, IpcSnapshotEntry } from "../../lib/ipc";

export const SESSION_STORAGE_KEY = "taomni.sessions.v1";

export const GROUP_STORAGE_KEY = "taomni.groups.v1";

export const SESSION_RESUME_STORAGE_KEY = "taomni.welcome.sessionResume.v1";

export const SESSION_RESUME_REVISION_KEY = "taomni.welcome.sessionResumeRevision.v1";

export const SESSION_RESUME_SEQUENCE_KEY = "taomni.welcome.sessionResumeSequence.v1";

export const SESSION_RESUME_CLEARED_KEY = "taomni.welcome.sessionResumeCleared.v1";

export function existingRevision(): number | null {
  const raw = window.localStorage.getItem(SESSION_RESUME_REVISION_KEY);
  return raw ? Number.parseInt(raw, 10) : null;
}

export function existingRunSequence(): number | null {
  const raw = window.localStorage.getItem(SESSION_RESUME_SEQUENCE_KEY);
  return raw ? Number.parseInt(raw, 10) : null;
}

export function loadSessions(): SessionConfig[] {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveSessions(sessions: SessionConfig[]): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

export function loadGroups(): SessionGroup[] {
  try {
    return JSON.parse(localStorage.getItem(GROUP_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveGroups(groups: SessionGroup[]): void {
  localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups));
}

export async function invokeSession<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "list_sessions": {
      return loadSessions() as T;
    }

    case "get_session": {
      const sessions = loadSessions();
      const session = sessions.find((s) => s.id === (args?.id as string));
      if (!session) throw new Error(`Session not found: ${args?.id}`);
      return session as T;
    }

    case "save_session": {
      const sessions = loadSessions();
      const config = args?.config as SessionConfig;
      const idx = sessions.findIndex((s) => s.id === config.id);
      if (idx >= 0) sessions[idx] = config;
      else sessions.push(config);
      saveSessions(sessions);
      return undefined as T;
    }

    case "delete_session": {
      const sessions = loadSessions();
      saveSessions(sessions.filter((s) => s.id !== (args?.id as string)));
      return undefined as T;
    }

    case "mark_session_connected": {
      const sessions = loadSessions();
      const now = Math.floor(Date.now() / 1000);
      const idx = sessions.findIndex((s) => s.id === (args?.id as string));
      if (idx >= 0) {
        sessions[idx] = { ...sessions[idx], last_connected_at: now };
        saveSessions(sessions);
        return now as T;
      }
      return 0 as T;
    }

    case "list_session_groups": {
      return loadGroups() as T;
    }

    case "save_session_group": {
      const groups = loadGroups();
      const group = args?.group as SessionGroup;
      const idx = groups.findIndex((g) => g.id === group.id);
      if (idx >= 0) groups[idx] = group;
      else groups.push(group);
      saveGroups(groups);
      return undefined as T;
    }

    case "delete_session_group": {
      const groups = loadGroups();
      saveGroups(groups.filter((g) => g.id !== (args?.id as string)));
      return undefined as T;
    }

    case "get_welcome_run_snapshot": {
      const cleared = window.localStorage.getItem(SESSION_RESUME_CLEARED_KEY) === "true";
      const raw = window.localStorage.getItem(SESSION_RESUME_STORAGE_KEY);
      if (raw) {
        const record = JSON.parse(raw) as IpcRunSnapshotRecord & { __schemaVersion?: number };
        const schemaVersion = record.__schemaVersion ?? 1;
        if (schemaVersion > 1) {
          return {
            record: null,
            legacyCandidate: null,
            issue: {
              code: "unsupported",
              message: `snapshot schema version ${schemaVersion} is not supported`,
            },
          } as T;
        }
        return { record, legacyCandidate: null, issue: null } as T;
      }
      if (cleared) {
        return { record: null, legacyCandidate: null, issue: null } as T;
      }
      // Legacy candidate: most recently opened recoverable saved session.
      const sessions = loadSessions() as SessionConfig[];
      const candidates = [...sessions]
        .filter((s) => (s.last_connected_at ?? 0) > 0)
        .sort((a, b) => (b.last_connected_at ?? 0) - (a.last_connected_at ?? 0) || a.id.localeCompare(b.id));
      const eligible = candidates.find((s) =>
        [
          "LocalShell", "SSH", "SFTP", "RDP", "VNC", "MySQL", "PostgreSQL",
          "PanWeiDB", "Oracle", "SQLServer", "StarRocks", "ClickHouse", "Presto",
          "Redis", "HBaseShell", "Proxy", "S3", "AzureBlob", "File", "Mail",
          "FTP", "Telnet", "Rlogin", "Mosh", "Serial",
        ].includes(s.session_type),
      );
      return {
        record: null,
        legacyCandidate: eligible
          ? {
              kind: "saved-session",
              identity: `saved:${eligible.id}`,
              savedSessionId: eligible.id,
              savedSessionType: eligible.session_type,
              displayName: eligible.name || eligible.host || eligible.session_type,
            }
          : null,
        issue: null,
      } as T;
    }

    case "commit_welcome_run_snapshot": {
      const entries = (args?.entries as IpcSnapshotEntry[] | undefined) ?? [];
      if (entries.length === 0) {
        throw new Error("snapshot entries must not be empty");
      }
      const expectedRevision = args?.expectedRevision as number | null;
      const raw = window.localStorage.getItem(SESSION_RESUME_STORAGE_KEY);
      if (raw) {
        const existing = JSON.parse(raw) as IpcRunSnapshotRecord & { __schemaVersion?: number };
        const schemaVersion = existing.__schemaVersion ?? 1;
        if (schemaVersion > 1) {
          throw new Error(
            `snapshot schema version ${schemaVersion} is not supported; refusing to overwrite`,
          );
        }
        if (expectedRevision != null && expectedRevision !== existing.revision) {
          return { record: existing, applied: false } as T;
        }
      }
      const now = Date.now();
      const record: IpcRunSnapshotRecord = {
        schemaVersion: 1,
        revision: (existingRevision() ?? 0) + 1,
        runSequence: (existingRunSequence() ?? 0) + 1,
        batchId: (args?.batchId as string) || `stub-${now}`,
        committedAtMs: now,
        entries,
        activeIdentity: (args?.activeIdentity as string | null) ?? null,
      };
      window.localStorage.setItem(
        SESSION_RESUME_STORAGE_KEY,
        JSON.stringify({ ...record, __schemaVersion: 1 }),
      );
      window.localStorage.setItem(SESSION_RESUME_REVISION_KEY, String(record.revision));
      window.localStorage.setItem(SESSION_RESUME_SEQUENCE_KEY, String(record.runSequence));
      if (args?.restored) {
        window.localStorage.removeItem(SESSION_RESUME_CLEARED_KEY);
      }
      return { record, applied: true } as T;
    }

    case "clear_welcome_run_snapshot": {
      const raw = window.localStorage.getItem(SESSION_RESUME_STORAGE_KEY);
      const currentRevision = raw ? ((JSON.parse(raw) as IpcRunSnapshotRecord).revision ?? 0) : 0;
      const expectedRevision = args?.expectedRevision as number | null;
      if (expectedRevision != null && expectedRevision !== currentRevision) {
        throw new Error(
          `snapshot revision mismatch: expected ${expectedRevision}, current ${currentRevision}`,
        );
      }
      window.localStorage.removeItem(SESSION_RESUME_STORAGE_KEY);
      window.localStorage.setItem(SESSION_RESUME_CLEARED_KEY, "true");
      window.localStorage.setItem(SESSION_RESUME_REVISION_KEY, String(currentRevision + 1));
      return undefined as T;
    }
    default: throw new Error(`Unhandled session stub command: ${cmd}`);
  }
}
