import { ChevronLeft, Plus, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { mergedMemberPeers, useLanChatStore } from "../../stores/lanChatStore";
import { Avatar } from "./Avatar";
import { GroupCreateDialog } from "./GroupCreateDialog";
import { IncomingOfferModal } from "./IncomingOfferModal";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { PrivacySettings } from "./PrivacySettings";
import { ProfileEditor } from "./ProfileEditor";
import { RosterList, matchesMemberStatus, type MemberStatusFilter } from "./RosterList";
import { SecurityAlertBanner } from "./SecurityAlertBanner";
import { GlobalActionButtons } from "./panel/globalActions";
import { ConversationHeader } from "./panel/header";
import { RosterRibbon, SegBtn, StatusFilterSelect } from "./panel/roster";
import {
  ROSTER_COLLAPSED_KEY,
  ROSTER_COLLAPSE_WIDTH,
  ROSTER_DEFAULT_WIDTH,
  ROSTER_MAX_WIDTH,
  ROSTER_MIN_WIDTH,
  ROSTER_WIDTH_KEY,
  clampRosterWidth,
  loadRosterCollapsed,
  loadRosterWidth,
} from "./panel/rosterPreferences";
import { useActiveHeader } from "./panel/useActiveHeader";

export function LanChatPanel({ readOnly = false }: { readOnly?: boolean; } = {}) {
  const init = useLanChatStore((s) => s.init);
  const isDesktop = useLanChatStore((s) => s.isDesktop);
  const profile = useLanChatStore((s) => s.profile);
  const segment = useLanChatStore((s) => s.segment);
  const setSegment = useLanChatStore((s) => s.setSegment);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  const conversations = useLanChatStore((s) => s.conversations);
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const serviceRunning = useLanChatStore((s) => s.serviceRunning);
  const enableService = useLanChatStore((s) => s.enableService);
  const openEdgeDock = useLanChatStore((s) => s.openEdgeDock);

  const [search, setSearch] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showGroupCreate, setShowGroupCreate] = useState(false);
  const [memberStatusFilter, setMemberStatusFilter] = useState<MemberStatusFilter>("active");
  const [rosterWidth, setRosterWidth] = useState(loadRosterWidth);
  const [rosterCollapsed, setRosterCollapsed] = useState(loadRosterCollapsed);
  const header = useActiveHeader();
  const memberCount = useMemo(
    () =>
      mergedMemberPeers(roster, conversations).filter((peer) =>
        matchesMemberStatus(peer, memberStatusFilter),
      ).length,
    [roster, conversations, memberStatusFilter],
  );

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ROSTER_WIDTH_KEY, String(rosterWidth));
    } catch {
      /* ignore */
    }
  }, [rosterWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ROSTER_COLLAPSED_KEY, rosterCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [rosterCollapsed]);

  const startRosterResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (rosterCollapsed) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = rosterWidth;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = startWidth + moveEvent.clientX - startX;
        if (nextWidth <= ROSTER_COLLAPSE_WIDTH) {
          setRosterCollapsed(true);
          return;
        }
        setRosterCollapsed(false);
        setRosterWidth(clampRosterWidth(nextWidth));
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    },
    [rosterCollapsed, rosterWidth],
  );

  const startRosterExpandResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!rosterCollapsed) return;
      if (event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = Math.max(rosterWidth, ROSTER_MIN_WIDTH);
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        const nextWidth = startWidth + moveEvent.clientX - startX;
        if (nextWidth <= ROSTER_COLLAPSE_WIDTH) return;
        setRosterCollapsed(false);
        setRosterWidth(clampRosterWidth(nextWidth));
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp, { once: true });
    },
    [rosterCollapsed, rosterWidth],
  );

  // Desktop drag-and-drop: dropping files while a direct chat is open sends them.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const store = useLanChatStore.getState();
          if (!store.activePeerId()) return;
          for (const path of event.payload.paths) {
            void store.sendFilePath(path).catch(() => undefined);
          }
        });
        if (disposed) un();
        else unlisten = un;
      } catch {
        /* drag-drop unavailable */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDesktop]);

  return (
    <div className="flex h-full min-w-0" style={{ background: "var(--taomni-bg)" }}>
      {rosterCollapsed ? (
        <RosterRibbon
          profile={profile}
          serviceRunning={serviceRunning}
          memberCount={memberCount}
          groupCount={groups.length}
          onExpand={() => setRosterCollapsed(false)}
          onOpenProfile={() => setShowProfile(true)}
          onOpenPrivacy={() => setShowPrivacy(true)}
          onCreateGroup={() => setShowGroupCreate(true)}
          onDock={openEdgeDock}
        />
      ) : (
        <div
          data-testid="lanchat-roster-panel"
          className="flex flex-none flex-col"
          style={{ width: rosterWidth, background: "var(--taomni-panel-bg)" }}
        >
          {/* me card */}
          <div
            className="flex items-center gap-1.5 p-2.5"
            style={{ borderBottom: "1px solid var(--taomni-divider)" }}
          >
            <button
              type="button"
              onClick={() => setShowProfile(true)}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              title="点击修改个人资料"
            >
              <Avatar name={profile?.name ?? "我"} avatarBase64={profile?.avatarBase64} status={profile?.status ?? "online"} size={38} radius={10} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold">
                  {profile?.name ?? "我"}
                  <span style={{ color: "var(--taomni-text-muted)", fontWeight: 400 }}> · 本机</span>
                  <span
                    className="ml-1.5 text-[11px] font-normal"
                    style={{ color: serviceRunning ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
                    title={serviceRunning ? "正在局域网监听 / 广播" : "未开启监听 / 广播"}
                  >
                    {serviceRunning ? "● 在线" : "○ 未开启"}
                  </span>
                </div>
                <div className="truncate text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
                  {profile?.signature || "设置状态签名…"}
                </div>
              </div>
            </button>
            <GlobalActionButtons orientation="row" />
            <button
              type="button"
              data-testid="lanchat-roster-collapse"
              title="收起成员栏"
              onClick={() => setRosterCollapsed(true)}
              className="grid h-7 w-7 flex-none place-items-center rounded-md"
              style={{ color: "var(--taomni-text-muted)" }}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>

          {/* segmented control */}
          <div className="m-2 flex rounded-lg p-0.5" style={{ background: "var(--taomni-tab-inactive)" }}>
            <SegBtn active={segment === "members"} onClick={() => setSegment("members")}>
              成员 {memberCount}
            </SegBtn>
            <SegBtn active={segment === "groups"} onClick={() => setSegment("groups")}>
              群组 {groups.length}
            </SegBtn>
          </div>

          {/* search + new group */}
          <div className="mx-2 mb-2 flex items-center gap-1.5">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索成员 / 群组…"
              className="h-6.5 min-w-0 flex-1 rounded-md px-2.5 text-[12px] outline-none"
              style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-input-bg)", color: "var(--taomni-text)", height: 26 }}
            />
            <button
              type="button"
              title="新建群组"
              onClick={() => setShowGroupCreate(true)}
              className="grid h-6.5 w-6.5 place-items-center rounded-md"
              style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)", color: "var(--taomni-text-muted)", height: 26, width: 26 }}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="隐私与安全"
              onClick={() => setShowPrivacy(true)}
              className="grid h-6.5 w-6.5 place-items-center rounded-md"
              style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-card-bg)", color: "var(--taomni-text-muted)", height: 26, width: 26 }}
            >
              <Shield className="h-3.5 w-3.5" />
            </button>
          </div>
          {segment === "members" ? (
            <div className="mx-2 mb-1 flex items-center gap-1.5">
              <StatusFilterSelect value={memberStatusFilter} onChange={setMemberStatusFilter} />
            </div>
          ) : null}

          <RosterList search={search} statusFilter={memberStatusFilter} />
        </div>
      )}

      {rosterCollapsed ? (
        <div
          data-testid="lanchat-roster-expand-resize-handle"
          title="拖动展开成员栏"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startRosterExpandResize}
          onDoubleClick={() => setRosterCollapsed(false)}
          className="group relative w-1.5 flex-none cursor-col-resize"
          style={{ background: "transparent" }}
        >
          <div
            className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:w-1"
            style={{ background: "var(--taomni-divider)" }}
          />
        </div>
      ) : (
        <div
          data-testid="lanchat-roster-resize-handle"
          title="拖动调整成员栏宽度，拖到最左收起为 ribbon，双击恢复默认"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={ROSTER_MIN_WIDTH}
          aria-valuemax={ROSTER_MAX_WIDTH}
          aria-valuenow={rosterWidth}
          onPointerDown={startRosterResize}
          onDoubleClick={() => setRosterWidth(ROSTER_DEFAULT_WIDTH)}
          className="group relative w-1.5 flex-none cursor-col-resize"
          style={{ background: "transparent" }}
        >
          <div
            className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:w-1"
            style={{ background: "var(--taomni-divider)" }}
          />
        </div>
      )}

      {/* conversation column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: "var(--taomni-bg)" }}>
        <SecurityAlertBanner />
        {!isDesktop ? (
          <div
            className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
            style={{ background: "color-mix(in srgb, var(--warn,#f59e0b) 16%, transparent)", borderBottom: "1px solid var(--warn,#f59e0b)" }}
          >
            浏览器预览不支持真实发现 / 直连，以下为占位数据；请使用桌面版体验内网通讯。
          </div>
        ) : null}
        {header ? (
          <ConversationHeader
            header={header}
            convId={activeConvId}
            isDesktop={isDesktop}
            onOpenPrivacy={() => setShowPrivacy(true)}
          />
        ) : (
          <div
            className="flex items-center px-3"
            style={{ height: 47, borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)", color: "var(--taomni-text-muted)" }}
          >
            内网通讯
          </div>
        )}
        {readOnly && !serviceRunning ? (
          <div
            className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
            style={{ background: "color-mix(in srgb, var(--taomni-accent) 14%, transparent)", borderBottom: "1px solid var(--taomni-accent)" }}
          >
            <span style={{ color: "var(--taomni-text-muted)" }}>
              局域网聊天未开启,仅可查看历史记录。
            </span>
            <button
              type="button"
              onClick={() => void enableService()}
              className="ml-auto rounded-md px-2 py-0.5 text-[11px] font-semibold text-white"
              style={{ background: "var(--taomni-accent)" }}
            >
              开启聊天
            </button>
          </div>
        ) : null}
        <MessageThread />
        <MessageInput disabled={!activeConvId || (readOnly && !serviceRunning)} />
      </div>

      {showProfile ? <ProfileEditor onClose={() => setShowProfile(false)} /> : null}
      {showPrivacy ? <PrivacySettings onClose={() => setShowPrivacy(false)} /> : null}
      {showGroupCreate ? <GroupCreateDialog onClose={() => setShowGroupCreate(false)} /> : null}
      <IncomingOfferModal />
    </div>
  );
}

export { useActiveHeader } from "./panel/useActiveHeader";
