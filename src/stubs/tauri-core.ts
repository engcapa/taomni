import type { SessionConfig, SessionGroup, LocalShellOption } from "../lib/ipc";
import {
  isSshSession,
  sshClose,
  sshConnect,
  sshResize,
  sshSignal,
  sshTest,
  sshWrite,
  type SshConnectArgs,
} from "./sshClient";
import {
  isSftpSession,
  sftpAttach,
  sftpDetach,
  sftpListRemote,
  sftpStatRemote,
  sftpMkdirRemote,
  sftpRemoveRemote,
  sftpRenameRemote,
  sftpChmodRemote,
  sftpRealpathRemote,
  sftpReadTextRemote,
  sftpWriteTextRemote,
  sftpUploadBytesRemote,
  sftpDownloadBytesRemote,
  sftpCancel,
} from "./sftpClient";
import {
  vfsHome,
  vfsList,
  vfsStat,
  vfsMkdir,
  vfsRemove,
  vfsRename,
  vfsReadText,
  vfsWriteText,
  vfsReadBytes,
  vfsWriteBytes,
  vfsExportToBrowser,
  VFS_ROOT,
} from "./localVfs";
import { emit } from "./tauri-event";
import { promptAppDialog } from "../lib/appDialogs";

const SESSION_STORAGE_KEY = "taomni.sessions.v1";
const GROUP_STORAGE_KEY = "taomni.groups.v1";
const TUNNEL_STORAGE_KEY = "taomni.tunnels.v1";
const CHAT_THREADS_STORAGE_KEY = "taomni.stub.chatThreads.v1";
const CHAT_MESSAGES_STORAGE_KEY = "taomni.stub.chatMessages.v1";

interface StubTunnelStatus {
  id: string;
  status: "stopped" | "starting" | "running" | "error";
  error?: string;
  activeConnections?: number;
}
const tunnelStatuses: Record<string, StubTunnelStatus> = {};

interface StubTunnelConfig {
  id: string;
  name: string;
  kind: "Local" | "Remote" | "Dynamic";
  listenHost: string;
  listenPort: number;
  destHost: string;
  destPort: number;
  sshSessionId?: string | null;
  ssh: {
    host: string;
    port: number;
    username: string;
    authMethod: "Password" | "PrivateKey" | "Agent";
    authData: string | null;
    saveAuth?: boolean;
  };
  description?: string;
  autostart?: boolean;
  sortOrder?: number;
}

interface StubChatThread {
  id: string;
  title: string;
  provider_id: string;
  created_at: number;
  updated_at: number;
  linked_session_id: string | null;
  source: string;
  output_format?: string | null;
  cc_model?: string | null;
}

interface StubChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
  redacted: boolean;
  attachments?: StubChatAttachment[];
}

interface StubChatAttachment {
  id: string;
  kind: "image" | "file";
  path: string;
  name: string;
  size: number;
  mime?: string | null;
}

