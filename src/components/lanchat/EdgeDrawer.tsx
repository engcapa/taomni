import { useEffect, useRef } from "react";
import { Minus } from "lucide-react";

import { useLanChatStore } from "../../stores/lanChatStore";
import { Avatar } from "./Avatar";
import { MessageInput } from "./MessageInput";
import { MessageThread } from "./MessageThread";
import { useActiveHeader } from "./LanChatPanel";

/** Drawer size: width when docked left/right, height when docked top/bottom. */
const DOCK_W = 360;
const DOCK_H = 320;
/** Peek-tab thickness. */
const PEEK = 34;

/**
 * In-app edge drawer (QQ style): docks the active conversation to a window
 * edge as a sliding panel, auto-collapses to a "peek" tab when the pointer
 * leaves, and reopens on tab click. Mounted once at the app root so it overlays
 * the whole window and survives tab switches.
 *
 * This is an in-app CSS overlay — it docks to the Taomni window, not the OS
 * screen (an OS-level always-on-top docked window was the deferred high-fidelity
 * alternative).
 */
export function EdgeDrawer() {
  const side = useLanChatStore((s) => s.edgeDock);
  const open = useLanChatStore((s) => s.edgeOpen);
  const setEdgeOpen = useLanChatStore((s) => s.setEdgeOpen);
  const closeEdgeDock = useLanChatStore((s) => s.closeEdgeDock);
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const header = useActiveHeader();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Esc undocks the drawer entirely.
  useEffect(() => {
    if (!side) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeEdgeDock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [side, closeEdgeDock]);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
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
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setEdgeOpen(false), 900);
  };
  const onEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
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
        <div
          className="flex items-center gap-2 px-3 py-2 text-[13px] font-semibold"
          style={{
            background: "linear-gradient(to bottom,var(--taomni-titlebar-from),var(--taomni-titlebar-to))",
            borderBottom: "1px solid var(--taomni-chrome-border)",
          }}
        >
          {header ? (
            <Avatar name={header.name} colorKey={header.colorKey} label={header.label} status={header.status ?? undefined} size={22} radius={6} />
          ) : null}
          <span className="truncate">{header?.name ?? "内网通讯"}</span>
          <span className="text-[11px] font-normal" style={{ color: "var(--taomni-text-muted)" }}>
            · 边缘抽屉
          </span>
          <button
            type="button"
            onClick={() => setEdgeOpen(false)}
            onContextMenu={(e) => {
              e.preventDefault();
              closeEdgeDock();
            }}
            title="收起到边缘（鼠标移出自动收起，点边缘标签恢复；右键彻底关闭）"
            className="ml-auto grid h-6 w-6 place-items-center rounded-md"
            style={{ color: "var(--taomni-text-muted)" }}
          >
            <Minus className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageThread />
          <MessageInput disabled={!activeConvId} />
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
