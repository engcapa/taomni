import { Check, Download, FolderOpen, Pause, Play, X } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanTransferProgress } from "../../types";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function stateText(t: LanTransferProgress): string {
  const pct = t.size > 0 ? Math.floor((t.transferred / t.size) * 100) : 0;
  switch (t.state) {
    case "offering":
      return "等待对方接收…";
    case "active":
      return `${pct}% · ${fmtBytes(t.rate)}/s`;
    case "paused":
      return `已暂停 · ${pct}%`;
    case "done":
      return "完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "rejected":
      return "对方已拒绝";
    default:
      return t.state;
  }
}

/** Transfers + pending offers for the active conversation, shown above the
 *  composer (the prototype's transfer queue / file cards). */
export function TransferPanel() {
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const transfers = useLanChatStore((s) => s.transfers);
  const offers = useLanChatStore((s) => s.offers);
  const acceptOffer = useLanChatStore((s) => s.acceptOffer);
  const rejectOffer = useLanChatStore((s) => s.rejectOffer);
  const transferControl = useLanChatStore((s) => s.transferControl);
  const openTransfer = useLanChatStore((s) => s.openTransfer);

  if (!activeConvId) return null;

  const convOffers = offers.filter((o) => o.convId === activeConvId);
  const convTransfers = Object.values(transfers)
    .filter((t) => t.convId === activeConvId && t.state !== "rejected")
    .sort((a, b) => a.transferId.localeCompare(b.transferId));

  if (convOffers.length === 0 && convTransfers.length === 0) return null;

  return (
    <div
      className="max-h-44 overflow-y-auto px-2.5 py-2"
      style={{ borderTop: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
    >
      {convOffers.map((o) => (
        <div
          key={o.transferId}
          className="mb-1.5 flex items-center gap-2 rounded-lg p-2"
          style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-card-border)" }}
        >
          <Download className="h-4 w-4" style={{ color: "var(--taomni-accent)" }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-semibold">{o.name}</div>
            <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
              {o.kind === "dir" ? "文件夹" : "文件"} · {fmtBytes(o.size)} · 来件
            </div>
          </div>
          <button
            type="button"
            title="接收"
            onClick={() => void acceptOffer(o.transferId)}
            className="grid h-7 w-7 place-items-center rounded-md text-white"
            style={{ background: "var(--taomni-accent)" }}
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="拒绝"
            onClick={() => void rejectOffer(o.transferId)}
            className="grid h-7 w-7 place-items-center rounded-md"
            style={{ border: "1px solid var(--taomni-input-border)", color: "var(--taomni-text-muted)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}

      {convTransfers.map((t) => {
        const pct = t.size > 0 ? Math.min(100, Math.floor((t.transferred / t.size) * 100)) : 0;
        const active = t.state === "active" || t.state === "offering";
        const paused = t.state === "paused";
        return (
          <div
            key={t.transferId}
            className="mb-1.5 rounded-lg p-2"
            style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-card-border)" }}
          >
            <div className="flex items-center gap-2">
              <span className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
                {t.direction === "send" ? "↑" : "↓"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold">{t.name}</div>
                <div className="text-[11px]" style={{ color: t.state === "failed" ? "var(--busy,#ef4444)" : "var(--taomni-text-muted)" }}>
                  {fmtBytes(t.size)} · {stateText(t)}
                </div>
              </div>
              {(active || paused) && (
                <button
                  type="button"
                  title={paused ? "继续" : "暂停"}
                  onClick={() => void transferControl(t.transferId, paused ? "resume" : "pause")}
                  className="grid h-6 w-6 place-items-center rounded-md"
                  style={{ color: "var(--taomni-text-muted)" }}
                >
                  {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                </button>
              )}
              {(active || paused) && (
                <button
                  type="button"
                  title="取消"
                  onClick={() => void transferControl(t.transferId, "cancel")}
                  className="grid h-6 w-6 place-items-center rounded-md"
                  style={{ color: "var(--taomni-text-muted)" }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              {t.state === "done" && (
                <button
                  type="button"
                  title="打开"
                  onClick={() => void openTransfer(t.transferId)}
                  className="grid h-6 w-6 place-items-center rounded-md"
                  style={{ color: "var(--taomni-accent)" }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded" style={{ background: "var(--taomni-divider)" }}>
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: t.state === "failed" ? "var(--busy,#ef4444)" : "linear-gradient(90deg,var(--taomni-accent-soft),var(--taomni-accent))",
                  transition: "width .2s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