function loadChatThreads(): StubChatThread[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_THREADS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatThreads(threads: StubChatThread[]): void {
  localStorage.setItem(CHAT_THREADS_STORAGE_KEY, JSON.stringify(threads));
}

function loadChatMessages(): Record<string, StubChatMessage[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_MESSAGES_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveChatMessages(messages: Record<string, StubChatMessage[]>): void {
  localStorage.setItem(CHAT_MESSAGES_STORAGE_KEY, JSON.stringify(messages));
}

function loadTunnels(): StubTunnelConfig[] {
  try {
    return JSON.parse(localStorage.getItem(TUNNEL_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveTunnels(list: StubTunnelConfig[]): void {
  // Strip secrets unless saveAuth is true (mirrors how the desktop vault behaves).
  const sanitized = list.map((t) => ({
    ...t,
    ssh: {
      ...t.ssh,
      authData: t.ssh.saveAuth ? t.ssh.authData : (t.ssh.authMethod === "PrivateKey" ? t.ssh.authData : null),
    },
  }));
  localStorage.setItem(TUNNEL_STORAGE_KEY, JSON.stringify(sanitized));
}

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
interface InvokeOptions {
  headers?: Record<string, string>;
}

export class Channel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;
}

// Base class mirrored from `@tauri-apps/api/core`. Plugins like
// `@tauri-apps/plugin-updater` (Update extends Resource) import it, so the
// browser build needs the symbol to exist. It's never exercised here — update
// flows are guarded by isTauriRuntime() and no-op outside the desktop app.
export class Resource {
  readonly rid: number;
  constructor(rid: number) {
    this.rid = rid;
  }
  async close(): Promise<void> {
    /* no-op in browser preview */
  }
}

/** No-op plugin-listener shim so plugins that import `addPluginListener`
 *  (e.g. @tauri-apps/plugin-notification) load in browser preview. */
export class PluginListener {
  constructor(
    public plugin: string,
    public event: string,
    public channelId: number,
  ) {}
  async unregister(): Promise<void> {
    /* no-op in browser preview */
  }
}

export async function addPluginListener(
  plugin: string,
  event: string,
  _cb: (payload: unknown) => void,
): Promise<PluginListener> {
  return new PluginListener(plugin, event, 0);
}

const writeStreams = new Map<string, { path: string; chunks: Uint8Array[] }>();
const readStreams = new Map<string, { bytes: Uint8Array; offset: number }>();

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? path : path.slice(idx + 1);
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "txt":
    case "log":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function bytesB64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToB64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + CHUNK, bytes.length))),
    );
  }
  return btoa(binary);
}

function rawBytesFromInvokeArgs(args?: unknown): Uint8Array {
  if (args instanceof Uint8Array) return args;
  if (args instanceof ArrayBuffer) return new Uint8Array(args);
  if (ArrayBuffer.isView(args)) {
    return new Uint8Array(args.buffer, args.byteOffset, args.byteLength);
  }
  throw new Error("Expected raw bytes payload");
}

function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/* --------------------------- LanChat preview mocks --------------------------- */
const LANCHAT_MOCK_PEERS = [
  { id: "zhao", name: "赵敏 · 设计部", avatarHash: null, signature: "设计即沟通", status: "online", lastSeen: Date.now(), addr: "192.168.1.24", port: 47100 },
  { id: "qian", name: "钱进 · 后端", avatarHash: null, signature: "勿扰，发版中", status: "busy", lastSeen: Date.now(), addr: "192.168.1.31", port: 47100 },
  { id: "sun", name: "孙莉 · 测试", avatarHash: null, signature: "测试一切", status: "away", lastSeen: Date.now(), addr: "192.168.1.46", port: 47100 },
  { id: "li", name: "李工 · 运维", avatarHash: null, signature: "稳定第一", status: "online", lastSeen: Date.now(), addr: "192.168.1.12", port: 47100 },
  { id: "zhou", name: "周哲", avatarHash: null, signature: "", status: "offline", lastSeen: Date.now(), addr: null, port: null },
];
const LANCHAT_MOCK_GROUPS = [
  { id: "g1", name: "研发大群", createdAt: Date.now() - 86400000, members: ["me-preview", "zhao", "qian", "sun", "li"] },
  { id: "g2", name: "前端小队", createdAt: Date.now() - 43200000, members: ["me-preview", "zhao"] },
];
const LANCHAT_MOCK_CONVERSATIONS = [
  { id: "direct:zhao", kind: "direct", peerOrGroupId: "zhao", lastMsgAt: Date.now() - 60000, unread: 0 },
  { id: "direct:qian", kind: "direct", peerOrGroupId: "qian", lastMsgAt: Date.now() - 600000, unread: 2 },
  { id: "group:g1", kind: "group", peerOrGroupId: "g1", lastMsgAt: Date.now() - 120000, unread: 5 },
];
const LANCHAT_MOCK_MESSAGES: Record<string, unknown[]> = {
  "direct:zhao": [
    { id: "p1", convId: "direct:zhao", senderId: "zhao", body: "早呀，新版内网通讯的配色我调好了 ✨", mentions: [], createdAt: Date.now() - 300000, state: "delivered" },
    { id: "p2", convId: "direct:zhao", senderId: "me-preview", body: "太好了！发我看看", mentions: [], createdAt: Date.now() - 240000, state: "delivered" },
    { id: "p3", convId: "direct:zhao", senderId: "me-preview", body: "收到，@赵敏 这个主色和我们 Taomni 的靛蓝很搭 👍", mentions: ["zhao"], createdAt: Date.now() - 60000, state: "delivered" },
  ],
  "group:g1": [
    { id: "g1m1", convId: "group:g1", senderId: "sun", body: "周会改到下午三点哈", mentions: [], createdAt: Date.now() - 180000, state: "delivered" },
    { id: "g1m2", convId: "group:g1", senderId: "li", body: "收到 👌", mentions: [], createdAt: Date.now() - 150000, state: "delivered" },
    { id: "g1m3", convId: "group:g1", senderId: "me-preview", body: "好的，记得带上各自的进度", mentions: [], createdAt: Date.now() - 120000, state: "sent" },
  ],
};

