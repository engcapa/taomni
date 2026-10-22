import { listenSftpComplete, listenSftpPaused, listenSftpProgress, sftpDownload, sftpDownloadDir, sftpUpload, sftpUploadDir, type TransferCompletePayload, type TransferProgressPayload } from "../../../lib/sftp";
import { useTransferStore } from "../../../stores/transferStore";
import { type AgentToolContext } from "./types";
import { fmtBytes } from "./formatting";
import { reportAgentToolStatus } from "./toolCards";


export async function runTrackedSftpTransfer(opts: {
  transferId: string;
  failureLabel: string;
  run: () => Promise<void>;
  onProgress?: (payload: TransferProgressPayload) => void;
}): Promise<TransferCompletePayload | null> {
  const transferStore = useTransferStore.getState();
  let completePayload: TransferCompletePayload | null = null;
  let unlistenProgress: (() => void) | null = null;
  let unlistenPaused: (() => void) | null = null;
  let unlistenComplete: (() => void) | null = null;
  let resolveComplete: (payload: TransferCompletePayload) => void = () => {};
  const completePromise = new Promise<TransferCompletePayload>((resolve) => {
    resolveComplete = resolve;
  });

  try {
    const [progress, paused, complete] = await Promise.all([
      listenSftpProgress(opts.transferId, (payload) => {
        opts.onProgress?.(payload);
        transferStore.patch(opts.transferId, {
          bytes: payload.bytes,
          size: payload.total || undefined,
          rate: payload.rate,
          eta: payload.eta,
          state: "running",
        });
      }),
      listenSftpPaused(opts.transferId, (payload) => {
        transferStore.patch(opts.transferId, {
          bytes: payload.bytes,
          rate: 0,
          eta: 0,
          state: "paused",
        });
      }),
      listenSftpComplete(opts.transferId, (payload) => {
        completePayload = payload;
        if (payload.success) {
          transferStore.setState(opts.transferId, "done");
        } else {
          transferStore.setState(opts.transferId, "error", payload.error ?? opts.failureLabel);
        }
        resolveComplete(payload);
      }),
    ]);
    unlistenProgress = progress;
    unlistenPaused = paused;
    unlistenComplete = complete;

    await opts.run();

    return completePayload ?? await Promise.race([
      completePromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
  } finally {
    unlistenProgress?.();
    unlistenPaused?.();
    unlistenComplete?.();
  }
}


export async function runTrackedSftpDownload(opts: {
  sessionId: string;
  transferId: string;
  remotePath: string;
  localPath: string;
  isDir: boolean;
  onProgress?: (payload: TransferProgressPayload) => void;
}): Promise<TransferCompletePayload | null> {
  return runTrackedSftpTransfer({
    transferId: opts.transferId,
    failureLabel: "download failed",
    onProgress: opts.onProgress,
    run: async () => {
      if (opts.isDir) {
        await sftpDownloadDir(opts.sessionId, opts.transferId, opts.remotePath, opts.localPath);
      } else {
        await sftpDownload(opts.sessionId, opts.transferId, opts.remotePath, opts.localPath, false);
      }
    },
  });
}


export async function runTrackedSftpUpload(opts: {
  sessionId: string;
  transferId: string;
  localPath: string;
  remotePath: string;
  isDir: boolean;
  onProgress?: (payload: TransferProgressPayload) => void;
}): Promise<TransferCompletePayload | null> {
  return runTrackedSftpTransfer({
    transferId: opts.transferId,
    failureLabel: "upload failed",
    onProgress: opts.onProgress,
    run: async () => {
      if (opts.isDir) {
        await sftpUploadDir(opts.sessionId, opts.transferId, opts.localPath, opts.remotePath);
      } else {
        await sftpUpload(opts.sessionId, opts.transferId, opts.localPath, opts.remotePath, false);
      }
    },
  });
}


export function makeTransferProgressReporter(
  ctx: AgentToolContext | null | undefined,
  prefix: string,
): (payload: TransferProgressPayload) => void {
  let lastReport = 0;
  return (payload) => {
    const now = Date.now();
    if (now - lastReport < 1000 && payload.bytes < payload.total) return;
    lastReport = now;
    const total = payload.total > 0 ? ` / ${fmtBytes(payload.total)}` : "";
    const rate = payload.rate > 0 ? ` @ ${fmtBytes(payload.rate)}/s` : "";
    reportAgentToolStatus(ctx, `${prefix}: ${fmtBytes(payload.bytes)}${total}${rate}`);
  };
}
