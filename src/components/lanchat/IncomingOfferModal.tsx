import { Check, Download, X } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanFileOffer } from "../../types";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Global inbound file-offer prompt. Renders every pending offer as a top-center
 *  toast regardless of which conversation is open, so a receiver is never left
 *  without a way to accept/reject (issue #154: offers used to be hidden inside
 *  the active conversation's transfer panel, and keyed by the wrong conv id). */
export function IncomingOfferModal() {
  const offers = useLanChatStore((s) => s.offers);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  const acceptOffer = useLanChatStore((s) => s.acceptOffer);
  const rejectOffer = useLanChatStore((s) => s.rejectOffer);
  const openConversation = useLanChatStore((s) => s.openConversation);

  if (offers.length === 0) return null;

  const senderName = (o: LanFileOffer): string => {
    const peer = roster.find((p) => p.id === o.from);
    const base = peer?.name ?? o.from.slice(0, 8);
    if (o.groupId) {
      const g = groups.find((x) => x.id === o.groupId);
      return `${base} · 群「${g?.name ?? o.groupId.slice(0, 6)}」`;
    }
    return base;
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-3">
      {offers.map((o) => (
        <div
          key={o.transferId}
          className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl p-3 shadow-lg"
          style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-card-border)" }}
        >
          <Download className="h-5 w-5 shrink-0" style={{ color: "var(--taomni-accent)" }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold">{o.name}</div>
            <div className="truncate text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
              {senderName(o)} · {o.kind === "dir" ? "文件夹" : "文件"} · {fmtBytes(o.size)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              void openConversation(o.convId);
              void acceptOffer(o.transferId);
            }}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold text-white"
            style={{ background: "var(--taomni-accent)" }}
          >
            <Check className="h-3.5 w-3.5" /> 接收
          </button>
          <button
            type="button"
            onClick={() => void rejectOffer(o.transferId)}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px]"
            style={{ border: "1px solid var(--taomni-input-border)", color: "var(--taomni-text-muted)" }}
          >
            <X className="h-3.5 w-3.5" /> 拒绝
          </button>
        </div>
      ))}
    </div>
  );
}
