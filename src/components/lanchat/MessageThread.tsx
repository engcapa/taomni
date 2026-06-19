import { Fragment, useEffect, useMemo, useRef } from "react";
import { Trash2 } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanMessage } from "../../types";
import { Avatar } from "./Avatar";
import { dayLabel } from "./util";

/** Split a message body into plain text + highlighted @mentions. */
function renderBody(body: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(@[^\s@]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    parts.push(
      <span
        key={`m${key++}`}
        style={{
          color: "var(--taomni-accent)",
          background: "color-mix(in srgb, var(--taomni-accent) 14%, transparent)",
          padding: "0 3px",
          borderRadius: 4,
          fontWeight: 600,
        }}
      >
        {m[1]}
      </span>,
    );
    last = m.index + m[1].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}

function stateLabel(state: LanMessage["state"]): string {
  switch (state) {
    case "sending":
      return "发送中…";
    case "sent":
      return "已发送";
    case "delivered":
      return "已送达";
    case "failed":
      return "发送失败";
    default:
      return "";
  }
}

export function MessageThread() {
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const messagesByConv = useLanChatStore((s) => s.messagesByConv);
  const profile = useLanChatStore((s) => s.profile);
  const roster = useLanChatStore((s) => s.roster);
  const resend = useLanChatStore((s) => s.resend);
  const deleteMessage = useLanChatStore((s) => s.deleteMessage);

  const messages = activeConvId ? messagesByConv[activeConvId] ?? [] : [];
  const myId = profile?.id ?? "";

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of roster) m.set(p.id, p.name);
    if (profile) m.set(profile.id, profile.name);
    return m;
  }, [roster, profile]);

  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, activeConvId]);

  if (!activeConvId) {
    return (
      <div className="flex flex-1 items-center justify-center text-[12px]" style={{ color: "var(--taomni-text-muted)" }}>
        选择左侧成员或群组开始会话
      </div>
    );
  }

  let lastDay = "";
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      {messages.map((msg) => {
        const mine = msg.senderId === myId;
        const day = dayLabel(msg.createdAt);
        const showSep = day !== lastDay;
        lastDay = day;
        const senderName = nameById.get(msg.senderId) ?? msg.senderId.slice(0, 6);
        const mentionsMe = !mine && msg.mentions.includes(myId);
        return (
          <Fragment key={msg.id}>
            {showSep ? (
              <div
                className="self-center rounded-[10px] px-2.5 py-0.5 text-[11px]"
                style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
              >
                {day}
              </div>
            ) : null}
            <div
              className="group flex max-w-[78%] items-center gap-2.5"
              style={mine ? { alignSelf: "flex-end", flexDirection: "row-reverse" } : undefined}
            >
              <Avatar
                name={mine ? profile?.name ?? "我" : senderName}
                colorKey={msg.senderId}
                label={mine ? "我" : undefined}
                size={30}
                radius={8}
              />
              <div>
                <div
                  className="leading-relaxed"
                  style={{
                    padding: "8px 11px",
                    borderRadius: 10,
                    background: mine
                      ? "linear-gradient(135deg,var(--taomni-accent-soft),var(--taomni-accent))"
                      : "var(--taomni-card-bg)",
                    color: mine ? "#fff" : "var(--taomni-text)",
                    border: mine
                      ? "1px solid transparent"
                      : mentionsMe
                        ? "1px solid var(--taomni-accent)"
                        : "1px solid var(--taomni-card-border)",
                    boxShadow: mentionsMe
                      ? "0 0 0 2px color-mix(in srgb, var(--taomni-accent) 25%, transparent)"
                      : "var(--taomni-shadow-sm)",
                  }}
                >
                  {!mine ? (
                    <div className="mb-0.5 text-[11px]" style={{ color: "var(--taomni-text-muted)" }}>
                      {senderName}
                    </div>
                  ) : null}
                  <div className="whitespace-pre-wrap break-words">{renderBody(msg.body)}</div>
                </div>
                {mine ? (
                  <div
                    className="mt-0.5 flex items-center gap-2 text-[10px]"
                    style={{ color: msg.state === "failed" ? "var(--busy,#ef4444)" : "var(--taomni-text-muted)", justifyContent: "flex-end" }}
                  >
                    <span>{stateLabel(msg.state)}</span>
                    {msg.state === "failed" ? (
                      <button
                        type="button"
                        className="underline"
                        onClick={() => void resend(msg.id)}
                        style={{ color: "var(--taomni-link)" }}
                      >
                        重试
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                title="删除此消息"
                onClick={() => activeConvId && void deleteMessage(activeConvId, msg.id)}
                className="opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: "var(--taomni-text-muted)" }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
