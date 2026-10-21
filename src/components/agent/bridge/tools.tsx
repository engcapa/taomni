import { invoke } from "@tauri-apps/api/core";
import { getTerminal } from "../../../lib/terminal/terminalRegistry";
import { buildInteractiveCommandInput } from "../../../lib/terminal/commandInput";
import { basename, sftpStat } from "../../../lib/sftp";
import { useSftpStore } from "../../../stores/sftpStore";
import { newTransferId, useTransferStore } from "../../../stores/transferStore";
import { type AgentToolContext, type ToolDispatch } from "./types";
import { LARGE_UPLOAD_THRESHOLD_BYTES, fmtBytes } from "./formatting";
import { asString } from "./arguments";
import { uploadLocalPaths, buildSftpUploadPlans, formatUploadSummary } from "./uploadPlanning";
import { ensureSftpSession, showSftpUploadNotification, isDirectory, uniqueLocalPath, showSftpDownloadNotification } from "./sftpSession";
import { reportAgentToolStatus } from "./toolCards";
import { runTrackedSftpUpload, makeTransferProgressReporter, runTrackedSftpDownload } from "./transfers";


export async function executeSftpUploadTool(
  args: Record<string, unknown>,
  ctx?: AgentToolContext,
): Promise<string> {
  const rawSessionId = asString(args.session_id);
  const localPaths = uploadLocalPaths(args);
  const remotePath = asString(args.remote_path ?? args.remote_dir);
  if (!rawSessionId) throw new Error("sftp_upload requires session_id");
  if (localPaths.length === 0) throw new Error("sftp_upload requires local_path or local_paths");
  if (!remotePath) throw new Error("sftp_upload requires remote_path");

  const sessionId = await ensureSftpSession(rawSessionId);
  reportAgentToolStatus(ctx, `Preparing SFTP upload to ${remotePath}`);
  const plans = await buildSftpUploadPlans(sessionId, localPaths, remotePath);
  const totalBytes = plans.reduce((sum, plan) => sum + plan.size, 0);
  if (totalBytes > LARGE_UPLOAD_THRESHOLD_BYTES) {
    reportAgentToolStatus(
      ctx,
      `Large SFTP upload: ${fmtBytes(totalBytes)}; this may take a while`,
    );
  }

  const completed: Array<{ localPath: string; remotePath: string }> = [];
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index];
    const transferId = newTransferId();
    const ordinal = plans.length > 1 ? `${index + 1}/${plans.length} ` : "";
    useTransferStore.getState().add({
      id: transferId,
      sessionId,
      direction: "upload",
      kind: plan.kind,
      localPath: plan.localPath,
      remotePath: plan.remotePath,
      size: plan.size,
      bytes: 0,
      rate: 0,
      eta: 0,
      state: "queued",
      startedAt: Date.now(),
      openAfter: false,
    });

    reportAgentToolStatus(ctx, `Uploading ${ordinal}${plan.name} -> ${plan.remotePath}`);
    try {
      const payload = await runTrackedSftpUpload({
        sessionId,
        transferId,
        localPath: plan.localPath,
        remotePath: plan.remotePath,
        isDir: plan.kind === "dir",
        onProgress: makeTransferProgressReporter(ctx, `Uploading ${ordinal}${plan.name}`),
      });
      if (payload && !payload.success) {
        throw new Error(payload.error ?? "upload failed");
      }
      const finalPath = payload?.finalPath || plan.remotePath;
      completed.push({ localPath: plan.localPath, remotePath: finalPath });
      void useSftpStore.getState().refreshPane(sessionId, "remote").catch(() => undefined);
      showSftpUploadNotification(finalPath);
      reportAgentToolStatus(ctx, `Completed upload ${ordinal}${plan.name} -> ${finalPath}`);
    } catch (err) {
      useTransferStore.getState().setState(
        transferId,
        "error",
        err instanceof Error ? err.message : String(err),
      );
      const prefix = completed.length > 0
        ? `Upload failed after ${completed.length}/${plans.length} completed`
        : "Upload failed";
      throw new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const largeNote = totalBytes > LARGE_UPLOAD_THRESHOLD_BYTES
    ? `large upload ${fmtBytes(totalBytes)}; `
    : "";
  return `${largeNote}uploaded ${completed.length} item(s):\n${formatUploadSummary(completed)}`;
}


