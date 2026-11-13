import { openFile } from "./openFile";
import { sftpStat } from "./sftp";
import { viewerCreateTemp, viewerReleaseTemp } from "./viewer";

type OpenOptions = Parameters<typeof openFile>[1];
interface TemporaryFileRequest {
  /** Stable source identity, never a credential (session/folder/uid or session/path). */
  key: string;
  fileName: string;
  source: "remote-temp" | "mail-attachment";
  readOnlyReason: string;
  download: (path: string) => Promise<void>;
  /** SFTP's transfer queue owns resumable partials until retry/removal/process exit. */
  retainPartialOnFailure?: boolean;
  /** Exact registered destination already owned by a queued resumable retry. */
  retryPath?: string;
}

const downloads = new Map<string, Promise<string>>();
const partialPaths = new Map<string, string>();

/** Download ownership is independent of a view; identical sources reuse their copy. */
export async function openTemporaryFile(request: TemporaryFileRequest, options: OpenOptions): Promise<string | void> {
  let download = downloads.get(request.key);
  if (download) {
    const path = await download;
    try {
      // Closing the last host releases the temp. Never reuse a missing copy.
      await sftpStat("", path, "local");
    } catch {
      if (downloads.get(request.key) === download) downloads.delete(request.key);
      download = downloads.get(request.key);
    }
  }
  if (!download) {
    const task = (async () => {
      const path = request.retryPath ?? partialPaths.get(request.key) ?? (await viewerCreateTemp(request.fileName, [])).path;
      if (request.retainPartialOnFailure) partialPaths.set(request.key, path);
      try {
        await request.download(path);
        partialPaths.delete(request.key);
        return path;
      } catch (error) {
        if (!request.retainPartialOnFailure) await viewerReleaseTemp(path).catch(() => {});
        throw error;
      }
    })();
    downloads.set(request.key, task);
    download = task;
    void task.catch(() => {
      if (downloads.get(request.key) === task) downloads.delete(request.key);
    });
  }
  const path = await download;
  // A successfully downloaded copy remains registered even if routing fails;
  // retry can reuse it. The backend owns final release and process-exit cleanup.
  return openFile({ path, source: request.source, readOnlyReason: request.readOnlyReason }, options);
}
