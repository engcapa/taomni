import { useMemo } from "react";

import { useLanChatStore, directConvId, mergedMemberPeers } from "../../stores/lanChatStore";
import type { LanConversation, LanPeer, LanPresence } from "../../types";
import { Avatar } from "./Avatar";
import { presenceLabel, shortTime } from "./util";

export type MemberStatusFilter = "active" | "all" | LanPresence;

interface RosterListProps {
  search: string;
  statusFilter?: MemberStatusFilter;
  /** Fired after a row is picked (after openDirect/openConversation). Lets the
   *  edge-drawer overlay auto-close once a conversation is selected. */
  onSelect?: () => void;
}

export function matchesMemberStatus(peer: LanPeer, filter: MemberStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return peer.status !== "offline";
  return peer.status === filter;
}

/** Left-panel list. Members segment lists discovered peers (each opens a
 *  direct chat); Groups segment lists known groups. Both show the matching
 *  conversation's last-activity time + unread badge. */
export function RosterList({ search, statusFilter = "active", onSelect }: RosterListProps) {
  const segment = useLanChatStore((s) => s.segment);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  const conversations = useLanChatStore((s) => s.conversations);
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const openConversation = useLanChatStore((s) => s.openConversation);
  const openDirect = useLanChatStore((s) => s.openDirect);

  const convById = useMemo(() => {
    const m = new Map<string, LanConversation>();
    for (const c of conversations) m.set(c.id, c);
    return m;
  }, [conversations]);

  const q = search.trim().toLowerCase();

  const memberPeers = useMemo(
    () => mergedMemberPeers(roster, conversations),
    [roster, conversations],
  );

  if (segment === "members") {
    const peers = memberPeers.filter(
      (p) => matchesMemberStatus(p, statusFilter) && (!q || p.name.toLowerCase().includes(q)),
    );
    return (
      <div className="flex-1 overflow-y-auto px-1.5 pb-2">
        <div className="px-1.5 pt-2 pb-1 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
          {statusFilter === "active" ? "在线 / 离开 / 忙碌成员" : "成员（含历史离线）"}
        </div>
        {peers.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            {statusFilter === "active" ? "暂无在线成员" : "没有匹配的成员"}
          </div>
        ) : (
          peers.map((p) => {
            const conv = convById.get(directConvId(p.id));
            const convId = directConvId(p.id);
            return (
              <Row
                key={p.id}
                active={activeConvId === convId}
                gradientKey={p.id}
                name={p.name}
                avatarBase64={null}
                status={p.status}
                preview={p.signature || presenceLabel(p.status)}
                time={conv ? shortTime(conv.lastMsgAt) : ""}
                unread={conv?.unread ?? 0}
                onClick={() => {
                  void openDirect(p.id);
                  onSelect?.();
                }}
              />
            );
          })
        )}
      </div>
    );
  }

  const list = groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  return (
    <div className="flex-1 overflow-y-auto px-1.5 pb-2">
      <div className="px-1.5 pt-2 pb-1 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
        我的群组 / 频道
      </div>
      {list.length === 0 ? (
        <div className="px-2 py-6 text-center text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
          还没有群组，点上方 + 新建
        </div>
      ) : (
        list.map((g) => {
          const convId = `group:${g.id}`;
          const conv = convById.get(convId);
          return (
            <Row
              key={g.id}
              active={activeConvId === convId}
              gradientKey={g.id}
              name={g.name}
              label="#"
              avatarBase64={null}
              status={null}
              preview={`${g.members.length} 人`}
              time={conv ? shortTime(conv.lastMsgAt) : ""}
              unread={conv?.unread ?? 0}
              onClick={() => {
                void openConversation(convId);
                onSelect?.();
              }}
            />
          );
        })
      )}
    </div>
  );
}

interface RowProps {
  active: boolean;
  gradientKey: string;
  name: string;
  label?: string;
  avatarBase64?: string | null;
  status: Parameters<typeof Avatar>[0]["status"];
  preview: string;
  time: string;
  unread: number;
  onClick: () => void;
}

function Row({ active, gradientKey, name, label, avatarBase64, status, preview, time, unread, onClick }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-px flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors"
      style={{
        background: active ? "var(--taomni-selected)" : "transparent",
        outline: active ? "1px solid var(--taomni-selected-border)" : "none",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--taomni-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      <Avatar name={name} colorKey={gradientKey} label={label} avatarBase64={avatarBase64} status={status ?? undefined} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-1.5">
          <span className="truncate font-semibold">{name}</span>
          <span className="flex-none text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
            {time}
          </span>
        </div>
        <div className="flex justify-between gap-1.5">
          <span className="truncate" style={{ color: "var(--taomni-text-muted)" }}>
            {preview}
          </span>
          {unread > 0 ? (
            <span
              className="grid h-4 min-w-4 place-items-center rounded-lg px-1 text-[10px] text-white"
              style={{ background: "var(--busy, #ef4444)" }}
            >
              {unread}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
