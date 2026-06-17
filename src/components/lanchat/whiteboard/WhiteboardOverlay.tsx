import { useEffect } from "react";
import { X } from "lucide-react";

import { useLanWbStore } from "../../../stores/lanWbStore";
import { isTauriRuntime } from "../../../lib/runtime";
import { Whiteboard } from "./Whiteboard";

/** Renders the whiteboard invite prompt and the active board window. Mounted
 *  once at the app root so a board survives tab switches. */
export function WhiteboardOverlay() {
  const init = useLanWbStore((s) => s.init);
  const active = useLanWbStore((s) => s.active);
  const name = useLanWbStore((s) => s.name);
  const incoming = useLanWbStore((s) => s.incoming);
  const joinBoard = useLanWbStore((s) => s.joinBoard);
  const setIncoming = useLanWbStore((s) => s.setIncoming);
  const closeBoard = useLanWbStore((s) => s.closeBoard);
  const cursors = useLanWbStore((s) => s.cursors);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <>
      {incoming && !active ? (
        <div
          className="fixed right-4 top-20 z-[200] w-72 rounded-xl p-3"
          style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        >
          <div className="mb-2 text-[13px]">
            <span className="font-semibold">{incoming.fromName}</span> 邀请你加入白板「{incoming.name}」
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={joinBoard}
              className="flex-1 rounded-lg py-2 text-[12px] font-semibold text-white"
              style={{ background: "var(--taomni-accent)" }}
            >
              加入
            </button>
            <button
              type="button"
              onClick={() => setIncoming(null)}
              className="flex-1 rounded-lg py-2 text-[12px]"
              style={{ border: "1px solid var(--taomni-input-border)" }}
            >
              忽略
            </button>
          </div>
        </div>
      ) : null}

      {active ? (
        <div
          className="fixed left-1/2 top-1/2 z-[185] flex h-[80vh] w-[90vw] max-w-[1100px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl"
          style={{ background: "var(--taomni-panel-bg)", border: "1px solid var(--taomni-chrome-border)", boxShadow: "var(--taomni-shadow-lg)" }}
        >
          <div
            className="flex items-center gap-2 px-3 py-2 text-[13px] font-semibold"
            style={{ background: "linear-gradient(to bottom,var(--taomni-titlebar-from),var(--taomni-titlebar-to))", borderBottom: "1px solid var(--taomni-chrome-border)" }}
          >
            协作白板 · {name}
            <span className="ml-2 text-[11px] font-normal" style={{ color: "var(--ok,#16a34a)" }}>
              {isTauriRuntime() ? `● Yjs 同步 · ${1 + Object.keys(cursors).length} 人` : "● 浏览器预览 · 本地绘制（不联网）"}
            </span>
            <span className="ml-auto text-[11px] font-normal" style={{ color: "var(--taomni-text-muted)" }}>
              P2P 广播 · CRDT 合并
            </span>
            <button
              type="button"
              onClick={closeBoard}
              className="ml-2 grid h-6 w-6 place-items-center rounded-md"
              style={{ color: "var(--taomni-text-muted)" }}
              title="关闭白板"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <Whiteboard />
        </div>
      ) : null}
    </>
  );
}
