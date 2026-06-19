import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  ExternalLink,
  PanelRight,
  Paperclip,
  Phone,
  Plus,
  Presentation,
  Shield,
  Trash2,
  Video,
} from "lucide-react";

import { useLanChatStore, mergedMemberPeers } from "../../stores/lanChatStore";
import { useLanCallStore } from "../../stores/lanCallStore";
import { useLanWbStore } from "../../stores/lanWbStore";
import { openDetachedWindow } from "../../lib/detachWindowing";
import { pickFile } from "../../lib/lanFilePicker";
import { Avatar } from "./Avatar";
import { GroupCreateDialog } from "./GroupCreateDialog";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { PrivacySettings } from "./PrivacySettings";
import { ProfileEditor } from "./ProfileEditor";
import { RosterList } from "./RosterList";
import { SecurityAlertBanner } from "./SecurityAlertBanner";
import { TransferPanel } from "./TransferPanel";
import { presenceLabel } from "./util";

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

export function LanChatPanel() {
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

  const [search, setSearch] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showGroupCreate, setShowGroupCreate] = useState(false);
  const header = useActiveHeader();
  const memberCount = useMemo(
    () => mergedMemberPeers(roster, conversations).length,
    [roster, conversations],
  );

  useEffect(() => {
    void init();
  }, [init]);

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
      {/* roster column */}
      <div
        className="flex w-[236px] flex-none flex-col"
        style={{ borderRight: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
      >
        {/* me card */}
        <button
          type="button"
          onClick={() => setShowProfile(true)}
          className="flex items-center gap-2.5 p-2.5 text-left"
          style={{ borderBottom: "1px solid var(--taomni-divider)" }}
          title="点击修改个人资料"
        >
          <Avatar name={profile?.name ?? "我"} avatarBase64={profile?.avatarBase64} status={profile?.status ?? "online"} size={38} radius={10} />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">
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

      {/* conversation column */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--taomni-bg)" }}>
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
          <ConversationHeader header={header} convId={activeConvId} isDesktop={isDesktop} />
        ) : (
          <div
            className="flex items-center px-3"
            style={{ height: 47, borderBottom: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)", color: "var(--taomni-text-muted)" }}
          >
            内网通讯
          </div>
        )}
        <MessageThread />
        <TransferPanel />
        <MessageInput disabled={!activeConvId} />
      </div>

      {showProfile ? <ProfileEditor onClose={() => setShowProfile(false)} /> : null}
      {showPrivacy ? <PrivacySettings onClose={() => setShowPrivacy(false)} /> : null}
      {showGroupCreate ? <GroupCreateDialog onClose={() => setShowGroupCreate(false)} /> : null}
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
}: {
  header: NonNullable<ReturnType<typeof useActiveHeader>>;
  convId: string | null;
  isDesktop: boolean;
}) {
  const sendFilePath = useLanChatStore((s) => s.sendFilePath);
  const sendScreenshot = useLanChatStore((s) => s.sendScreenshot);
  const openEdgeDock = useLanChatStore((s) => s.openEdgeDock);
  const clearConversation = useLanChatStore((s) => s.clearConversation);
  const startCall = useLanCallStore((s) => s.startCall);
  const startMeeting = useLanCallStore((s) => s.startMeeting);
  const startBoard = useLanWbStore((s) => s.startBoard);
  const [dockMenu, setDockMenu] = useState(false);
  const canMedia = isDesktop && header.kind === "direct";
  const canMeet = isDesktop && header.kind === "group";
  const peerId = convId && convId.startsWith("direct:") ? convId.slice("direct:".length) : null;
  const groupId = convId && convId.startsWith("group:") ? convId.slice("group:".length) : null;
  const detach = () => {
    if (!convId) return;
    const title = header.label ? `${header.label} ${header.name}` : header.name;
    void openDetachedWindow({ kind: "lan-chat", sessionId: convId, title });
  };
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
        <HeaderBtn
          title="清空会话记录"
          disabled={!convId}
          onClick={() => {
            if (convId && window.confirm("确定清空该会话的全部消息？此操作不可撤销。")) {
              void clearConversation(convId);
            }
          }}
        >
          <Trash2 className="h-4 w-4" />
        </HeaderBtn>
        <span style={{ width: 1, background: "var(--taomni-divider)", margin: "4px 4px" }} />
        <HeaderBtn title="弹出为独立窗口" disabled={!isDesktop} onClick={detach}>
          <ExternalLink className="h-4 w-4" />
        </HeaderBtn>
        <div className="relative">
          <HeaderBtn title="停靠到窗口边缘（抽屉）" disabled={!convId} onClick={() => setDockMenu((v) => !v)}>
            <PanelRight className="h-4 w-4" />
          </HeaderBtn>
          {dockMenu ? (
            <>
              <div className="fixed inset-0 z-[150]" onClick={() => setDockMenu(false)} />
              <div
                className="absolute right-0 z-[151] mt-1 w-36 rounded-lg p-1.5 text-[12px]"
                style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-card-border)", boxShadow: "var(--taomni-shadow-lg)" }}
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
    </div>
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
