import type { SftpTabInfo } from "../types";
import { useSftpStore } from "../stores/sftpStore";

export interface DetachedSftpParams extends SftpTabInfo {
  /** The popup owns a separate SFTP channel; this identifies its source. */
  parentSessionId?: string;
  title?: string;
}

export function sftpWindowPaths(sessionId: string) {
  const session = useSftpStore.getState().sessions[sessionId];
  return {
    ...(session?.remote.path ? { initialPath: session.remote.path } : {}),
    ...(session?.local.path ? { initialLocalPath: session.local.path } : {}),
  };
}
