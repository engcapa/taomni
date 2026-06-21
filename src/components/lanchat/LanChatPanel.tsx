import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Phone,
  Plus,
  Presentation,
  Shield,
  Trash2,
  Users,
  Video,
} from "lucide-react";

import { useLanChatStore, mergedMemberPeers } from "../../stores/lanChatStore";
import { useLanCallStore } from "../../stores/lanCallStore";
import { useLanWbStore } from "../../stores/lanWbStore";
import { useAppStore } from "../../stores/appStore";
import { openDetachedWindow } from "../../lib/detachWindowing";
import { t as tr } from "../../lib/i18n";
import { pickFile } from "../../lib/lanFilePicker";
import type { LanProfile } from "../../types";
import { Avatar } from "./Avatar";
import { GroupCreateDialog } from "./GroupCreateDialog";
import { IncomingOfferModal } from "./IncomingOfferModal";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { PrivacySettings } from "./PrivacySettings";
import { ProfileEditor } from "./ProfileEditor";
import { RosterList } from "./RosterList";
import { SecurityAlertBanner } from "./SecurityAlertBanner";
import { TransferTrayButton } from "./TransferPanel";
import { presenceLabel } from "./util";

const ROSTER_WIDTH_KEY = "taomni.lanchat.rosterWidth.v1";
const ROSTER_COLLAPSED_KEY = "taomni.lanchat.rosterCollapsed.v1";
const ROSTER_DEFAULT_WIDTH = 236;
const ROSTER_MIN_WIDTH = 190;
const ROSTER_MAX_WIDTH = 360;

function clampRosterWidth(width: number): number {
  return Math.max(ROSTER_MIN_WIDTH, Math.min(ROSTER_MAX_WIDTH, Math.round(width)));
}

