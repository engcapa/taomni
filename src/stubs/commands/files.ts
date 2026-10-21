import { isSftpSession, sftpAttach, sftpDetach, sftpListRemote, sftpStatRemote, sftpMkdirRemote, sftpRemoveRemote, sftpRenameRemote, sftpChmodRemote, sftpRealpathRemote, sftpReadTextRemote, sftpWriteTextRemote, sftpUploadBytesRemote, sftpDownloadBytesRemote, sftpCancel } from "../sftpClient";
import { vfsHome, vfsList, vfsStat, vfsMkdir, vfsRemove, vfsRename, vfsReadText, vfsWriteText, vfsReadBytes, vfsWriteBytes, vfsExportToBrowser, VFS_ROOT } from "../localVfs";
import { emit } from "../tauri-event";
import { promptAppDialog } from "../../lib/appDialogs";
import { type InvokeOptions, type InvokeArgs } from "./runtime";

export const writeStreams = new Map<string, { path: string; chunks: Uint8Array[] }>();

export const readStreams = new Map<string, { bytes: Uint8Array; offset: number }>();

export function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx < 0 ? path : path.slice(idx + 1);
}

export function mimeFromName(name: string): string {
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
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
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

export function bytesB64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function arrayBufferToB64(data: ArrayBuffer): string {
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

export function rawBytesFromInvokeArgs(args?: unknown): Uint8Array {
  if (args instanceof Uint8Array) return args;
  if (args instanceof ArrayBuffer) return new Uint8Array(args);
  if (ArrayBuffer.isView(args)) {
    return new Uint8Array(args.buffer, args.byteOffset, args.byteLength);
  }
  throw new Error("Expected raw bytes payload");
}

export function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export async function invokeFiles<T>(cmd: string, args?: any, options?: InvokeOptions): Promise<T> {
  switch (cmd) {

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
      try {
        return (await vfsReadBytes((args as InvokeArgs)?.path as string)) as T;
      } catch {
        const path = String((args as InvokeArgs)?.path ?? "");
        if (path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg") || path.endsWith(".gif")) {
          const png = new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
            0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
            0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
            0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
          ]);
          return png.buffer as T;
        }
        return new TextEncoder().encode("stub content").buffer as T;
      }
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

    case "open_local_shell_as_administrator": {
      throw new Error("Administrator local terminals are not available in browser preview.");
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

    case "sftp_list_local_detailed": {
      const path = (args?.path as string) || "";
      const entries = await vfsList(path);
      return { entries, skippedCount: 0, diagnostics: [] } as T;
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

    case "sftp_open_path": {
      // No real OS shell in browser preview.
      throw new Error(
        "Opening files with the OS shell is not available in browser preview. Use 'Download to local' to save the file.",
      );
    }
    default: throw new Error(`Unhandled files stub command: ${cmd}`);
  }
}
