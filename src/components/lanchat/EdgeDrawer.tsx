import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, Minus, Search, Users, X } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanConversation, LanGroup, LanPeer } from "../../types";
import { Avatar } from "./Avatar";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { RosterList } from "./RosterList";
import { TransferTrayButton } from "./TransferPanel";
import { useActiveHeader } from "./LanChatPanel";

/** Drawer size: width when docked left/right, height when docked top/bottom. */
const DOCK_W = 380;
const DOCK_H = 340;
/** Peek-tab thickness. */
const PEEK = 34;
/** Compact roster ribbon width inside the drawer. */
const RIBBON_W = 46;

/** Resolve a conversation to display fields for the quick-switch ribbon. */
function convDisplay(conv: LanConversation, roster: LanPeer[], groups: LanGroup[]) {
  if (conv.kind === "direct") {
    const peer = roster.find((p) => p.id === conv.peerOrGroupId);
    return {
      name: peer?.name ?? conv.peerOrGroupId.slice(0, 6),
      colorKey: conv.peerOrGroupId,
      status: peer?.status ?? null,
      label: undefined as string | undefined,
    };
  }
  const g = groups.find((x) => x.id === conv.peerOrGroupId);
  return { name: g?.name ?? "群组", colorKey: conv.peerOrGroupId, status: null, label: "#" };
}

/**
 * In-app edge drawer (QQ style): docks LanChat to a window edge as a sliding
 * panel. Carries the full surface — a compact roster ribbon for quick
 * conversation switching (expandable to the full member/group list as an
 * overlay) plus the conversation thread + composer. Auto-collapses to a "peek"
 * tab when the pointer leaves; the close button undocks and restores the
 * main-window tab (handled by MainLayout's edgeDock effect).
 */
