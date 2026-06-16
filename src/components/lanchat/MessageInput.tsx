import { useMemo, useRef, useState } from "react";
import { AtSign, Camera, Paperclip, Send, Smile } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import type { LanPeer } from "../../types";
import { Avatar } from "./Avatar";

interface MentionState {
  /** Caret index where the `@` token starts. */
  start: number;
  /** The partial query after `@`. */
  query: string;
}

/** Message composer with @-mention autocomplete (phase 8). Enter sends;
 *  Shift+Enter inserts a newline. While the mention popup is open, Up/Down
 *  navigate and Enter/Tab accept the highlighted member. */
export function MessageInput({ disabled }: { disabled?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [highlight, setHighlight] = useState(0);
  // node ids the user explicitly @-picked; filtered to those still present on send.
  const pickedRef = useRef<Map<string, string>>(new Map()); // name -> id
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const roster = useLanChatStore((s) => s.roster);
  const sendCurrent = useLanChatStore((s) => s.sendCurrent);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return roster.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }, [mention, roster]);

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /@([^\s@]*)$/.exec(before);
    if (m) {
      setMention({ start: caret - m[0].length, query: m[1] });
      setHighlight(0);
    } else {
      setMention(null);
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  const acceptMention = (peer: LanPeer) => {
    if (!mention) return;
    const after = text.slice(mention.start + 1 + mention.query.length);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    pickedRef.current.set(peer.name, peer.id);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => taRef.current?.focus());
  };

  const resolveMentions = (body: string): string[] => {
    const ids: string[] = [];
    for (const [name, id] of pickedRef.current) {
      if (body.includes(`@${name}`)) ids.push(id);
    }
    return Array.from(new Set(ids));
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy || disabled) return;
    setBusy(true);
    try {
      await sendCurrent(body, resolveMentions(body));
      setText("");
      pickedRef.current.clear();
    } catch {
      /* surfaced via message state */
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptMention(candidates[highlight]);
        return;
      }
      if (e.key === "Escape") {
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div
      className="relative px-2.5 py-2"
      style={{ borderTop: "1px solid var(--taomni-divider)", background: "var(--taomni-panel-bg)" }}
    >
      {mention && candidates.length > 0 ? (
        <div
          className="absolute bottom-full left-2.5 z-20 mb-1 w-56 overflow-hidden rounded-lg"
          style={{ background: "var(--taomni-card-bg)", border: "1px solid var(--taomni-card-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        >
          {candidates.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                acceptMention(p);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
              style={{ background: i === highlight ? "var(--taomni-hover)" : "transparent" }}
            >
              <Avatar name={p.name} colorKey={p.id} status={p.status} size={22} radius={6} />
              <span className="truncate text-[12px]">{p.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="mb-1.5 flex gap-0.5">
        <ToolButton title="表情（即将支持）" disabled>
          <Smile className="h-4 w-4" />
        </ToolButton>
        <ToolButton
          title="@ 提及"
          disabled={disabled}
          onClick={() => {
            setText((t) => `${t}@`);
            requestAnimationFrame(() => {
              const ta = taRef.current;
              if (ta) {
                ta.focus();
                detectMention(ta.value, ta.value.length);
              }
            });
          }}
        >
          <AtSign className="h-4 w-4" />
        </ToolButton>
        <ToolButton title="发送文件（任务 02）" disabled>
          <Paperclip className="h-4 w-4" />
        </ToolButton>
        <ToolButton title="截图（任务 02）" disabled>
          <Camera className="h-4 w-4" />
        </ToolButton>
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onClick={(e) => detectMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          placeholder={disabled ? "选择会话后输入消息…" : "输入消息，@ 提及成员，回车发送…"}
          className="h-9 flex-1 resize-none rounded-lg px-2.5 py-2 text-[12px] outline-none"
          style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-input-bg)", color: "var(--taomni-text)" }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={disabled || busy || !text.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-[12px] font-semibold text-white disabled:opacity-50"
          style={{ background: "linear-gradient(to bottom,var(--taomni-accent-soft),var(--taomni-accent))", border: "1px solid var(--taomni-accent)" }}
        >
          <Send className="h-3.5 w-3.5" />
          发送
        </button>
      </div>
    </div>
  );
}

function ToolButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid h-6 w-7 place-items-center rounded-md disabled:opacity-40"
      style={{ color: "var(--taomni-text-muted)" }}
    >
      {children}
    </button>
  );
}
