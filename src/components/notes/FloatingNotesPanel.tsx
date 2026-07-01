import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { PanelRightClose } from "lucide-react";
import { useNotesStore, type NotesPanelPosition } from "../../stores/notesStore";
import { notesThemeStyle } from "../../lib/notes/notesTheme";
import { useT } from "../../lib/i18n";
import { NotesPanel } from "./NotesPanel";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 260;

function clampPosition(pos: NotesPanelPosition): NotesPanelPosition {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const width = Math.max(MIN_WIDTH, Math.min(pos.width, Math.max(MIN_WIDTH, vw - 16)));
  const height = Math.max(MIN_HEIGHT, Math.min(pos.height, Math.max(MIN_HEIGHT, vh - 16)));
  const x = Math.max(0, Math.min(pos.x, vw - width));
  const y = Math.max(0, Math.min(pos.y, vh - height));
  return { x, y, width, height };
}

/**
 * FloatingNotesPanel — a single, draggable/resizable in-app overlay that hosts
 * the notes panel when panel mode is "floating" (§4.3). Mounted once at the app
 * root, so there is never more than one notes panel. Its z-index stays below
 * modal dialogs (z-50: vault unlock, auth prompts) so it can never occlude them.
 */
export function FloatingNotesPanel() {
  const t = useT();
  const panelMode = useNotesStore((s) => s.panelMode);
  const panelPosition = useNotesStore((s) => s.panelPosition);
  const setPanelPosition = useNotesStore((s) => s.setPanelPosition);
  const setPanelMode = useNotesStore((s) => s.setPanelMode);
  const alwaysOnTop = useNotesStore((s) => s.alwaysOnTopInApp);
  const theme = useNotesStore((s) => s.theme);

  const [pos, setPos] = useState<NotesPanelPosition>(() => clampPosition(panelPosition));
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; base: NotesPanelPosition } | null>(null);

  // Keep local geometry in sync with persisted prefs when not actively dragging.
  useEffect(() => {
    if (!dragRef.current) setPos(clampPosition(panelPosition));
  }, [panelPosition]);

  if (panelMode !== "floating") return null;

  const onPointerMove = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.mode === "move") {
      setPos(clampPosition({ ...drag.base, x: drag.base.x + dx, y: drag.base.y + dy }));
    } else {
      setPos(clampPosition({ ...drag.base, width: drag.base.width + dx, height: drag.base.height + dy }));
    }
  };

  const endDrag = (event: ReactPointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* browser preview */
    }
    setPanelPosition(pos);
  };

  const startDrag = (mode: "move" | "resize") => (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, base: pos };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* browser preview */
    }
  };

  const style: CSSProperties = {
    left: pos.x,
    top: pos.y,
    width: pos.width,
    height: pos.height,
    ...notesThemeStyle(theme),
  };

  return (
    <div
      className={`fixed flex flex-col rounded-md border border-[var(--taomni-divider)] shadow-2xl overflow-hidden ${alwaysOnTop ? "z-40" : "z-30"}`}
      style={{ ...style, background: "var(--taomni-sidebar-bg)", color: "var(--taomni-text)" }}
      data-testid="floating-notes-panel"
      data-always-on-top={alwaysOnTop || undefined}
    >
      {/* Drag handle / title bar */}
      <div
        className="flex items-center gap-2 px-2 h-7 shrink-0 border-b border-[var(--taomni-divider)] cursor-move select-none"
        style={{ background: "var(--taomni-panel-bg)", touchAction: "none" }}
        onPointerDown={startDrag("move")}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        data-testid="floating-notes-drag"
      >
        <span className="text-[12px] font-semibold flex-1 truncate">{t("notes.title")}</span>
        <button
          type="button"
          className="taomni-btn h-5 w-5 p-0 inline-flex items-center justify-center"
          onClick={() => setPanelMode("hub")}
          title={t("notes.dock")}
          aria-label={t("notes.dock")}
          data-testid="floating-notes-dock"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PanelRightClose className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Notes content */}
      <div className="flex-1 min-h-0 flex flex-col">
        <NotesPanel />
      </div>

      {/* Resize handle (bottom-right) */}
      <div
        className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize"
        style={{ touchAction: "none" }}
        onPointerDown={startDrag("resize")}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        data-testid="floating-notes-resize"
      />
    </div>
  );
}
