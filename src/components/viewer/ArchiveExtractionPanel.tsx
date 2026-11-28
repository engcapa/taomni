import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  archiveExtraction,
  archiveExtractionActive,
  archiveExtractionCanCancel,
  type ArchiveExtraction,
} from "../../lib/openFile/archive";
import { formatBytes } from "../../lib/sftp";
import { useViewerLabels } from "./viewerLabels";
import type { useArchiveExtraction } from "./useArchiveExtraction";

export function ArchiveExtractionPanel({ path, extraction, fallback, focusFrom }: {
  path: string;
  extraction: ReturnType<typeof useArchiveExtraction>;
  fallback: RefObject<HTMLButtonElement | null>;
  focusFrom: RefObject<HTMLElement | null>;
}) {
  const label = useViewerLabels();
  const { job, pending, run } = extraction;
  const cancelButton = useRef<HTMLButtonElement>(null);
  const resumeButton = useRef<HTMLButtonElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const phase = job?.phase;
  useLayoutEffect(() => {
    const previous = focusFrom.current;
    if (!previous || pending) return;
    const focused = document.activeElement;
    if (focused !== previous && focused !== document.body) {
      focusFrom.current = null;
      return;
    }
    if (phase === "cancelling") return;
    const target = phase && archiveExtractionCanCancel(phase) ? cancelButton.current
      : job?.canResume ? resumeButton.current
        : previous.isConnected && !previous.matches(":disabled") ? previous
          : fallback.current?.disabled ? status.current : fallback.current;
    target?.focus();
    focusFrom.current = null;
  }, [phase, job?.canResume, pending, fallback, focusFrom]);

  if (!job) return null;
  const phases: Record<ArchiveExtraction["phase"], string> = {
    preparing: label("正在准备解压…", "Preparing extraction…"),
    extracting: label("正在解压…", "Extracting…"),
    verifying: label("正在校验文件…", "Verifying extracted files…"),
    publishing: label("正在提交解压结果…", "Publishing extracted files…"),
    cancelling: label("正在取消解压…", "Cancelling extraction…"),
    cancelled: label("解压已取消", "Extraction cancelled"),
    completed: label("已解压到", "Extracted to"),
    failed: label("解压失败", "Extraction failed"),
  };
  const title = phases[job.phase];
  const running = archiveExtractionActive(job.phase);
  const percent = job.totalBytes === null ? undefined
    : job.totalBytes === 0 ? 100 : Math.min(100, job.bytes * 100 / job.totalBytes);
  return <section className="archive-extraction" data-testid="archive-extraction" data-phase={job.phase}
    data-extraction-id={job.id} data-retained-bytes={job.retainedBytes} aria-label={label("解压任务", "Extraction task")}>
    {job.output ? <p role="status" data-testid="archive-output">{title}{" "}
      <span className="taomni-mono">{job.output}</span></p>
      : <div className="archive-extraction-status">
        <span id="archive-extraction-status" role="status" tabIndex={-1} ref={status}>{title}</span>
        <span className="taomni-mono">{job.destination}{job.member ? " · " + job.member : ""}</span>
      </div>}
    {job.error && <p role="alert" className="fv-banner warn" data-testid="archive-error">
      {job.error}{" "}{job.canResume
        ? label("可以继续或清除暂存结果。", "Resume or clear the staged files.")
        : label("检查压缩包和目标目录后重试。", "Check the archive and destination, then try again.")}
    </p>}
    {(running || job.canResume) && <>
      <progress aria-label={label("解压进度", "Extraction progress")} max={100} value={percent} data-testid="archive-extraction-progress" />
      <span className="archive-extraction-bytes" data-testid="archive-extraction-bytes">
        {formatBytes(job.bytes)}{job.totalBytes !== null ? " / " + formatBytes(job.totalBytes) : ""}
        {percent !== undefined ? " · " + Math.floor(percent) + "%" : ""}
      </span>
    </>}
    <div className="archive-extraction-actions">
      {archiveExtractionCanCancel(job.phase) && <button type="button" className="taomni-btn" ref={cancelButton}
        data-testid="archive-extraction-cancel" disabled={!!pending} aria-busy={pending === "cancel"}
        onClick={(event) => {
          focusFrom.current = event.currentTarget;
          void run("cancel", () => archiveExtraction.cancel(path, job.id));
        }}>{label("取消解压", "Cancel extraction")}</button>}
      {job.canResume && <>
        <button type="button" className="taomni-btn" data-testid="archive-extraction-discard"
          disabled={!!pending} aria-busy={pending === "discard"} onClick={(event) => {
            focusFrom.current = event.currentTarget;
            void run("discard", async () => {
              await archiveExtraction.discard(path, job.id);
              return null;
            });
          }}>{label("清除暂存文件", "Clear staged files")}</button>
        <button type="button" className="taomni-btn" data-primary="true" data-testid="archive-extraction-resume" ref={resumeButton}
          disabled={!!pending} aria-busy={pending === "resume"} onClick={(event) => {
            focusFrom.current = event.currentTarget;
            void run("resume", () => archiveExtraction.resume(path, job.id));
          }}>{label("继续解压", "Resume extraction")}</button>
      </>}
    </div>
  </section>;
}
