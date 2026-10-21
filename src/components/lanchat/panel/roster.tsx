import { ChevronRight, Plus, Shield, Users } from "lucide-react";
import { useRef, useState } from "react";
import { type LanEdgeSide } from "../../../stores/lanChatStore";
import type { LanProfile } from "../../../types";
import { Avatar } from "../Avatar";
import { type MemberStatusFilter } from "../RosterList";
import { GlobalActionButtons } from "./globalActions";
import { isInteractiveTarget, nearestWindowEdge } from "./rosterPreferences";

export function RosterRibbon({
  profile,
  serviceRunning,
  memberCount,
  groupCount,
  onExpand,
  onOpenProfile,
  onOpenPrivacy,
  onCreateGroup,
  onDock,
}: {
  profile: LanProfile | null;
  serviceRunning: boolean;
  memberCount: number;
  groupCount: number;
  onExpand: () => void;
  onOpenProfile: () => void;
  onOpenPrivacy: () => void;
  onCreateGroup: () => void;
  onDock: (side: LanEdgeSide) => void;
}) {
  const dragRef = useRef<{ x: number; y: number; moved: boolean; } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (isInteractiveTarget(event.target)) return;
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 8) {
      drag.moved = true;
      setDragging(true);
    }
  };
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (!drag?.moved) return;
    suppressClickRef.current = true;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    onDock(nearestWindowEdge(event.clientX, event.clientY));
  };

  return (
    <div
      data-testid="lanchat-roster-ribbon"
      className="flex w-[34px] flex-none flex-col items-center gap-1.5 py-1.5"
      title="拖动到窗口边缘停靠"
      style={{
        background: "var(--taomni-panel-bg)",
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        data-testid="lanchat-roster-expand"
        title="展开成员栏"
        onClick={onExpand}
        className="grid h-6 w-6 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <button type="button" title="个人资料" onClick={onOpenProfile} className="grid h-7 w-7 place-items-center">
        <Avatar name={profile?.name ?? "我"} avatarBase64={profile?.avatarBase64} status={profile?.status ?? "online"} size={26} radius={7} />
      </button>
      <div className="h-px w-5" style={{ background: "var(--taomni-divider)" }} />
      <button
        type="button"
        title={`成员 ${memberCount}`}
        onClick={onExpand}
        className="grid h-6 w-6 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <Users className="h-3.5 w-3.5" />
      </button>
      <div
        className="rounded-full px-1 text-[9px] font-semibold leading-3.5"
        style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
      >
        {memberCount}
      </div>
      <button
        type="button"
        title={`群组 ${groupCount}`}
        onClick={onExpand}
        className="grid h-6 w-6 place-items-center rounded-md text-[11px] font-semibold"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        #
      </button>
      <button
        type="button"
        title="新建群组"
        onClick={onCreateGroup}
        className="grid h-6 w-6 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <div className="mt-auto flex flex-col items-center gap-1">
        <div className="h-px w-5" style={{ background: "var(--taomni-divider)" }} />
        <GlobalActionButtons orientation="col" />
        <button
          type="button"
          title="隐私与安全"
          onClick={onOpenPrivacy}
          className="grid h-6 w-6 place-items-center rounded-md"
          style={{ color: serviceRunning ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
        >
          <Shield className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode; }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 rounded-md py-1 text-[12px]"
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

export function StatusFilterSelect({
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
      className="h-[24px] min-w-0 flex-1 rounded-md px-2 text-[11px] outline-none"
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
