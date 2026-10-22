import type { LocalShellOption, LocalDirectoryShortcut } from "../../lib/ipc";
import { isSshSession, sshClose, sshConnect, sshResize, sshSignal, sshTest, sshWrite, type SshConnectArgs } from "../sshClient";
import { vfsHome, VFS_ROOT } from "../localVfs";
import { emit } from "../tauri-event";

export const DIRECTORY_USAGE_STORAGE_KEY = "taomni.welcome.directoryUsage.v1";

export interface StubDirectoryUsageEntry {
  directoryId: string;
  lastUsedAtMs: number | null;
  timeSource: "local-start" | "local-cwd" | null;
  legacyRank: number | null;
  availability: "unknown" | "available" | "missing" | "permission-denied" | "unavailable";
}

export interface StubDirectoryUsage {
  revision: number;
  entries: Record<string, StubDirectoryUsageEntry>;
  fixtureDirectories?: Array<Partial<LocalDirectoryShortcut>>;
}

export function loadDirectoryUsage(): StubDirectoryUsage {
  try {
    const raw = window.localStorage.getItem(DIRECTORY_USAGE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StubDirectoryUsage;
      if (parsed && typeof parsed === "object" && parsed.entries) return parsed;
    }
  } catch {
    // fall through to a fresh store
  }
  return { revision: 0, entries: {} };
}

export function saveDirectoryUsage(usage: StubDirectoryUsage): void {
  window.localStorage.setItem(DIRECTORY_USAGE_STORAGE_KEY, JSON.stringify(usage));
}

