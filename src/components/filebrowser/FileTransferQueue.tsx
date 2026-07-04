import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Trash2, X, Eraser, Pause, Play, RotateCw } from "lucide-react";
import { useTransferStore } from "../../stores/transferStore";
import { formatBytes, formatRate, formatEta, type TransferState } from "../../lib/sftp";
import { useT } from "../../lib/i18n";

interface FileTransferQueueProps {
  sessionId?: string;
  onCancel: (transferId: string) => void;
  onPause?: (transferId: string) => void;
  onResume?: (transferId: string) => void;
  onRetry?: (transferId: string) => void;
  compact?: boolean;
}

const STORAGE_KEY_PREFIX = "taomni.sftp.transferQueueHeight.";
const DEFAULT_HEIGHT = 220;
const DEFAULT_COMPACT_HEIGHT = 140;
const MIN_HEIGHT = 104;
const MIN_COMPACT_HEIGHT = 72;
const MAX_HEIGHT = 440;
const MAX_COMPACT_HEIGHT = 260;

function clampHeight(value: number, compact?: boolean): number {
  const min = compact ? MIN_COMPACT_HEIGHT : MIN_HEIGHT;
  const max = compact ? MAX_COMPACT_HEIGHT : MAX_HEIGHT;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function heightStorageKey(sessionId?: string): string {
  return `${STORAGE_KEY_PREFIX}${sessionId ?? "all"}`;
}

function loadHeight(sessionId: string | undefined, compact: boolean | undefined): number {
  const fallback = compact ? DEFAULT_COMPACT_HEIGHT : DEFAULT_HEIGHT;
  try {
    const raw = window.localStorage.getItem(heightStorageKey(sessionId));
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampHeight(parsed, compact) : fallback;
  } catch {
    return fallback;
  }
}

function saveHeight(sessionId: string | undefined, value: number): void {
  try {
    window.localStorage.setItem(heightStorageKey(sessionId), String(value));
  } catch {
    /* noop */
  }
}

export function FileTransferQueue({
  sessionId,
  onCancel,
  onPause,
  onResume,
  onRetry,
  compact,
}: FileTransferQueueProps) {
  const t = useT();
  const items = useTransferStore((s) => s.items);
  const remove = useTransferStore((s) => s.remove);
  const clearCompleted = useTransferStore((s) => s.clearCompleted);
  const [height, setHeight] = useState(() => loadHeight(sessionId, compact));

  useEffect(() => {
    setHeight(loadHeight(sessionId, compact));
  }, [compact, sessionId]);

  const updateHeight = useCallback(
    (nextHeight: number) => {
      const clamped = clampHeight(nextHeight, compact);
      setHeight(clamped);
      saveHeight(sessionId, clamped);
    },
    [compact, sessionId],
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        updateHeight(startHeight + startY - moveEvent.clientY);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
      document.addEventListener("pointercancel", onUp, { once: true });
    },
    [height, updateHeight],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      // Auto-prune dones older than 60s
      const now = Date.now();
      for (const it of useTransferStore.getState().items) {
        if (
          (it.state === "done" || it.state === "cancelled") &&
          it.finishedAt &&
          now - it.finishedAt > 60_000
        ) {
          remove(it.id);
        }
      }
    }, 5000);
    return () => window.clearInterval(id);
  }, [remove]);

  const filtered = sessionId ? items.filter((it) => it.sessionId === sessionId) : items;

  return (
    <div
      data-testid="sftp-transfer-queue"
      className="border-t flex flex-col shrink-0"
      style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-panel-bg)", height }}
    >
      <div
        data-testid="sftp-transfer-queue-resize-handle"
        className="h-1 cursor-row-resize bg-[var(--taomni-divider)] hover:bg-[var(--taomni-accent)] transition-colors"
        onPointerDown={startResize}
      />
      <div className="h-5 px-2 flex items-center text-[11px] font-semibold gap-2"
        style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
        <span>{t("fileBrowser.transferTitle")}</span>
        <span className="text-[var(--taomni-text-muted)]">{filtered.length}</span>
        <div className="flex-1" />
        <button
          type="button"
          className="px-1 py-0.5 hover:bg-[var(--taomni-hover)] rounded inline-flex items-center gap-1"
          title={t("fileBrowser.transferClearTitle")}
          onClick={clearCompleted}
        >
          <Eraser className="w-3 h-3" /> {t("fileBrowser.transferClear")}
        </button>
      </div>
      <div
        className="overflow-auto text-[11px] flex-1 min-h-0"
      >
        {filtered.length === 0 && (
          <div className="px-2 py-2 text-[var(--taomni-text-muted)]">
            {t("fileBrowser.transferEmptyText")}
          </div>
        )}
        {filtered.map((it) => {
          const pct = it.size > 0 ? Math.min(100, (it.bytes / it.size) * 100) : 0;
          const isInFlight = it.state === "running" || it.state === "queued";
          const canPause = onPause && it.state === "running";
          const canResume = onResume && it.state === "paused";
          const canRetry =
            onRetry &&
            (it.state === "error" || it.state === "cancelled") &&
            !it.localPath.startsWith("OS:");
          return (
            <div
              key={it.id}
              className="px-2 py-1 border-b"
              style={{ borderColor: "var(--taomni-divider)" }}
            >
              <div className="flex items-center gap-2 truncate">
                <span style={{ color: it.direction === "upload" ? "#3a7ac0" : "#3da064" }}>
                  {it.direction === "upload" ? "↑" : "↓"}
                </span>
                <span className="truncate flex-1">
                  {it.direction === "upload" ? it.localPath : it.remotePath}
                  {" → "}
                  {it.direction === "upload" ? it.remotePath : it.localPath}
                </span>
                <StateBadge state={it.state} />
                <span className="text-[var(--taomni-text-muted)]">
                  {formatBytes(it.bytes)} / {formatBytes(it.size)}
                </span>
                {it.state === "running" && (
                  <span className="text-[var(--taomni-text-muted)]">
                    {formatRate(it.rate)} • {formatEta(it.eta)}
                  </span>
                )}
                {canPause && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferPause")}
                    onClick={() => onPause!(it.id)}
                  >
                    <Pause className="w-3 h-3" />
                  </button>
                )}
                {canResume && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferResume")}
                    onClick={() => onResume!(it.id)}
                  >
                    <Play className="w-3 h-3" />
                  </button>
                )}
                {canRetry && (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferRetryTitle")}
                    onClick={() => onRetry!(it.id)}
                  >
                    <RotateCw className="w-3 h-3" />
                  </button>
                )}
                {isInFlight || it.state === "paused" ? (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferCancelTitle")}
                    onClick={() => onCancel(it.id)}
                  >
                    <X className="w-3 h-3" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="px-1 hover:bg-[var(--taomni-hover)] rounded"
                    title={t("fileBrowser.transferRemoveTitle")}
                    onClick={() => remove(it.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div
                className="h-0.5 mt-1 rounded"
                style={{ background: "var(--taomni-divider)" }}
              >
                <div
                  className="h-full rounded"
                  style={{
                    width: `${pct}%`,
                    background:
                      it.state === "error"
                        ? "#c0432a"
                        : it.state === "done"
                          ? "#3da064"
                          : it.state === "paused"
                            ? "#d99a2b"
                            : "var(--taomni-accent)",
                  }}
                />
              </div>
              {it.error && (
                <div className="text-[10px] mt-0.5 text-red-500 truncate">{it.error}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: TransferState }) {
  const colors: Record<TransferState, string> = {
    queued: "bg-slate-500",
    running: "bg-[var(--taomni-accent)]",
    paused: "bg-amber-500",
    done: "bg-emerald-600",
    error: "bg-red-600",
    cancelled: "bg-slate-400",
  };
  return (
    <span className={`text-white text-[10px] px-1 rounded ${colors[state]}`}>
      {state}
    </span>
  );
}
