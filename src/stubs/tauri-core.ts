import type { SessionConfig, SessionGroup, LocalShellOption } from "../lib/ipc";
import {
  isSshSession,
  sshClose,
  sshConnect,
  sshResize,
  sshSignal,
  sshTest,
  sshWrite,
} from "./sshClient";

const SESSION_STORAGE_KEY = "newmob.sessions.v1";
const GROUP_STORAGE_KEY = "newmob.groups.v1";

function loadSessions(): SessionConfig[] {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(sessions: SessionConfig[]): void {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
}

function loadGroups(): SessionGroup[] {
  try {
    return JSON.parse(localStorage.getItem(GROUP_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveGroups(groups: SessionGroup[]): void {
  localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(groups));
}

type InvokeArgs = Record<string, unknown>;

export async function invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
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
      if (idx >= 0) {
        sessions[idx] = config;
      } else {
        sessions.push(config);
      }
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
      if (idx >= 0) {
        groups[idx] = group;
      } else {
        groups.push(group);
      }
      saveGroups(groups);
      return undefined as T;
    }
    case "delete_session_group": {
      const groups = loadGroups();
      saveGroups(groups.filter((g) => g.id !== (args?.id as string)));
      return undefined as T;
    }
    case "list_local_shells": {
      const shells: LocalShellOption[] = [
        {
          id: "browser-shell",
          name: "Browser preview (SSH only)",
          path: "/dev/null",
          args: [],
          isDefault: true,
          canElevate: false,
        },
      ];
      return shells as T;
    }
    case "list_system_fonts": {
      return [] as T;
    }
    case "create_local_terminal": {
      throw new Error(
        "Local terminal is not available in browser preview. Use the Quick connect bar or 'New session' to open an SSH connection (e.g. demo@test.rebex.net).",
      );
    }
    case "create_ssh_terminal": {
      const cols = (args?.cols as number) ?? 80;
      const rows = (args?.rows as number) ?? 24;
      return (await sshConnect({
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: args?.authMethod as string,
        authData: (args?.authData as string | null) ?? null,
        cols,
        rows,
      })) as T;
    }
    case "test_ssh_connection": {
      return (await sshTest({
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: args?.authMethod as string,
        authData: (args?.authData as string | null) ?? null,
      })) as T;
    }
    case "write_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) {
        sshWrite(sid, args?.data as string);
      }
      return undefined as T;
    }
    case "resize_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) {
        sshResize(sid, args?.cols as number, args?.rows as number);
      }
      return undefined as T;
    }
    case "send_terminal_signal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) {
        sshSignal(sid, args?.signal as string);
      }
      return undefined as T;
    }
    case "close_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) {
        sshClose(sid);
      }
      return undefined as T;
    }
    case "open_local_shell_as_administrator": {
      throw new Error(
        "Administrator local terminals are not available in browser preview.",
      );
    }
    case "exit_app": {
      window.close();
      return undefined as T;
    }
    default:
      console.warn(`[tauri-stub] Unknown invoke command: ${cmd}`, args);
      return undefined as T;
  }
}
