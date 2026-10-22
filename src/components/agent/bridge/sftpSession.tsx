import { joinPath, sftpStat, type FileEntry } from "../../../lib/sftp";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../../lib/networkSettings";
import { useAppStore } from "../../../stores/appStore";
import { useSftpStore } from "../../../stores/sftpStore";


export function sftpSessionCandidates(sessionId: string): string[] {
  if (!sessionId) return [];
  const candidates = [sessionId];
  if (!sessionId.startsWith("attached-")) {
    candidates.push(`attached-${sessionId}`);
  }
  return candidates;
}


export async function ensureSftpSession(rawSessionId: string): Promise<string> {
  const sftpStore = useSftpStore.getState();
  for (const id of sftpSessionCandidates(rawSessionId)) {
    if (sftpStore.sessions[id]?.attached) return id;
  }

  const appState = useAppStore.getState();
  const tabId = rawSessionId.startsWith("attached-")
    ? rawSessionId.slice("attached-".length)
    : rawSessionId;
  const tab = appState.tabs.find((t) =>
    t.id === tabId ||
    t.sftp?.sessionId === rawSessionId ||
    t.sftp?.sessionId === `attached-${tabId}`
  );

  if (tab?.sftp) {
    await sftpStore.attach({
      sessionId: tab.sftp.sessionId,
      host: tab.sftp.host,
      port: tab.sftp.port,
      username: tab.sftp.username,
      authMethod: tab.sftp.authMethod,
      authData: tab.sftp.authData,
      networkSettingsJson: tab.sftp.networkSettingsJson ?? null,
    });
    return tab.sftp.sessionId;
  }

  if (tab?.ssh) {
    const sessionId = `attached-${tab.id}`;
    await sftpStore.attach({
      sessionId,
      host: tab.ssh.host,
      port: tab.ssh.port,
      username: tab.ssh.username,
      authMethod: tab.ssh.authMethod,
      authData: tab.ssh.authData,
      networkSettingsJson: JSON.stringify(
        toNetworkSettingsPayload(getSessionNetworkSettings(tab.ssh.optionsJson)),
      ),
    });
    return sessionId;
  }

  throw new Error(`SFTP session is not attached for ${rawSessionId}`);
}


export function isDirectory(entry: FileEntry): boolean {
  return entry.fileType === "dir" || entry.targetFileType === "dir";
}


export function splitNameForSuffix(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name || "download", ext: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name || "download", ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}


export async function localPathExists(sessionId: string, path: string): Promise<boolean> {
  try {
    await sftpStat(sessionId, path, "local");
    return true;
  } catch {
    return false;
  }
}


export async function uniqueLocalPath(
  sessionId: string,
  localDir: string,
  name: string,
  isDir: boolean,
): Promise<string> {
  const first = joinPath(localDir, name || "download");
  if (!(await localPathExists(sessionId, first))) return first;

  const { stem, ext } = splitNameForSuffix(name, isDir);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = joinPath(localDir, `${stem} (${i})${ext}`);
    if (!(await localPathExists(sessionId, candidate))) return candidate;
  }
  throw new Error(`Could not find a free local filename in ${localDir}`);
}


export function showSftpNotification(title: string, body: string): void {
  useAppStore.getState().setStatusMessage(`${title}: ${body}`);
  void import("@tauri-apps/plugin-notification")
    .then(async (mod) => {
      if (await mod.isPermissionGranted()) {
        mod.sendNotification({ title, body });
      }
    })
    .catch(() => {
      /* best-effort only */
    });
}


export function showSftpDownloadNotification(finalPath: string): void {
  showSftpNotification("SFTP download complete", finalPath);
}


export function showSftpUploadNotification(finalPath: string): void {
  showSftpNotification("SFTP upload complete", finalPath);
}