export async function invokeTerminal<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "attach_terminal_output": {
      const fixture = localStorage.getItem("qa.recovery.bootstrap");
      if (!fixture || !JSON.parse(fixture).recovering) {
        throw new Error("Browser mode cannot attach native terminals");
      }
      if (args?.sessionId === "qa-ended") throw new Error("Terminal not found");
      args?.onOutput?.onmessage?.(new TextEncoder().encode("QA-ORIGINAL-OUTPUT\n").buffer);
      return undefined as T;
    }

    case "detach_terminal_output":
      return undefined as T;

    case "detect_x_server": {
      // Web preview has no system X server; report unavailable so the UI shows
      // honest "no display" status rather than a misleading green pill.
      return {
        available: false,
        display: "",
        endpoint: "",
        has_cookie: false,
        provider: "unknown",
        hint: "no-display",
      } as unknown as T;
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

    case "list_wsl_distros": {
      // Browser preview has no WSL; return a type-correct empty list instead
      // of undefined so SessionEditor never stores undefined distros.
      return ([] as unknown) as T;
    }

    case "list_common_local_directories": {
      const home = await vfsHome();
      const usage = loadDirectoryUsage();
      const revision = usage.revision;
      const base: Array<Pick<LocalDirectoryShortcut, "label" | "path" | "kind" | "defaultId">> = [
        { label: "Home", path: home, kind: "system", defaultId: "home" },
        { label: "Workspace", path: VFS_ROOT, kind: "personal", defaultId: "workspace" },
      ];
      // Fixture-provided extra rows (qa-ui-auto welcome_recents fixture) so
      // browser cases can assert real backend-style ordering without local
      // PTY support.
      const fixtureRows = (usage.fixtureDirectories ?? []) as Array<Partial<LocalDirectoryShortcut>>;
      const dirs: LocalDirectoryShortcut[] = [...base, ...fixtureRows]
        .filter((d) => typeof d.path === "string" && d.path)
        .map((d) => {
          const used = usage.entries[d.path as string] ?? null;
          const shortcut: LocalDirectoryShortcut = {
            label: d.label ?? String(d.path),
            path: d.path as string,
            kind: d.kind === "system" ? "system" : "personal",
            directoryId: used?.directoryId ?? `stub:${d.defaultId ?? d.path}`,
            lastUsedAtMs: used?.lastUsedAtMs ?? null,
            timeSource: used?.timeSource ?? null,
            legacyRank: used?.legacyRank ?? null,
            defaultId: d.defaultId ?? null,
            availability: used?.availability ?? "available",
          };
          return shortcut;
        });
      // Mirror the Rust sort contract (design §4.1.3): confirmed times first
      // (newest first, ties by path), then legacy observations, then the rest.
      const deduped = new Map<string, LocalDirectoryShortcut>();
      for (const dir of dirs) {
        const existing = deduped.get(dir.path);
        if (!existing || (existing.lastUsedAtMs ?? -1) < (dir.lastUsedAtMs ?? -1)) {
          deduped.set(dir.path, dir);
        }
      }
      const sorted = [...deduped.values()].sort((a, b) => {
        if (a.lastUsedAtMs != null && b.lastUsedAtMs != null) {
          return b.lastUsedAtMs - a.lastUsedAtMs || a.path.localeCompare(b.path);
        }
        if (a.lastUsedAtMs != null) return -1;
        if (b.lastUsedAtMs != null) return 1;
        if (a.legacyRank != null && b.legacyRank != null) {
          return a.legacyRank - b.legacyRank || a.path.localeCompare(b.path);
        }
        if (a.legacyRank != null) return -1;
        if (b.legacyRank != null) return 1;
        return a.path.localeCompare(b.path);
      });
      return { revision, directories: sorted } as T;
    }

    case "record_local_directory_use": {
      const backendSessionId = args?.backendSessionId as string | undefined;
      const path = args?.path as string | undefined;
      if (!backendSessionId || !path) {
        throw new Error("record_local_directory_use requires backendSessionId and path");
      }
      const usage = loadDirectoryUsage();
      const existing = usage.entries[path] ?? null;
      const now = Date.now();
      const nextMs = existing?.lastUsedAtMs != null ? Math.max(existing.lastUsedAtMs, now) : now;
      const changed = existing?.lastUsedAtMs !== nextMs || existing?.directoryId == null;
      usage.entries[path] = {
        directoryId: existing?.directoryId ?? `stub:${path}`,
        lastUsedAtMs: nextMs,
        timeSource: "local-cwd",
        legacyRank: existing?.legacyRank ?? null,
        availability: existing?.availability ?? "available",
      };
      usage.revision = changed ? usage.revision + 1 : usage.revision;
      saveDirectoryUsage(usage);
      void emit("welcome-directories-changed", { revision: usage.revision });
      return { changed } as T;
    }

    case "history_snapshot": {
      return null as T;
    }

    case "history_list": {
      return [] as T;
    }

    case "history_read": {
      return "" as T;
    }

    case "history_prune": {
      return 0 as T;
    }

    case "create_local_terminal": {
      throw new Error(
        "Local terminal is not available in browser preview. Use the Quick connect bar or 'New session' to open an SSH connection (e.g. demo@test.rebex.net).",
      );
    }

    case "create_ssh_terminal": {
      const cols = (args?.cols as number) ?? 80;
      const rows = (args?.rows as number) ?? 24;
      // The browser preview can't honour proxy / port-forwarding rows; we
      // simply ignore `networkSettingsJson` here and let the WS proxy
      // handle the SSH connection directly.
      return (await sshConnect({
        sessionId: args?.sessionId as string,
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: args?.authMethod as string,
        authData: (args?.authData as string | null) ?? null,
        cols,
        rows,
        onOutput: args?.onOutput as SshConnectArgs["onOutput"],
      })) as T;
    }

    case "submit_ssh_auth_response": {
      // Keyboard-interactive (MFA) auth is driven by the real Rust backend.
      // The browser preview's WS SSH proxy doesn't surface interactive
      // prompts, so this is a no-op here.
      return undefined as T;
    }

    case "test_ssh_connection": {
      // The browser preview can't honour proxy / port-forwarding rows
      // either; we ignore `networkSettingsJson` here for symmetry with
      // `create_ssh_terminal` so testing a session in web preview
      // exercises the same path the spawned terminal will take.
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
      if (isSshSession(sid)) sshWrite(sid, args?.data as string);
      return undefined as T;
    }

    case "resize_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshResize(sid, args?.cols as number, args?.rows as number);
      return undefined as T;
    }

    case "send_terminal_signal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshSignal(sid, args?.signal as string);
      return undefined as T;
    }

    case "close_terminal": {
      const sid = args?.sessionId as string;
      if (isSshSession(sid)) sshClose(sid);
      return undefined as T;
    }
    default: throw new Error(`Unhandled terminal stub command: ${cmd}`);
  }
}
