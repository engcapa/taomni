import { Camera, MoreHorizontal, Paperclip, Phone, Presentation, Trash2, Video } from "lucide-react";
import { useState } from "react";
import { pickFile } from "../../../lib/lanFilePicker";
import { useLanCallStore } from "../../../stores/lanCallStore";
import { useLanChatStore } from "../../../stores/lanChatStore";
import { useLanWbStore } from "../../../stores/lanWbStore";
import { Avatar } from "../Avatar";
import { TransferTrayButton } from "../TransferPanel";
import { useActiveHeader } from "./useActiveHeader";

export function ConversationHeader({
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

export function MenuButton({
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

export function HeaderBtn({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick?: () => void; children: React.ReactNode; }) {
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
