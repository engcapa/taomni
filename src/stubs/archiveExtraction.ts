import { archiveExtractionActive, archiveExtractionCanCancel, type ArchiveEntry, type ArchiveExtraction } from "../lib/openFile/archive";
import { createArchiveStage, loadArchive, publishArchiveStage, stageArchiveEntry } from "./archivePreview";
import { sha256Bytes } from "./commands/workspace/encoding";
import { vfsReadBytes, vfsRemove } from "./localVfs";

interface Job {
  snapshot: ArchiveExtraction;
  entry?: ArchiveEntry;
  stage?: Awaited<ReturnType<typeof createArchiveStage>>;
  sourceHash?: string;
  checkpoints: Map<number, string>;
}

const jobs = new Map<string, Job>();

function snapshot(job: Job | undefined) {
  return job ? { ...job.snapshot } : null;
}

function cancelled(job: Job): boolean {
  return job.snapshot.phase === "cancelling";
}

async function run(path: string, job: Job) {
  const status = job.snapshot;
  try {
    const { entries, content, compressed, bytes } = await loadArchive(path);
    const sourceHash = await sha256Bytes(new Uint8Array(bytes));
    if (job.sourceHash && job.sourceHash !== sourceHash) throw new Error("The source archive has changed");
    job.sourceHash = sourceHash;
    const entry = job.entry ? entries[job.entry.index] : compressed ? entries[0] : undefined;
    if (job.entry && (!entry || entry.directory || entry.name !== job.entry.name || entry.size !== job.entry.size || entry.crc !== job.entry.crc)) {
      throw new Error("Archive changed. Reload before extracting the entry");
    }
    const selected = entry ? [entry] : entries;
    status.totalBytes = selected.reduce((total, item) => total + (item.directory ? 0 : item.size), 0);
    if (cancelled(job)) return;
    const stage = job.stage ?? await createArchiveStage(status.destination);
    job.stage = stage;
    if (cancelled(job)) return;
    status.phase = "extracting";
    for (const item of selected) {
      if (cancelled(job)) return;
      if (item.directory) {
        await stageArchiveEntry(stage, item, content);
        continue;
      }
      const expected = job.checkpoints.get(item.index);
      if (expected) {
        const staged = new Uint8Array(await vfsReadBytes(stage.path + "/" + item.name));
        if (staged.byteLength !== item.size || await sha256Bytes(staged) !== expected) {
          throw new Error("A staged archive member has changed");
        }
      } else {
        const data = await content(item);
        if (cancelled(job)) return;
        const hash = await sha256Bytes(new Uint8Array(data));
        await stageArchiveEntry(stage, item, async () => data);
        job.checkpoints.set(item.index, hash);
      }
      status.bytes += item.size;
      status.retainedBytes += item.size;
    }
    if (cancelled(job)) return;
    status.phase = "verifying";
    if (await sha256Bytes(new Uint8Array(await vfsReadBytes(path))) !== sourceHash) {
      throw new Error("The source archive changed during extraction");
    }
    if (cancelled(job)) return;
    status.phase = "publishing";
    status.output = await publishArchiveStage(path, status.destination, stage, entry);
    await vfsRemove(stage.path, true);
    job.stage = undefined;
    status.phase = "completed";
  } catch (error) {
    if (!cancelled(job)) {
      status.phase = "failed";
      status.error = String(error);
      status.canResume = !!job.stage;
    }
  } finally {
    if (cancelled(job)) {
      status.phase = "cancelled";
      status.canResume = true;
    }
  }
}

export async function invokeArchiveJob(command: string, path: string, args: Record<string, unknown>) {
  const job = jobs.get(path);
  if (command === "viewer_archive_job_status") return snapshot(job);
  if (command === "viewer_archive_job_start") {
    if (job && archiveExtractionActive(job.snapshot.phase)) return snapshot(job);
    if (job?.snapshot.canResume) throw new Error("Resume or discard the previous extraction first");
    const entry = args.entry as ArchiveEntry | undefined;
    const next: Job = {
      entry,
      snapshot: {
        id: crypto.randomUUID(), phase: "preparing", destination: String(args.destination), member: entry?.name ?? null,
        bytes: 0, totalBytes: Number(args.totalBytes), retainedBytes: 0, canResume: false, output: null, error: null,
      },
      checkpoints: new Map(),
    };
    jobs.set(path, next);
    void run(path, next);
    return snapshot(next);
  }
  if (!job || job.snapshot.id !== args.id) throw new Error("The extraction task has changed");
  if (command === "viewer_archive_job_cancel") {
    if (archiveExtractionCanCancel(job.snapshot.phase)) job.snapshot.phase = "cancelling";
    return snapshot(job);
  }
  if (!job.snapshot.canResume) throw new Error("This extraction cannot be resumed");
  if (command === "viewer_archive_job_resume") {
    Object.assign(job.snapshot, { phase: "preparing", error: null, bytes: 0, retainedBytes: 0, canResume: false });
    void run(path, job);
    return snapshot(job);
  }
  if (command === "viewer_archive_job_discard") {
    if (job.stage) await vfsRemove(job.stage.path, true);
    jobs.delete(path);
    return;
  }
  throw new Error("Unsupported archive extraction command");
}
