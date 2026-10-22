import { vi } from "vitest";
import type { SessionConfig } from "../../../lib/ipc";
import type { RecentWorkspace } from "../../../types";

const ipcMocks = vi.hoisted(() => ({
  listCommonLocalDirectories: vi.fn(),
  listLocalShells: vi.fn(),
  listSessionGroups: vi.fn(),
  listSessions: vi.fn(),
  listSystemFonts: vi.fn(),
  listWslDistros: vi.fn(),
  openLocalShellAsAdministrator: vi.fn(),
  saveSession: vi.fn(),
  listenWelcomeDirectoriesChanged: vi.fn(),
  directoryEventListeners: [] as Array<(revision: number) => void>,
}));

vi.mock("../../../lib/ipc", () => ({
  listCommonLocalDirectories: ipcMocks.listCommonLocalDirectories,
  listLocalShells: ipcMocks.listLocalShells,
  listSessionGroups: ipcMocks.listSessionGroups,
  listSessions: ipcMocks.listSessions,
  listSystemFonts: ipcMocks.listSystemFonts,
  listWslDistros: ipcMocks.listWslDistros,
  openLocalShellAsAdministrator: ipcMocks.openLocalShellAsAdministrator,
  saveSession: ipcMocks.saveSession,
  listenWelcomeDirectoriesChanged: ipcMocks.listenWelcomeDirectoriesChanged,
}));

export function emitWelcomeDirectoriesChanged(revision: number): void {
  for (const listener of ipcMocks.directoryEventListeners) listener(revision);
}

vi.mock("../../../lib/runtime", () => ({
  getAppPlatform: () => "linux",
}));

vi.mock("../../../lib/sftp", () => ({
  sftpLocalHome: vi.fn(async () => "/home/test"),
}));

vi.mock("../../../lib/clipboard", () => ({
  writeText: vi.fn(async () => undefined),
}));

export function session(
  id: string,
  name: string,
  sessionType: string,
  host: string,
  port: number,
  lastConnectedAt: number,
): SessionConfig {
  return {
    id,
    name,
    session_type: sessionType,
    group_path: null,
    host,
    port,
    username: "root",
    auth_method: "None",
    options_json: "{}",
    created_at: 0,
    updated_at: 0,
    last_connected_at: lastConnectedAt,
    sort_order: 0,
  };
}

export function workspace(
  id: string,
  name: string,
  path: string,
  lastOpenedAt: number,
  kind: "git" | "folder",
): RecentWorkspace {
  return {
    id,
    name,
    roots: [{ id: `root-${id}`, name, path, kind }],
    looseFiles: [],
    lastOpenedAt,
    lastActiveFile: null,
    isGitRepo: kind === "git",
  };
}

export const restoreRecord = (entries: unknown[] = [], overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  revision: 2,
  runSequence: 1,
  batchId: "batch-1",
  committedAtMs: 1000,
  entries,
  activeIdentity: null,
  ...overrides,
});

export const savedRestoreEntry = (id: string) => ({
  kind: "saved-session",
  identity: `saved:${id}`,
  savedSessionId: id,
  savedSessionType: "SSH",
  displayName: `session-${id}`,
});

export { ipcMocks };