export async function invoke<T>(cmd: string, args?: any, options?: InvokeOptions): Promise<T> {
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
    case "list_system_fonts": {
      return [] as T;
    }
    case "clipboard_read_text": {
      return ((await navigator.clipboard?.readText?.()) ?? "") as T;
    }
    case "clipboard_write_text": {
      const text = ((args as InvokeArgs | undefined)?.text as string) ?? "";
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard write is not available in browser preview.");
      }
      await navigator.clipboard.writeText(text);
      return undefined as T;
    }
    case "select_private_key_file": {
      const current = (args?.currentPath as string | null) || "~/.ssh/id_ed25519";
      const selected = await promptAppDialog({
        title: "Private key path",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_upload_file": {
      const selected = await promptAppDialog({
        title: "Upload file path in browser VFS",
        initialValue: VFS_ROOT,
        allowEmpty: true,
      });
      return (selected?.trim() ? [selected.trim()] : []) as T;
    }
    case "select_save_directory": {
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || VFS_ROOT;
      const selected = await promptAppDialog({
        title: "Save directory in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_save_file_path": {
      const defaultName = ((args as InvokeArgs | undefined)?.defaultName as string | null) || "capture.png";
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || `${VFS_ROOT}/${defaultName}`;
      const selected = await promptAppDialog({
        title: "Save file path in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_file_path": {
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || VFS_ROOT;
      const selected = await promptAppDialog({
        title: "File path in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "select_folder_path": {
      const current = ((args as InvokeArgs | undefined)?.currentPath as string | null) || VFS_ROOT;
      const selected = await promptAppDialog({
        title: "Folder path in browser VFS",
        initialValue: current,
        allowEmpty: true,
      });
      return (selected?.trim() || null) as T;
    }
    case "read_file_bytes": {
      return (await vfsReadBytes((args as InvokeArgs)?.path as string)) as T;
    }
    case "check_file_exists": {
      try {
        await vfsStat((args as InvokeArgs)?.path as string);
        return true as T;
      } catch {
        return false as T;
      }
    }
    case "read_plist_session_file": {
      const path = (args as InvokeArgs)?.path as string;
      return {
        source: "plist",
        path,
        relativePath: basename(path),
        text: await vfsReadText(path),
      } as T;
    }
    case "read_stream_open": {
      const path = (args as InvokeArgs)?.path as string;
      const stat = await vfsStat(path);
      const bytes = new Uint8Array(await vfsReadBytes(path));
      const handleId = `read-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      readStreams.set(handleId, { bytes, offset: 0 });
      return { handleId, size: stat.size, mtime: stat.mtime } as T;
    }
    case "read_stream_read": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      const maxBytes = (args as InvokeArgs)?.maxBytes as number;
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_048_576) {
        throw new Error("read_stream_read maxBytes must be between 1 and 1048576");
      }
      const stream = readStreams.get(handleId);
      if (!stream) throw new Error(`Read stream handle ${handleId} not found`);
      const end = Math.min(stream.offset + maxBytes, stream.bytes.byteLength);
      const chunk = stream.bytes.slice(stream.offset, end);
      stream.offset = end;
      return chunk.buffer as T;
    }
    case "read_stream_close": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      if (!readStreams.delete(handleId)) throw new Error(`Read stream handle ${handleId} not found`);
      return undefined as T;
    }
    case "write_stream_open": {
      const handleId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeStreams.set(handleId, { path: (args as InvokeArgs)?.path as string, chunks: [] });
      return handleId as T;
    }
    case "write_stream_append": {
      const handleId = options?.headers?.["x-handle-id"] ?? options?.headers?.["X-Handle-Id"];
      if (!handleId) throw new Error("Missing x-handle-id header");
      const stream = writeStreams.get(handleId);
      if (!stream) throw new Error(`Write stream handle ${handleId} not found`);
      const bytes = rawBytesFromInvokeArgs(args);
      stream.chunks.push(new Uint8Array(bytes));
      return undefined as T;
    }
    case "write_stream_close": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      const stream = writeStreams.get(handleId);
      if (!stream) throw new Error(`Write stream handle ${handleId} not found`);
      writeStreams.delete(handleId);
      await vfsWriteBytes(stream.path, concatChunks(stream.chunks));
      return undefined as T;
    }
    case "write_stream_abort": {
      const handleId = (args as InvokeArgs)?.handleId as string;
      writeStreams.delete(handleId);
      return undefined as T;
    }
    case "temporary_file_path": {
      const defaultName = ((args as InvokeArgs)?.defaultName as string | undefined) || "query-results.dat";
      const dir = `${VFS_ROOT}/tmp/query-results`;
      await vfsMkdir(`${VFS_ROOT}/tmp`).catch(() => undefined);
      await vfsMkdir(dir).catch(() => undefined);
      return `${dir}/${Date.now()}-${defaultName.replace(/[\\/:*?"<>|]/g, "_")}` as T;
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
    case "open_local_shell_as_administrator": {
      throw new Error("Administrator local terminals are not available in browser preview.");
    }
    case "exit_app": {
      window.close();
      return undefined as T;
    }

    // ---------- SFTP commands ----------
    case "sftp_attach": {
      const sid = args?.sessionId as string;
      const result = await sftpAttach({
        sessionId: sid,
        host: args?.host as string,
        port: (args?.port as number) || 22,
        username: args?.username as string,
        authMethod: (args?.authMethod as string) || "Password",
        authData: (args?.authData as string | null) ?? null,
        networkSettingsJson: (args?.networkSettingsJson as string | null) ?? null,
      });
      return result as T;
    }
    case "sftp_detach": {
      await sftpDetach(args?.sessionId as string);
      return undefined as T;
    }
    case "sftp_list_remote": {
      const sid = args?.sessionId as string;
      const path = (args?.path as string) || ".";
      const entries = await sftpListRemote(sid, path);
      return entries as T;
    }
    case "sftp_list_local": {
      const path = (args?.path as string) || "";
      const entries = await vfsList(path);
      return entries as T;
    }
    case "sftp_local_home": {
      const home = await vfsHome();
      return home as T;
    }
    case "sftp_local_drives": {
      return [{ id: "vfs", label: VFS_ROOT, path: VFS_ROOT }] as T;
    }
    case "sftp_mkdir": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsMkdir(args?.path as string);
      } else {
        await sftpMkdirRemote(args?.sessionId as string, args?.path as string);
      }
      return undefined as T;
    }
    case "sftp_remove": {
      const side = (args?.side as string) ?? "remote";
      const recursive = !!args?.recursive;
      if (side === "local") {
        await vfsRemove(args?.path as string, recursive);
      } else {
        await sftpRemoveRemote(args?.sessionId as string, args?.path as string, recursive);
      }
      return undefined as T;
    }
    case "sftp_rename": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsRename(args?.oldPath as string, args?.newPath as string);
      } else {
        await sftpRenameRemote(
          args?.sessionId as string,
          args?.oldPath as string,
          args?.newPath as string,
        );
      }
      return undefined as T;
    }
    case "sftp_stat": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        return (await vfsStat(args?.path as string)) as T;
      }
      const entry = await sftpStatRemote(args?.sessionId as string, args?.path as string);
      return entry as T;
    }
    case "sftp_chmod": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        // The browser preview's local "FS" is the in-memory VFS, which does
        // not track POSIX permission bits. Treat chmod as a successful no-op
        // so the UI flow matches the desktop build.
        return undefined as T;
      }
      await sftpChmodRemote(
        args?.sessionId as string,
        args?.path as string,
        args?.mode as number,
      );
      return undefined as T;
    }
    case "sftp_upload_dir":
    case "sftp_download_dir": {
      // Folder transfers require a recursive walk over the SFTP bridge that
      // the browser-preview proxy does not expose. Surface a friendly error
      // and emit a completion frame so the queue row finalises.
      const transferId = args?.transferId as string;
      const message = "Folder transfers are not available in browser preview. Try the desktop build.";
      void emit(`sftp-transfer-complete-${transferId}`, {
        success: false,
        error: message,
      });
      throw new Error(message);
    }
    case "sftp_realpath": {
      const path = await sftpRealpathRemote(args?.sessionId as string, args?.path as string);
      return path as T;
    }
    case "sftp_read_file_text": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        return (await vfsReadText(args?.path as string)) as T;
      }
      const max = (args?.maxBytes as number) ?? 4 * 1024 * 1024;
      return (await sftpReadTextRemote(
        args?.sessionId as string,
        args?.path as string,
        max,
      )) as T;
    }
    case "sftp_write_file_text": {
      const side = (args?.side as string) ?? "remote";
      if (side === "local") {
        await vfsWriteText(args?.path as string, args?.contents as string);
      } else {
        await sftpWriteTextRemote(
          args?.sessionId as string,
          args?.path as string,
          args?.contents as string,
        );
      }
      return undefined as T;
    }
    case "sftp_upload": {
      // In the web stub, "local" path is a virtual VFS path.
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const localPath = args?.localPath as string;
      const remotePath = args?.remotePath as string;
      const data = await vfsReadBytes(localPath);
      const total = data.byteLength;
      const b64 = arrayBufferToB64(data);
      void emit(`sftp-progress-${transferId}`, { bytes: 0, total, rate: 0, eta: 0 });
      try {
        await sftpUploadBytesRemote(sid, transferId, remotePath, b64);
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, { success: true, finalPath: remotePath });
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_download": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const localPath = args?.localPath as string;
      const openAfter = !!args?.openAfter;
      try {
        const b64 = await sftpDownloadBytesRemote(sid, transferId, remotePath);
        const buf = bytesB64ToArrayBuffer(b64);
        await vfsWriteBytes(localPath, buf);
        const total = buf.byteLength;
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: true,
          finalPath: localPath,
        });
        if (openAfter) {
          vfsExportToBrowser(basename(localPath), buf);
        }
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_upload_bytes": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const bytesB64 = args?.bytesB64 as string;
      const total = atob(bytesB64).length;
      void emit(`sftp-progress-${transferId}`, { bytes: 0, total, rate: 0, eta: 0 });
      try {
        await sftpUploadBytesRemote(sid, transferId, remotePath, bytesB64);
        void emit(`sftp-progress-${transferId}`, { bytes: total, total, rate: 0, eta: 0 });
        void emit(`sftp-transfer-complete-${transferId}`, { success: true, finalPath: remotePath });
      } catch (err) {
        void emit(`sftp-transfer-complete-${transferId}`, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return undefined as T;
    }
    case "sftp_download_bytes": {
      const sid = args?.sessionId as string;
      const transferId = args?.transferId as string;
      const remotePath = args?.remotePath as string;
      const b64 = await sftpDownloadBytesRemote(sid, transferId, remotePath);
      void emit(`sftp-transfer-complete-${transferId}`, { success: true });
      return b64 as T;
    }
    case "sftp_cancel_transfer": {
      // Best-effort: cancel on every attached SFTP session.
      // (browser stub doesn't track per-transfer mapping)
      const transferId = args?.transferId as string;
      // Iterate is not exposed; provide a no-op fallback.
      // We emit "cancelled" so the UI can finish even if the underlying
      // request keeps running on the proxy.
      void emit(`sftp-transfer-complete-${transferId}`, {
        success: false,
        error: "cancelled",
      });
      // attempt to cancel on any session it might belong to:
      const sid = (args?.sessionId as string) || "";
      if (sid && isSftpSession(sid)) sftpCancel(sid, transferId);
      return undefined as T;
    }
    case "sftp_pause_transfer": {
      // Browser stub doesn't have a real per-transfer worker to suspend,
      // but we still emit the paused event so the UI flips to "paused".
      const transferId = args?.transferId as string;
      void emit(`sftp-paused-${transferId}`, {
        bytes: 0,
        total: 0,
        rate: 0,
        eta: 0,
      });
      return undefined as T;
    }
    case "sftp_resume_transfer": {
      // No-op in browser preview; the real backend will start re-emitting
      // progress events when the worker resumes.
      return undefined as T;
    }
    case "open_sftp_window": {
      const sessionId = args?.sessionId as string;
      const url = new URL(window.location.href);
      url.searchParams.set("sftp", sessionId);
      url.hash = "";
      const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
      const handle = window.open(
        url.toString(),
        `taomni_sftp_${sessionId}`,
        features,
      );
      if (!handle) {
        throw new Error(
          "Browser blocked the SFTP window. Allow pop-ups for this site.",
        );
      }
      return undefined as T;
    }
    case "close_current_detached_window": {
      window.close();
      return undefined as T;
    }
    case "open_detached_window": {
      const kind = args?.kind as string;
      const sessionId = args?.sessionId as string;
      const width = (args?.width as number | undefined) ?? 1200;
      const height = (args?.height as number | undefined) ?? 760;
      const url = new URL(window.location.href);
      url.searchParams.set(kind, sessionId);
      url.hash = "";
      const features = `width=${width},height=${height},resizable=yes,scrollbars=yes`;
      const handle = window.open(
        url.toString(),
        `taomni_${kind}_${sessionId}`,
        features,
      );
      if (!handle) {
        throw new Error(
          `Browser blocked the ${kind} window. Allow pop-ups for this site.`,
        );
      }
      return undefined as T;
    }
    // ---------- RDP commands (desktop-only) ----------
    case "rdp_connect":
    case "rdp_disconnect":
    case "rdp_test_connection": {
      throw new Error(
        "RDP is only available in the desktop build of Taomni, not in browser preview.",
      );
    }
    case "sftp_open_path": {
      // No real OS shell in browser preview.
      throw new Error(
        "Opening files with the OS shell is not available in browser preview. Use 'Download to local' to save the file.",
      );
    }
    case "list_tunnels": {
      return loadTunnels() as T;
    }
    case "upsert_tunnel": {
      const config = args?.config as StubTunnelConfig;
      const list = loadTunnels();
      const idx = list.findIndex((t) => t.id === config.id);
      if (idx >= 0) list[idx] = config;
      else list.push(config);
      saveTunnels(list);
      return config as T;
    }
    case "delete_tunnel": {
      const id = args?.id as string;
      saveTunnels(loadTunnels().filter((t) => t.id !== id));
      delete tunnelStatuses[id];
      return undefined as T;
    }
    case "start_tunnel": {
      const id = args?.id as string;
      const tunnel = loadTunnels().find((t) => t.id === id);
      if (!tunnel) throw new Error(`Tunnel ${id} not found`);
      tunnelStatuses[id] = {
        id,
        status: "error",
        error: "Tunnels can only be opened in the desktop build of Taomni.",
      };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }
    case "stop_tunnel": {
      const id = args?.id as string;
      tunnelStatuses[id] = { id, status: "stopped" };
      void emit("tunnel-status", tunnelStatuses[id]);
      return tunnelStatuses[id] as T;
    }
    case "start_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = {
          id: t.id,
          status: "error",
          error: "Desktop-only feature in preview mode.",
        };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }
    case "stop_all_tunnels": {
      const list = loadTunnels();
      for (const t of list) {
        tunnelStatuses[t.id] = { id: t.id, status: "stopped" };
        void emit("tunnel-status", tunnelStatuses[t.id]);
      }
      return list.map((t) => tunnelStatuses[t.id]) as T;
    }
    case "get_tunnel_status": {
      const id = args?.id as string;
      return (tunnelStatuses[id] ?? { id, status: "stopped" }) as T;
    }
    case "list_tunnel_statuses": {
      return Object.values(tunnelStatuses) as T;
    }
    case "test_tunnel": {
      throw new Error("Testing tunnels is only available in the desktop build.");
    }
    case "reorder_tunnels": {
      const ids = (args?.ids as string[]) ?? [];
      const list = loadTunnels();
      const byId = new Map(list.map((t) => [t.id, t]));
      const next: StubTunnelConfig[] = [];
      ids.forEach((id, idx) => {
        const t = byId.get(id);
        if (!t) return;
        next.push({ ...t, sortOrder: idx });
        byId.delete(id);
      });
      for (const t of byId.values()) next.push(t);
      saveTunnels(next);
      return undefined as T;
    }
    // ---------- AI chat drawer commands (browser preview stubs) ----------
    case "chat_list_threads": {
      const limit = Number((args as InvokeArgs | undefined)?.limit ?? 50);
      return loadChatThreads()
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, Number.isFinite(limit) ? limit : 50) as T;
    }
    case "chat_new_thread": {
      const now = Math.floor(Date.now() / 1000);
      const thread: StubChatThread = {
        id: `stub-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: "New chat",
        provider_id: ((args as InvokeArgs | undefined)?.providerId as string | null | undefined) ?? "deepseek",
        created_at: now,
        updated_at: now,
        linked_session_id: ((args as InvokeArgs | undefined)?.linkedSessionId as string | null | undefined) ?? null,
        source: "drawer",
        output_format: null,
        cc_model: null,
      };
      saveChatThreads([thread, ...loadChatThreads()]);
      return thread as T;
    }
    case "chat_list_messages": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const messages = loadChatMessages();
      return (threadId ? messages[threadId] ?? [] : []) as T;
    }
    case "chat_set_thread_provider": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const providerId = (args as InvokeArgs | undefined)?.providerId as string | undefined;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId && providerId ? { ...thread, provider_id: providerId } : thread,
      ));
      return undefined as T;
    }
    case "chat_set_thread_cc_model": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const model = ((args as InvokeArgs | undefined)?.model as string | null | undefined) ?? null;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, cc_model: model } : thread,
      ));
      return undefined as T;
    }
    case "chat_set_thread_output_format": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      const outputFormat = ((args as InvokeArgs | undefined)?.outputFormat as string | null | undefined) ?? null;
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, output_format: outputFormat } : thread,
      ));
      return undefined as T;
    }
    case "chat_delete_thread": {
      const threadId = (args as InvokeArgs | undefined)?.threadId as string | undefined;
      saveChatThreads(loadChatThreads().filter((thread) => thread.id !== threadId));
      const messages = loadChatMessages();
      if (threadId) delete messages[threadId];
      saveChatMessages(messages);
      return undefined as T;
    }
    case "chat_purge_old": {
      return 0 as T;
    }
    case "chat_stop_stream": {
      return undefined as T;
    }
    case "chat_stat_attachment_paths": {
      const paths = ((args as InvokeArgs | undefined)?.paths as string[] | undefined) ?? [];
      return paths.map((path, index) => {
        const name = basename(path);
        const mime = mimeFromName(name);
        return {
          id: `stub-att-${Date.now()}-${index}`,
          kind: mime.startsWith("image/") ? "image" : "file",
          path,
          name,
          size: 0,
          mime,
        } satisfies StubChatAttachment;
      }) as T;
    }
    case "chat_send": {
      const req = (args as InvokeArgs | undefined)?.req as { thread_id?: string; content?: string; attachments?: StubChatAttachment[] } | undefined;
      const threadId = req?.thread_id ?? "";
      const now = Math.floor(Date.now() / 1000);
      const userMessage: StubChatMessage = {
        id: `stub-user-${Date.now()}`,
        thread_id: threadId,
        role: "user",
        content: req?.content ?? "",
        created_at: now,
        redacted: false,
        attachments: req?.attachments ?? [],
      };
      const assistantMessage: StubChatMessage = {
        id: `stub-assistant-${Date.now()}`,
        thread_id: threadId,
        role: "assistant",
        content: "Browser preview stub: connect a desktop AI provider to get a real response.",
        created_at: now,
        redacted: false,
      };
      const messages = loadChatMessages();
      messages[threadId] = [...(messages[threadId] ?? []), userMessage, assistantMessage];
      saveChatMessages(messages);
      saveChatThreads(loadChatThreads().map((thread) =>
        thread.id === threadId ? { ...thread, updated_at: now } : thread,
      ));
      return { user_message: userMessage, assistant_message: assistantMessage } as T;
    }
    // ---------- Database client commands (desktop-only) ----------
    case "db_connect":
    case "db_ping":
    case "db_disconnect":
    case "db_list_catalogs":
    case "db_list_schemas":
    case "db_list_tables":
    case "db_describe_table":
    case "db_list_indexes":
    case "db_execute":
    case "db_execute_stream":
    case "db_cancel":
    case "redis_list_keys":
    case "redis_get_key":
    case "redis_set_key":
    case "redis_del_key":
    case "redis_exec":
    case "hbase_connect":
    case "hbase_ping":
    case "hbase_disconnect":
    case "hbase_list_tables":
    case "hbase_describe_table":
    case "hbase_execute": {
      throw new Error(
        "Database and HBase connections are not available in browser preview. Use the desktop build of Taomni.",
      );
    }
    /* ----------------------------- LanChat (内网通讯) ----------------------------- */
    case "lanchat_status": {
      return { running: false, nodeId: "preview", peerCount: LANCHAT_MOCK_PEERS.length } as T;
    }
    case "lanchat_list_peers": {
      return LANCHAT_MOCK_PEERS as T;
    }
    case "lanchat_get_profile": {
      return {
        id: "me-preview",
        name: "林开发",
        avatarBase64: null,
        avatarHash: null,
        signature: "摸鱼中，勿扰 ✨",
        status: "online",
        updatedAt: Date.now(),
      } as T;
    }
    case "lanchat_list_conversations": {
      return LANCHAT_MOCK_CONVERSATIONS as T;
    }
    case "lanchat_list_groups": {
      return LANCHAT_MOCK_GROUPS as T;
    }
    case "lanchat_list_messages": {
      const convId = (args as InvokeArgs | undefined)?.convId as string | undefined;
      return ((convId && LANCHAT_MOCK_MESSAGES[convId]) ?? []) as T;
    }
    case "lanchat_mark_read": {
      return undefined as T;
    }
    case "lanchat_open_path": {
      return undefined as T;
    }
    case "lanchat_send_text":
    case "lanchat_send_group_text":
    case "lanchat_resend_message":
    case "lanchat_update_profile":
    case "lanchat_create_group":
    case "lanchat_leave_group":
    case "lanchat_send_file":
    case "lanchat_send_group_file":
    case "lanchat_send_dir":
    case "lanchat_accept_file":
    case "lanchat_reject_file":
    case "lanchat_transfer_control":
    case "lanchat_send_screenshot":
    case "lanchat_send_clipboard_image":
    case "lanchat_send_signal":
    case "lanchat_signal_group": {
      throw new Error("内网通讯仅桌面版可用：浏览器预览不支持真实发现与直连。");
    }
    default:
      console.warn(`[tauri-stub] Unknown invoke command: ${cmd}`, args);
      if (cmd === "history_match_prefix" || cmd === "history_list_recent") {
        return ([] as unknown) as T;
      }
      if (
        cmd === "history_append" ||
        cmd === "history_clear"
      ) {
        return undefined as T;
      }
      return undefined as T;
  }
}