function loadRosterWidth(): number {
  try {
    const raw = window.localStorage.getItem(ROSTER_WIDTH_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampRosterWidth(parsed) : ROSTER_DEFAULT_WIDTH;
  } catch {
    return ROSTER_DEFAULT_WIDTH;
  }
}

function loadRosterCollapsed(): boolean {
  try {
    return window.localStorage.getItem(ROSTER_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Header info for the currently selected conversation. */
export function useActiveHeader() {
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  return useMemo(() => {
    if (!activeConvId) return null;
    if (activeConvId.startsWith("direct:")) {
      const peerId = activeConvId.slice("direct:".length);
      const peer = roster.find((p) => p.id === peerId);
      return {
        kind: "direct" as const,
        name: peer?.name ?? peerId.slice(0, 8),
        colorKey: peerId,
        status: peer?.status ?? "offline",
        sub: peer ? `${presenceLabel(peer.status)}${peer.addr ? ` · ${peer.addr}` : ""}` : "离线",
        label: undefined as string | undefined,
      };
    }
    const groupId = activeConvId.slice("group:".length);
    const group = groups.find((g) => g.id === groupId);
    return {
      kind: "group" as const,
      name: group?.name ?? "群组",
      colorKey: groupId,
      status: null,
      sub: group ? `${group.members.length} 人` : "",
      label: "#",
    };
  }, [activeConvId, roster, groups]);
}

export function LanChatPanel({ readOnly = false }: { readOnly?: boolean } = {}) {
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

  const [search, setSearch] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showGroupCreate, setShowGroupCreate] = useState(false);
  const [rosterWidth, setRosterWidth] = useState(loadRosterWidth);
  const [rosterCollapsed, setRosterCollapsed] = useState(loadRosterCollapsed);
  const header = useActiveHeader();
  const memberCount = useMemo(
    () => mergedMemberPeers(roster, conversations).length,
    [roster, conversations],
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
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = rosterWidth;
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (moveEvent: PointerEvent) => {
        setRosterWidth(clampRosterWidth(startWidth + moveEvent.clientX - startX));
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

          <RosterList search={search} />
        </div>
      )}

      {rosterCollapsed ? (
        <div style={{ width: 1, background: "var(--taomni-divider)" }} />
      ) : (
        <div
          data-testid="lanchat-roster-resize-handle"
          title="拖动调整成员栏宽度，双击恢复默认"
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

/**
 * Detach / edge-dock actions for the whole LanChat surface. These are
 * independent of any single conversation, so they live in the roster header
 * (always visible) rather than the conversation header. Detach works even with
 * no active conversation — the detached window opens its own roster.
 */
function useGlobalChatActions() {
  const isDesktop = useLanChatStore((s) => s.isDesktop);
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const openEdgeDock = useLanChatStore((s) => s.openEdgeDock);
  const removeTab = useAppStore((s) => s.removeTab);
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const header = useActiveHeader();
  const detach = useCallback(() => {
    const sessionId = activeConvId ?? "lan-chat";
    const title = header ? (header.label ? `${header.label} ${header.name}` : header.name) : "内网通讯";
    void openDetachedWindow({ kind: "lan-chat", sessionId, title })
      .then(() => removeTab("lan-chat"))
      .catch((err) => {
        setStatusMessage(
          tr("status.detachWindowError", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
  }, [activeConvId, header, removeTab, setStatusMessage]);
  return { isDesktop, detach, openEdgeDock };
}

/** Detach + dock-to-edge buttons. `orientation` adapts to the horizontal
 *  roster header ("row") or the vertical collapsed ribbon ("col"). */
function GlobalActionButtons({ orientation }: { orientation: "row" | "col" }) {
  const { isDesktop, detach, openEdgeDock } = useGlobalChatActions();
  const [dockMenu, setDockMenu] = useState(false);
  const col = orientation === "col";
  return (
    <div className={col ? "flex flex-col items-center gap-1" : "flex flex-none items-center gap-0.5"}>
      <button
        type="button"
        data-testid="lanchat-detach"
        title="弹出为独立窗口"
        disabled={!isDesktop}
        onClick={detach}
        className="grid h-7 w-7 flex-none place-items-center rounded-md disabled:opacity-40"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <ExternalLink className="h-4 w-4" />
      </button>
      <div className="relative">
        <button
          type="button"
          data-testid="lanchat-dock"
          title="停靠到窗口边缘（抽屉）"
          onClick={() => setDockMenu((v) => !v)}
          className="grid h-7 w-7 flex-none place-items-center rounded-md"
          style={{ color: "var(--taomni-text-muted)" }}
        >
          <PanelRight className="h-4 w-4" />
        </button>
        {dockMenu ? (
          <>
            <div className="fixed inset-0 z-[150]" onClick={() => setDockMenu(false)} />
            <div
              className="absolute z-[151] mt-1 w-36 rounded-lg p-1.5 text-[12px]"
              style={{
                ...(col ? { left: "100%", top: 0, marginLeft: 6 } : { right: 0 }),
                background: "var(--taomni-card-bg)",
                border: "1px solid var(--taomni-card-border)",
                boxShadow: "var(--taomni-shadow-lg)",
              }}
            >
              <div className="px-2 py-1" style={{ color: "var(--taomni-text-muted)" }}>
                停靠到窗口边缘
              </div>
              {(
                [
                  ["top", "⬆ 顶部抽屉"],
                  ["bottom", "⬇ 底部抽屉"],
                  ["left", "⬅ 左侧抽屉"],
                  ["right", "➡ 右侧抽屉"],
                ] as const
              ).map(([sideKey, label]) => (
                <button
                  key={sideKey}
                  type="button"
                  onClick={() => {
                    openEdgeDock(sideKey);
                    setDockMenu(false);
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--taomni-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left"
                  style={{ color: "var(--taomni-text)" }}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function RosterRibbon({
  profile,
  serviceRunning,
  memberCount,
  groupCount,
  onExpand,
  onOpenProfile,
  onOpenPrivacy,
  onCreateGroup,
}: {
  profile: LanProfile | null;
  serviceRunning: boolean;
  memberCount: number;
  groupCount: number;
  onExpand: () => void;
  onOpenProfile: () => void;
  onOpenPrivacy: () => void;
  onCreateGroup: () => void;
}) {
  return (
    <div
      data-testid="lanchat-roster-ribbon"
      className="flex w-[42px] flex-none flex-col items-center gap-2 py-2"
      style={{ background: "var(--taomni-panel-bg)" }}
    >
      <button
        type="button"
        data-testid="lanchat-roster-expand"
        title="展开成员栏"
        onClick={onExpand}
        className="grid h-7 w-7 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <button type="button" title="个人资料" onClick={onOpenProfile} className="grid h-8 w-8 place-items-center">
        <Avatar name={profile?.name ?? "我"} avatarBase64={profile?.avatarBase64} status={profile?.status ?? "online"} size={30} radius={8} />
      </button>
      <div className="h-px w-6" style={{ background: "var(--taomni-divider)" }} />
      <button
        type="button"
        title={`成员 ${memberCount}`}
        onClick={onExpand}
        className="grid h-7 w-7 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <Users className="h-4 w-4" />
      </button>
      <div
        className="rounded-full px-1 text-[10px] font-semibold leading-4"
        style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
      >
        {memberCount}
      </div>
      <button
        type="button"
        title={`群组 ${groupCount}`}
        onClick={onExpand}
        className="grid h-7 w-7 place-items-center rounded-md text-[12px] font-semibold"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        #
      </button>
      <button
        type="button"
        title="新建群组"
        onClick={onCreateGroup}
        className="grid h-7 w-7 place-items-center rounded-md"
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <Plus className="h-4 w-4" />
      </button>
      <div className="mt-auto flex flex-col items-center gap-1">
        <div className="h-px w-6" style={{ background: "var(--taomni-divider)" }} />
        <GlobalActionButtons orientation="col" />
        <button
          type="button"
          title="隐私与安全"
          onClick={onOpenPrivacy}
          className="grid h-7 w-7 place-items-center rounded-md"
          style={{ color: serviceRunning ? "var(--taomni-accent)" : "var(--taomni-text-muted)" }}
        >
          <Shield className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

function ConversationHeader({
  header,
  convId,
  isDesktop,
  onOpenPrivacy,
}: {
  header: NonNullable<ReturnType<typeof useActiveHeader>>;
  convId: string | null;
  isDesktop: boolean;
  onOpenPrivacy: () => void;
}) {
  const sendFilePath = useLanChatStore((s) => s.sendFilePath);
  const sendScreenshot = useLanChatStore((s) => s.sendScreenshot);
  const clearConversation = useLanChatStore((s) => s.clearConversation);
  const startCall = useLanCallStore((s) => s.startCall);
  const startMeeting = useLanCallStore((s) => s.startMeeting);
  const startBoard = useLanWbStore((s) => s.startBoard);
  const [moreMenu, setMoreMenu] = useState(false);
  const canMedia = isDesktop && header.kind === "direct";
  const canMeet = isDesktop && header.kind === "group";
  const peerId = convId && convId.startsWith("direct:") ? convId.slice("direct:".length) : null;
  const groupId = convId && convId.startsWith("group:") ? convId.slice("group:".length) : null;
  const sendFile = () => {
    void (async () => {
      const path = await pickFile();
      if (path) await sendFilePath(path).catch(() => undefined);
    })();
  };
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-2"
      style={{ borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
    >
      <Avatar name={header.name} colorKey={header.colorKey} label={header.label} status={header.status ?? undefined} size={34} radius={9} />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold">{header.name}</div>
        <div className="text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
          {header.sub}
        </div>
      </div>
      <div className="ml-auto flex gap-0.5">
        <HeaderBtn title={canMedia ? "发送文件" : "发送文件仅支持单聊"} disabled={!canMedia} onClick={sendFile}>
          <Paperclip className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn title={canMedia ? "截图发送" : "截图发送仅支持单聊"} disabled={!canMedia} onClick={() => void sendScreenshot().catch(() => undefined)}>
          <Camera className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn title={canMedia ? "语音通话" : "语音通话仅支持单聊"} disabled={!canMedia} onClick={() => peerId && void startCall(peerId, "audio")}>
          <Phone className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn
          title={canMeet ? "发起群会议" : canMedia ? "视频通话" : "视频通话/会议"}
          disabled={!canMedia && !canMeet}
          onClick={() => {
            if (canMeet && groupId) void startMeeting(groupId, "video");
            else if (peerId) void startCall(peerId, "video");
          }}
        >
          <Video className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn
          title="协作白板"
          disabled={!convId}
          onClick={() => convId && startBoard(convId, `${header.name} 的白板`)}
        >
          <Presentation className="h-4 w-4" />
        </HeaderBtn>
        <TransferTrayButton placement="bottom" />
        <span style={{ width: 1, background: "var(--taomni-divider)", margin: "4px 4px" }} />
        <div className="relative">
          <HeaderBtn title="更多" disabled={!convId} onClick={() => setMoreMenu((v) => !v)}>
            <MoreHorizontal className="h-4 w-4" />
          </HeaderBtn>
          {moreMenu ? (
            <>
              <div className="fixed inset-0 z-[150]" onClick={() => setMoreMenu(false)} />
              <div
                className="absolute right-0 z-[151] mt-1 w-44 rounded-lg p-1.5 text-[12px]"
                style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-card-border)", boxShadow: "var(--taomni-shadow-lg)" }}
              >
                <MenuButton
                  onClick={() => {
                    setMoreMenu(false);
                    onOpenPrivacy();
                  }}
                >
                  本会话保留 / 清理
                </MenuButton>
                <MenuButton
                  tone="danger"
                  onClick={() => {
                    setMoreMenu(false);
                    if (convId && window.confirm("确定清空该会话的全部消息？此操作不可撤销。")) {
                      void clearConversation(convId);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  清空会话记录
                </MenuButton>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MenuButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--taomni-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left"
      style={{ color: tone === "danger" ? "var(--busy,#ef4444)" : "var(--taomni-text)" }}
    >
      {children}
    </button>
  );
}

function HeaderBtn({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid h-7 w-7.5 place-items-center rounded-md disabled:opacity-40"
      style={{ color: "var(--taomni-text-muted)", width: 30, height: 28 }}
    >
      {children}
    </button>
  );
}
