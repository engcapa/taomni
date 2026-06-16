import { useEffect, useMemo, useState } from "react";
import {
  Camera,
  ExternalLink,
  PanelRight,
  Paperclip,
  Phone,
  Plus,
  Presentation,
  Video,
} from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import { openDetachedWindow } from "../../lib/detachWindowing";
import { Avatar } from "./Avatar";
import { GroupCreateDialog } from "./GroupCreateDialog";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { ProfileEditor } from "./ProfileEditor";
import { RosterList } from "./RosterList";
import { presenceLabel } from "./util";

/** Header info for the currently selected conversation. */
function useActiveHeader() {
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
  const activeConvId = useLanChatStore((s) => s.activeConvId);

  const [search, setSearch] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [showGroupCreate, setShowGroupCreate] = useState(false);
  const header = useActiveHeader();

  useEffect(() => {
    void init();
  }, [init]);

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
            </div>
            <div className="truncate text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
              {profile?.signature || "设置状态签名…"}
            </div>
          </div>
        </button>

        {/* segmented control */}
        <div className="m-2 flex rounded-lg p-0.5" style={{ background: "var(--taomni-tab-inactive)" }}>
          <SegBtn active={segment === "members"} onClick={() => setSegment("members")}>
            成员 {roster.length}
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
        </div>

        <RosterList search={search} />
      </div>

      {/* conversation column */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--taomni-bg)" }}>
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
        <MessageInput disabled={!activeConvId} />
      </div>

      {showProfile ? <ProfileEditor onClose={() => setShowProfile(false)} /> : null}
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
  const detach = () => {
    if (!convId) return;
    const title = header.label ? `${header.label} ${header.name}` : header.name;
    void openDetachedWindow({ kind: "lan-chat", sessionId: convId, title });
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
        <HeaderBtn title="发送文件（任务 02）" disabled>
          <Paperclip className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn title="截图发送（任务 02）" disabled>
          <Camera className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn title="语音通话（任务 03）" disabled>
          <Phone className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn title="视频通话（任务 03）" disabled>
          <Video className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn title="协作白板（任务 04）" disabled>
          <Presentation className="h-4 w-4" />
        </HeaderBtn>
        <span style={{ width: 1, background: "var(--taomni-divider)", margin: "4px 4px" }} />
        <HeaderBtn title="弹出为独立窗口" disabled={!isDesktop} onClick={detach}>
          <ExternalLink className="h-4 w-4" />
        </HeaderBtn>
        <HeaderBtn title="停靠到屏幕边缘（后续任务）" disabled>
          <PanelRight className="h-4 w-4" />
        </HeaderBtn>
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
