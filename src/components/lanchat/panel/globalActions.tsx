import { ExternalLink, PanelRight } from "lucide-react";
import { useCallback, useState } from "react";
import { openDetachedWindow } from "../../../lib/detachWindowing";
import { t as tr } from "../../../lib/i18n";
import { useAppStore } from "../../../stores/appStore";
import { useLanChatStore } from "../../../stores/lanChatStore";
import { useActiveHeader } from "./useActiveHeader";

/**
 * Detach / edge-dock actions for the whole LanChat surface. These are
 * independent of any single conversation, so they live in the roster header
 * (always visible) rather than the conversation header. Detach works even with
 * no active conversation — the detached window opens its own roster.
 */
export function useGlobalChatActions() {
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
export function GlobalActionButtons({ orientation }: { orientation: "row" | "col"; }) {
  const { isDesktop, detach, openEdgeDock } = useGlobalChatActions();
  const [dockMenu, setDockMenu] = useState(false);
  const col = orientation === "col";
  const btnClass = col
    ? "grid h-6 w-6 flex-none place-items-center rounded-md disabled:opacity-40"
    : "grid h-7 w-7 flex-none place-items-center rounded-md disabled:opacity-40";
  const iconClass = col ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <div className={col ? "flex flex-col items-center gap-1" : "flex flex-none items-center gap-0.5"}>
      <button
        type="button"
        data-testid="lanchat-detach"
        title="弹出为独立窗口"
        disabled={!isDesktop}
        onClick={detach}
        className={btnClass}
        style={{ color: "var(--taomni-text-muted)" }}
      >
        <ExternalLink className={iconClass} />
      </button>
      <div className="relative">
        <button
          type="button"
          data-testid="lanchat-dock"
          title="停靠到窗口边缘（抽屉）"
          onClick={() => setDockMenu((v) => !v)}
          className={btnClass}
          style={{ color: "var(--taomni-text-muted)" }}
        >
          <PanelRight className={iconClass} />
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
