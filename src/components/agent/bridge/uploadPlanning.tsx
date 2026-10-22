import { basename, joinPath, sftpListLocal, sftpStat, type FileEntry } from "../../../lib/sftp";
import { asStringList } from "./arguments";
import { isDirectory } from "./sftpSession";
import { type SftpUploadPlan } from "./types";


export function uploadLocalPaths(args: Record<string, unknown>): string[] {
  const paths = [
    ...asStringList(args.local_path),
    ...asStringList(args.local_paths),
  ];
  return paths.filter((path, index) => paths.indexOf(path) === index);
}


export async function localEntryTransferSize(entry: FileEntry): Promise<number> {
  if (entry.fileType !== "dir") return entry.size || 0;
  const children = await sftpListLocal(entry.path);
  let total = 0;
  for (const child of children) {
    total += await localEntryTransferSize(child);
  }
  return total;
}


export async function resolveUploadRemotePath(
  sessionId: string,
  remotePath: string,
  localName: string,
  totalCount: number,
): Promise<string> {
  if (remotePath.endsWith("/") || remotePath.endsWith("\\")) {
    return joinPath(remotePath, localName);
  }

  try {
    const remoteEntry = await sftpStat(sessionId, remotePath, "remote");
    if (isDirectory(remoteEntry)) return joinPath(remotePath, localName);
  } catch {
    // Missing remote paths are valid for a single-file upload, where the path
    // names the desired destination file. Multiple files need a directory.
  }

  if (totalCount > 1) {
    throw new Error(
      "sftp_upload with multiple local paths requires remote_path to be an existing remote directory or end with /",
    );
  }
  return remotePath;
}


export async function buildSftpUploadPlans(
  sessionId: string,
  localPaths: string[],
  remotePath: string,
): Promise<SftpUploadPlan[]> {
  const plans: SftpUploadPlan[] = [];
  for (const localPath of localPaths) {
    const entry = await sftpStat(sessionId, localPath, "local")
      .catch((err) => {
        throw new Error(`Local upload path does not exist: ${localPath} (${err})`);
      });
    const name = entry.name || basename(localPath) || "upload";
    const kind = entry.fileType === "dir" ? "dir" : "file";
    const size = await localEntryTransferSize(entry);
    plans.push({
      name,
      kind,
      size,
      localPath: entry.path || localPath,
      remotePath: await resolveUploadRemotePath(sessionId, remotePath, name, localPaths.length),
    });
  }
  return plans;
}


export function formatUploadSummary(results: Array<{ localPath: string; remotePath: string }>): string {
  const lines = results.slice(0, 8).map((item) => `${item.localPath} -> ${item.remotePath}`);
  if (results.length > lines.length) {
    lines.push(`... ${results.length - lines.length} more`);
  }
  return lines.join("\n");
}