export async function executeSftpDownloadTool(
  args: Record<string, unknown>,
  ctx?: AgentToolContext,
): Promise<string> {
  const rawSessionId = asString(args.session_id);
  const remotePath = asString(args.remote_path);
  const localDir = asString(args.local_dir ?? args.local_path ?? args.target_dir);
  if (!rawSessionId) throw new Error("sftp_download requires session_id");
  if (!remotePath) throw new Error("sftp_download requires remote_path");
  if (!localDir) throw new Error("sftp_download requires local_dir");

  const sessionId = await ensureSftpSession(rawSessionId);
  const localDirEntry = await sftpStat(sessionId, localDir, "local")
    .catch((err) => {
      throw new Error(`Local download directory does not exist: ${localDir} (${err})`);
    });
  if (!isDirectory(localDirEntry)) {
    throw new Error(`Local download target is not a directory: ${localDir}`);
  }

  const remoteEntry = await sftpStat(sessionId, remotePath, "remote");
  const isDir = isDirectory(remoteEntry);
  const localName = remoteEntry.name || basename(remotePath) || "download";
  const localPath = await uniqueLocalPath(sessionId, localDir, localName, isDir);
  const transferId = newTransferId();
  reportAgentToolStatus(ctx, `Preparing SFTP download: ${remotePath} -> ${localPath}`);

  useTransferStore.getState().add({
    id: transferId,
    sessionId,
    direction: "download",
    kind: isDir ? "dir" : "file",
    localPath,
    remotePath,
    size: isDir ? 0 : remoteEntry.size,
    bytes: 0,
    rate: 0,
    eta: 0,
    state: "queued",
    startedAt: Date.now(),
    openAfter: false,
  });

  try {
    const payload = await runTrackedSftpDownload({
      sessionId,
      transferId,
      remotePath,
      localPath,
      isDir,
      onProgress: makeTransferProgressReporter(ctx, `Downloading ${localName}`),
    });
    if (payload && !payload.success) {
      throw new Error(payload.error ?? "download failed");
    }
    const finalPath = payload?.finalPath || localPath;
    void useSftpStore.getState().refreshPane(sessionId, "local").catch(() => undefined);
    showSftpDownloadNotification(finalPath);
    reportAgentToolStatus(ctx, `Downloaded ${remotePath} -> ${finalPath}`);
    return `downloaded ${remotePath} -> ${finalPath}`;
  } catch (err) {
    useTransferStore.getState().setState(
      transferId,
      "error",
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}


/** Perform an approved side-effect tool and report the outcome back to CC. */
export async function executeTool(dispatch: ToolDispatch): Promise<void> {
  let ok = false;
  let output = "";
  const args = dispatch.args ?? {};
  try {
    switch (dispatch.tool) {
      case "run_in_terminal": {
        // `session_id` here is the thread's bound terminal *tabId* (what
        // linked_session_id stores), not the backend session id. Look the live
        // panel up in the registry and use its writeInput(): it targets the
        // correct backend session and base64-encodes internally. Passing the
        // tabId straight to writeTerminal would address the wrong session.
        const tabId = String(args.session_id ?? "");
        const command = String(args.command ?? "");
        if (!tabId) {
          output = "run_in_terminal requires a session_id";
          break;
        }
        const term = getTerminal(tabId);
        if (!term) {
          return;
        }
        term.writeInput(buildInteractiveCommandInput(command));
        ok = true;
        output = "command sent to terminal";
        break;
      }
      case "read_terminal_tail": {
        // Lets CC read back what a command actually produced in the bound SSH
        // session, instead of guessing the output from environment context.
        const tabId = String(args.session_id ?? "");
        if (!tabId) {
          output = "read_terminal_tail requires a session_id";
          break;
        }
        const term = getTerminal(tabId);
        if (!term) {
          return;
        }
        const n = Number(args.lines ?? 50);
        output = term.getLastLines(Number.isFinite(n) && n > 0 ? n : 50);
        ok = true;
        break;
      }
      case "sftp_upload": {
        output = await executeSftpUploadTool(args, {
          threadId: dispatch.threadId,
          callId: dispatch.callId,
          tool: "sftp_upload",
        });
        ok = true;
        break;
      }
      case "sftp_download": {
        output = await executeSftpDownloadTool(args, {
          threadId: dispatch.threadId,
          callId: dispatch.callId,
          tool: "sftp_download",
        });
        ok = true;
        break;
      }
      case "switch_tab":
        output = "switch_tab is deprecated in this bridge; call taomni_control.session_open for saved sessions or taomni_control.tab_switch for already-open tabs.";
        break;
      case "open_session_editor":
        output = "open_session_editor is deprecated in this bridge; call taomni_control.session_open_editor instead.";
        break;
      default:
        output = `工具 "${dispatch.tool}" 暂不支持从界面执行`;
    }
  } catch (e) {
    output = e instanceof Error ? e.message : String(e);
  }
  try {
    await invoke("cc_resolve_tool_call", {
      callId: dispatch.callId,
      ok,
      output,
    });
  } catch (e) {
    console.error("cc_resolve_tool_call failed:", e);
  }
}
