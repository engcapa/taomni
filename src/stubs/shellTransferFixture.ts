/** Browser service fixture: progresses real renderer transfer requests through
 * the same progress/paused/complete events as the native SFTP worker. */
import { emit } from "./tauri-event";
import { vfsReadText, vfsWriteText } from "./localVfs";

interface Job {
  id: string;
  owner: string;
  bytes: number;
  total: number;
  paused: boolean;
  cancelled: boolean;
}
const jobs = new Map<string, Job>();
const finished = new Map<string, { id: string; payload: { success: boolean; error?: string; finalPath?: string } }>();
const CONTROL = "taomni.qa.shell.transferControl";
export async function replayShellTransfer(owner: string) {
  const terminal = finished.get(owner);
  if (!terminal) throw new Error("No completed transfer exists for this fixture owner");
  await emit(`sftp-transfer-complete-${terminal.id}`, terminal.payload);
}

// The runner controls this external service through one page-local endpoint.
// Importing a second HMR module would create a second job registry.
const replayEvent = "qa-shell-transfer-replay";
const replay = (event: Event) => {
  const detail = (event as CustomEvent<{ owner: string; resolve(): void; reject(error: unknown): void }>).detail;
  void replayShellTransfer(detail.owner).then(detail.resolve, detail.reject);
};
window.addEventListener(replayEvent, replay);
import.meta.hot?.dispose(() => window.removeEventListener(replayEvent, replay));

export async function shellTransferInvoke(command: string, args: any, root?: string, owner?: string): Promise<{ value: unknown } | null> {
  const job = jobs.get(args.transferId);
  if (job && ["sftp_cancel_transfer", "sftp_pause_transfer", "sftp_resume_transfer"].includes(command)) {
    if (command === "sftp_cancel_transfer") job.cancelled = true;
    else {
      job.paused = command === "sftp_pause_transfer";
      await emit(`sftp-${job.paused ? "paused" : "progress"}-${job.id}`, { bytes: job.bytes, total: job.total, rate: 0, eta: 0 });
    }
    return { value: undefined };
  }
  if (!root || !owner || !["sftp_download", "sftp_upload"].includes(command)) return null;
  const remote = `${root}/${String(args.remotePath).replace(/^\/home\/qa\/?/, "").replace(/^\/+/, "")}`;
  const text = await vfsReadText(command === "sftp_download" ? remote : args.localPath);
  const current: Job = { id: args.transferId, owner, bytes: 0, total: new TextEncoder().encode(text).length, paused: false, cancelled: false };
  jobs.set(current.id, current);
  const progress = async (percent: number) => {
    current.bytes = Math.floor(current.total * percent / 100);
    await emit(`sftp-progress-${current.id}`, { bytes: current.bytes, total: current.total, rate: current.total, eta: 1 });
  };
  const complete = async (payload: { success: boolean; error?: string; finalPath?: string }) => {
    finished.set(owner, { id: current.id, payload });
    await emit(`sftp-transfer-complete-${current.id}`, payload);
  };
  try {
    await progress(30);
    if (localStorage.getItem("taomni.qa.shell.transferControlled") === "true") {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (current.cancelled) { await complete({ success: false, error: "Transfer cancelled" }); return { value: undefined }; }
        const controls = JSON.parse(localStorage.getItem(CONTROL) ?? "[]") as Array<{ owner: string; action: "advance" | "complete" | "fail" }>;
        const index = controls.findIndex((control) => control.owner === owner && (!current.paused || control.action === "fail"));
        if (index >= 0) {
          const [control] = controls.splice(index, 1); localStorage.setItem(CONTROL, JSON.stringify(controls));
          if (control.action === "advance") await progress(60);
          else if (control.action === "fail") { await complete({ success: false, error: "Fixture transfer failure" }); return { value: undefined }; }
          else break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (Date.now() >= deadline) throw new Error("Transfer fixture was not released within its test budget");
    }
    await vfsWriteText(command === "sftp_download" ? args.localPath : remote, text);
    await progress(100);
    await complete({ success: true, finalPath: command === "sftp_download" ? args.localPath : args.remotePath });
    return { value: undefined };
  } finally { jobs.delete(current.id); }
}