export function EdgeDrawer() {
  const side = useLanChatStore((s) => s.edgeDock);
  const open = useLanChatStore((s) => s.edgeOpen);
  const setEdgeOpen = useLanChatStore((s) => s.setEdgeOpen);
  const closeEdgeDock = useLanChatStore((s) => s.closeEdgeDock);
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const profile = useLanChatStore((s) => s.profile);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  const conversations = useLanChatStore((s) => s.conversations);
  const openConversation = useLanChatStore((s) => s.openConversation);
  const segment = useLanChatStore((s) => s.segment);
  const setSegment = useLanChatStore((s) => s.setSegment);
  const header = useActiveHeader();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [search, setSearch] = useState("");

  // Esc closes the roster overlay first, then undocks (MainLayout restores tab).
  useEffect(() => {
    if (!side) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (rosterOpen) setRosterOpen(false);
      else closeEdgeDock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [side, rosterOpen, closeEdgeDock]);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const recent = useMemo(
    () => [...conversations].sort((a, b) => b.lastMsgAt - a.lastMsgAt).slice(0, 8),
    [conversations],
  );

  if (!side) return null;

  const hideTransform = {
    left: "translateX(-100%)",
    right: "translateX(100%)",
    top: "translateY(-100%)",
    bottom: "translateY(100%)",
  }[side];

  const edgeStyle: Record<typeof side, React.CSSProperties> = {
    left: { left: 0, top: 0, bottom: 0, width: DOCK_W, borderRight: "1px solid var(--taomni-chrome-border)" },
    right: { right: 0, top: 0, bottom: 0, width: DOCK_W, borderLeft: "1px solid var(--taomni-chrome-border)" },
    top: { left: 0, right: 0, top: 0, height: DOCK_H, borderBottom: "1px solid var(--taomni-chrome-border)" },
    bottom: { left: 0, right: 0, bottom: 0, height: DOCK_H, borderTop: "1px solid var(--taomni-chrome-border)" },
  };

  const peekStyle: Record<typeof side, React.CSSProperties> = {
    left: { left: 0, top: "50%", transform: "translateY(-50%)", writingMode: "vertical-rl", width: PEEK, height: 120, borderRadius: "0 10px 10px 0" },
    right: { right: 0, top: "50%", transform: "translateY(-50%)", writingMode: "vertical-rl", width: PEEK, height: 120, borderRadius: "10px 0 0 10px" },
    top: { top: 0, left: "50%", transform: "translateX(-50%)", height: PEEK, width: 150, borderRadius: "0 0 10px 10px" },
    bottom: { bottom: 0, left: "50%", transform: "translateX(-50%)", height: PEEK, width: 150, borderRadius: "10px 10px 0 0" },
  };

  // Auto-hide on pointer leave (QQ behaviour); cancel if the pointer returns.
  const onLeave = () => {
    if (rosterOpen) return; // don't auto-collapse while picking a conversation
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setEdgeOpen(false), 900);
  };
  const onEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };

  const openRoster = (seg: "members" | "groups") => {
    setSegment(seg);
    setRosterOpen(true);
  };

  return (
    <>
      <div
        onMouseLeave={onLeave}
        onMouseEnter={onEnter}
        style={{
          position: "fixed",
          zIndex: 160,
          display: "flex",
          flexDirection: "column",
          background: "var(--taomni-panel-bg)",
          boxShadow: "var(--taomni-shadow-lg)",
          transition: "transform .28s cubic-bezier(.4,0,.2,1)",
          transform: open ? "none" : hideTransform,
          ...edgeStyle[side],
        }}
      >
        {/* slim header strip ("袖珍" ribbon) */}
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 text-[13px] font-semibold"
          style={{
            background: "linear-gradient(to bottom,var(--taomni-titlebar-from),var(--taomni-titlebar-to))",
            borderBottom: "1px solid var(--taomni-chrome-border)",
          }}
        >
          {header ? (
            <Avatar name={header.name} colorKey={header.colorKey} label={header.label} status={header.status ?? undefined} size={20} radius={6} />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{header?.name ?? "内网通讯"}</span>
          <span className="flex-none text-[11px] font-normal" style={{ color: "var(--taomni-text-muted)" }}>
            边缘抽屉
          </span>
          <TransferTrayButton placement="bottom" />
          <button
            type="button"
            data-testid="lanchat-drawer-peek"
            onClick={() => setEdgeOpen(false)}
            title="收起到边缘（鼠标移出自动收起，点边缘标签恢复）"
            className="grid h-6 w-6 flex-none place-items-center rounded-md"
            style={{ color: "var(--taomni-text-muted)" }}
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-testid="lanchat-drawer-close"
            onClick={() => closeEdgeDock()}
            title="关闭抽屉，恢复到主窗口标签页"
            className="grid h-6 w-6 flex-none place-items-center rounded-md"
            style={{ color: "var(--taomni-text-muted)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* body: compact roster ribbon + conversation, roster overlay on top */}
        <div className="relative flex min-h-0 flex-1">
          <div
            data-testid="lanchat-drawer-ribbon"
            className="flex flex-none flex-col items-center gap-1.5 py-2"
            style={{ width: RIBBON_W, borderRight: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
          >
            <button type="button" title="成员列表" onClick={() => openRoster("members")} className="grid h-8 w-8 flex-none place-items-center">
              <Avatar name={profile?.name ?? "我"} avatarBase64={profile?.avatarBase64} status={profile?.status ?? "online"} size={30} radius={8} />
            </button>
            <button type="button" title="成员" onClick={() => openRoster("members")} className="grid h-7 w-7 flex-none place-items-center rounded-md" style={{ color: "var(--taomni-text-muted)" }}>
              <Users className="h-4 w-4" />
            </button>
            <button type="button" title="群组" onClick={() => openRoster("groups")} className="grid h-7 w-7 flex-none place-items-center rounded-md" style={{ color: "var(--taomni-text-muted)" }}>
              <Hash className="h-4 w-4" />
            </button>
            <div className="h-px w-6 flex-none" style={{ background: "var(--taomni-divider)" }} />
            <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto">
              {recent.map((conv) => {
                const d = convDisplay(conv, roster, groups);
                const active = conv.id === activeConvId;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    title={d.name}
                    onClick={() => void openConversation(conv.id)}
                    className="relative grid h-8 w-8 flex-none place-items-center rounded-lg"
                    style={{ outline: active ? "2px solid var(--taomni-accent)" : "none" }}
                  >
                    <Avatar name={d.name} colorKey={d.colorKey} label={d.label} status={d.status ?? undefined} size={30} radius={8} />
                    {conv.unread > 0 ? (
                      <span
                        className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full px-0.5 text-[9px] text-white"
                        style={{ background: "var(--busy,#ef4444)" }}
                      >
                        {conv.unread}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: "var(--taomni-bg)" }}>
            <MessageThread />
            <MessageInput disabled={!activeConvId} />
          </div>

          {rosterOpen ? (
            <div
              data-testid="lanchat-drawer-roster-overlay"
              className="absolute inset-0 z-[5] flex flex-col"
              style={{ background: "var(--taomni-panel-bg)" }}
            >
              <div className="flex items-center gap-1.5 p-2" style={{ borderBottom: "1px solid var(--taomni-divider)" }}>
                <div className="flex flex-1 rounded-lg p-0.5" style={{ background: "var(--taomni-tab-inactive)" }}>
                  <DrawerSegBtn active={segment === "members"} onClick={() => setSegment("members")}>
                    <Users className="h-3.5 w-3.5" />
                    成员
                  </DrawerSegBtn>
                  <DrawerSegBtn active={segment === "groups"} onClick={() => setSegment("groups")}>
                    <Hash className="h-3.5 w-3.5" />
                    群组
                  </DrawerSegBtn>
                </div>
                <button
                  type="button"
                  onClick={() => setRosterOpen(false)}
                  title="关闭列表"
                  className="grid h-6 w-6 flex-none place-items-center rounded-md"
                  style={{ color: "var(--taomni-text-muted)" }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mx-2 my-2 flex items-center gap-1.5">
                <Search className="h-3.5 w-3.5 flex-none" style={{ color: "var(--taomni-text-muted)" }} />
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索成员 / 群组…"
                  className="h-[26px] min-w-0 flex-1 rounded-md px-2.5 text-[12px] outline-none"
                  style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-input-bg)", color: "var(--taomni-text)" }}
                />
              </div>
              <RosterList search={search} onSelect={() => setRosterOpen(false)} />
            </div>
          ) : null}

        </div>

      </div>

      <div
        onClick={() => setEdgeOpen(true)}
        title="点击展开内网通讯抽屉"
        style={{
          position: "fixed",
          zIndex: 161,
          cursor: "pointer",
          userSelect: "none",
          display: open ? "none" : "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          color: "#fff",
          fontWeight: 600,
          background: "linear-gradient(135deg,var(--taomni-accent-soft),var(--taomni-accent))",
          boxShadow: "var(--taomni-shadow-md)",
          ...peekStyle[side],
        }}
      >
        💬 内网通讯
      </div>
    </>
  );
}

function DrawerSegBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md py-1 text-[12px]"
      style={{
        background: active ? "var(--taomni-card-bg)" : "transparent",
        color: active ? "var(--taomni-text)" : "var(--taomni-text-muted)",
        fontWeight: active ? 600 : 400,
        boxShadow: active ? "var(--taomni-shadow-sm)" : "none",
      }}
    >
      {children}
    </button>
  );
}
