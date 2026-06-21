import { useEffect, useMemo, useRef, useState } from "react";
import { Hash, MessageCircle, Minus, Search, Users, X } from "lucide-react";

import { useLanChatStore, type LanEdgeSide } from "../../stores/lanChatStore";
import type { LanConversation, LanGroup, LanPeer } from "../../types";
import { Avatar } from "./Avatar";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { RosterList, type MemberStatusFilter } from "./RosterList";
import { TransferTrayButton } from "./TransferPanel";
import { useActiveHeader } from "./LanChatPanel";

/** Drawer size: width when docked left/right, height when docked top/bottom. */
const DOCK_W = 380;
const DOCK_H = 340;
/** Peek-tab thickness. */
const PEEK = 28;
/** Compact roster ribbon width inside the drawer. */
const RIBBON_W = 46;

function nearestEdgeSide(clientX: number, clientY: number): LanEdgeSide {
  const width = window.innerWidth || 1;
  const height = window.innerHeight || 1;
  const distances: Array<[LanEdgeSide, number]> = [
    ["left", clientX],
    ["right", width - clientX],
    ["top", clientY],
    ["bottom", height - clientY],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

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
  const openEdgeDock = useLanChatStore((s) => s.openEdgeDock);
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
  const [statusFilter, setStatusFilter] = useState<MemberStatusFilter>("active");
  const peekDragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [peekDragPoint, setPeekDragPoint] = useState<{ x: number; y: number } | null>(null);

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
    left: { left: 0, top: "50%", transform: "translateY(-50%)", width: PEEK, height: 88, borderRadius: "0 8px 8px 0" },
    right: { right: 0, top: "50%", transform: "translateY(-50%)", width: PEEK, height: 88, borderRadius: "8px 0 0 8px" },
    top: { top: 0, left: "50%", transform: "translateX(-50%)", height: PEEK, width: 104, borderRadius: "0 0 8px 8px" },
    bottom: { bottom: 0, left: "50%", transform: "translateX(-50%)", height: PEEK, width: 104, borderRadius: "8px 8px 0 0" },
  };
  const peekDragging = peekDragPoint !== null;
  const peekVertical = side === "left" || side === "right";
  const activePeekStyle: React.CSSProperties = peekDragging
    ? {
        left: peekDragPoint!.x,
        top: peekDragPoint!.y,
        transform: "translate(-50%, -50%)",
        width: 96,
        height: PEEK,
        borderRadius: 8,
      }
    : peekStyle[side];

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

  const onPeekPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    peekDragRef.current = { x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPeekPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = peekDragRef.current;
    if (!drag) return;
    if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 6) {
      drag.moved = true;
      setPeekDragPoint({ x: event.clientX, y: event.clientY });
    }
  };
  const onPeekPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = peekDragRef.current;
    peekDragRef.current = null;
    setPeekDragPoint(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag?.moved) {
      openEdgeDock(nearestEdgeSide(event.clientX, event.clientY));
      setEdgeOpen(false);
      return;
    }
    setEdgeOpen(true);
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
              {segment === "members" ? (
                <div className="mx-2 mb-1">
                  <DrawerStatusFilter value={statusFilter} onChange={setStatusFilter} />
                </div>
              ) : null}
              <RosterList search={search} statusFilter={statusFilter} onSelect={() => setRosterOpen(false)} />
            </div>
          ) : null}

        </div>

      </div>

      <button
        type="button"
        title="点击展开内网通讯抽屉"
        aria-label="展开内网通讯抽屉，拖动可更换停靠边"
        onPointerDown={onPeekPointerDown}
        onPointerMove={onPeekPointerMove}
        onPointerUp={onPeekPointerUp}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setEdgeOpen(true);
          }
        }}
        className="select-none border-0 p-0"
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
          flexDirection: peekVertical && !peekDragging ? "column" : "row",
          fontSize: 10,
          touchAction: "none",
          ...activePeekStyle,
        }}
      >
        <MessageCircle className="h-3.5 w-3.5 flex-none" />
        <span>{peekVertical && !peekDragging ? "LAN" : "内网"}</span>
      </button>
    </>
  );
}

function DrawerStatusFilter({
  value,
  onChange,
}: {
  value: MemberStatusFilter;
  onChange: (value: MemberStatusFilter) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as MemberStatusFilter)}
      title="按状态过滤成员"
      className="h-[24px] w-full rounded-md px-2 text-[11px] outline-none"
      style={{
        border: "1px solid var(--taomni-input-border)",
        background: "var(--taomni-input-bg)",
        color: "var(--taomni-text-muted)",
      }}
    >
      <option value="active">隐藏离线</option>
      <option value="all">全部成员</option>
      <option value="online">仅在线</option>
      <option value="away">仅离开</option>
      <option value="busy">仅忙碌</option>
      <option value="offline">仅离线</option>
    </select>
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
