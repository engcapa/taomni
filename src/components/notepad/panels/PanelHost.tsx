import { useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { GripVertical, MoreHorizontal, X } from "lucide-react";
import { useContextMenu } from "../../ContextMenu";
import { useNotepadStore, type NotepadPanelId, type NotepadSearchResultHit } from "../../../stores/notepadStore";
import type { HostedDocRef } from "../../../lib/notepad/host/types";
import { useViewerLabels } from "../../viewer/viewerLabels";
import { CharPanel } from "./CharPanel";
import { DocumentListPanel } from "./DocumentListPanel";
import { DocumentMapPanel } from "./DocumentMapPanel";
import { SearchResultsPanel } from "./SearchResultsPanel";

export interface PanelHostProps {
  activeDocKey: string;
  content: string;
  primaryView: EditorView | null;
  onInsertChar: (ch: string) => void;
  onSelectDoc: (doc: HostedDocRef) => void;
  onCloseDoc: (doc: HostedDocRef) => void;
  onJumpHit: (hit: NotepadSearchResultHit) => void;
}

const PANEL_IDS: NotepadPanelId[] = ["minimap", "doclist", "chars", "results"];

const FLOAT_WIDTH = 340;
const FLOAT_HEIGHT = 300;

/** Prototype-style `⋯` dock menu: right / bottom / floating (DEC-02 limited docking). */
function DockMenuButton({ id }: { id: NotepadPanelId }) {
  const label = useViewerLabels();
  const menu = useContextMenu();
  const setPanelPos = useNotepadStore((state) => state.setPanelPos);
  const open = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    menu.showAt(rect.left, rect.bottom + 2, [
      { label: label("停靠到右侧", "Dock to Right"), testId: `notepad-panel-dock-${id}-right`, onClick: () => setPanelPos(id, "right") },
      { label: label("停靠到底部", "Dock to Bottom"), testId: `notepad-panel-dock-${id}-bottom`, onClick: () => setPanelPos(id, "bottom") },
      { label: label("浮动为独立窗口", "Float as Separate Window"), testId: `notepad-panel-dock-${id}-float`, onClick: () => setPanelPos(id, "float", { x: 320 + 40 * PANEL_IDS.indexOf(id), y: 140 + 40 * PANEL_IDS.indexOf(id) }) },
    ]);
  };
  return (
    <>
      {menu.render}
      <button
        type="button"
        className="np-status-btn"
        data-testid={`notepad-panel-dock-menu-${id}`}
        title={label("停靠位置", "Dock position")}
        onClick={(event) => open(event.currentTarget)}
      >
        <MoreHorizontal size={12} />
      </button>
    </>
  );
}

function PanelHeader({
  id,
  title,
  float,
  onStartDrag,
}: {
  id: NotepadPanelId;
  title: string;
  float?: boolean;
  onStartDrag?: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const togglePanel = useNotepadStore((state) => state.togglePanel);
  return (
    <div className={float ? "np-dock-header np-float-header" : "np-dock-header"} onPointerDown={onStartDrag}>
      {float && <GripVertical size={12} className="np-float-grip" />}
      <span>{title}</span>
      <div className="flex items-center gap-1">
        <DockMenuButton id={id} />
        <button type="button" className="np-status-btn" data-testid={`notepad-panel-close-${id}`} onClick={() => togglePanel(id)} aria-label="Close panel">
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

interface PanelBodyProps extends PanelHostProps {
  id: NotepadPanelId;
}

function PanelBody({ id, activeDocKey, content, primaryView, onInsertChar, onSelectDoc, onCloseDoc, onJumpHit }: PanelBodyProps) {
  const label = useViewerLabels();
  const { results, resultsTitle, setSearchResults } = useNotepadStore();
  if (id === "minimap") return <DocumentMapPanel content={content} view={primaryView} />;
  if (id === "doclist") {
    return <DocumentListPanel activeDocKey={activeDocKey} onSelectDoc={onSelectDoc} onCloseDoc={onCloseDoc} />;
  }
  if (id === "chars") return <CharPanel onInsertChar={onInsertChar} />;
  return (
    <SearchResultsPanel
      title={resultsTitle || label("尚无结果：使用“全部查找”", "No results yet: use Find All")}
      hits={results}
      onJumpHit={onJumpHit}
      onClear={() => setSearchResults("", [])}
    />
  );
}

const PANEL_TITLE_KEYS: Record<NotepadPanelId, { zh: string; en: string }> = {
  minimap: { zh: "文档地图", en: "Document Map" },
  doclist: { zh: "文档列表", en: "Document List" },
  chars: { zh: "字符面板", en: "Character Panel" },
  results: { zh: "搜索结果", en: "Search Results" },
};

/** Right/bottom dock renderer (DEC-02 limited docking). */
export function PanelDockView({ side, ...props }: PanelHostProps & { side: "right" | "bottom" }) {
  const label = useViewerLabels();
  const panels = useNotepadStore((state) => state.panels);
  const openIds = PANEL_IDS.filter((id) => panels[id].open && panels[id].pos === side);
  if (openIds.length === 0) return null;
  return (
    <div className={side === "right" ? "np-right-dock" : "np-bottom-dock"} data-testid={`notepad-dock-${side}`}>
      {openIds.map((id) => (
        <aside key={id} className={side === "right" ? "np-side-dock" : "np-bottom-panel"} data-testid={`notepad-panel-${id}`}>
          <PanelHeader id={id} title={label(PANEL_TITLE_KEYS[id].zh, PANEL_TITLE_KEYS[id].en)} />
          <PanelBody id={id} {...props} />
        </aside>
      ))}
    </div>
  );
}

/** Floating panels (DEC-02 limited docking): 340x300 draggable cards. */
export function FloatingPanels(props: PanelHostProps) {
  const label = useViewerLabels();
  const panels = useNotepadStore((state) => state.panels);
  const setPanelPos = useNotepadStore((state) => state.setPanelPos);
  const [drag, setDrag] = useState<{ id: NotepadPanelId; offsetX: number; offsetY: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const floating = PANEL_IDS.filter((id) => panels[id].open && panels[id].pos === "float");
  if (floating.length === 0) return null;
  return (
    <div ref={containerRef} className="np-float-layer" data-testid="notepad-float-layer">
      {floating.map((id) => {
        const state = panels[id];
        const x = state.x ?? 320;
        const y = state.y ?? 140;
        return (
          <section
            key={id}
            className="np-float-panel"
            data-testid={`notepad-panel-${id}`}
            style={{ left: x, top: y, width: FLOAT_WIDTH, height: FLOAT_HEIGHT }}
            onPointerMove={(event) => {
              if (!drag || drag.id !== id) return;
              const rect = containerRef.current?.getBoundingClientRect();
              const nextX = Math.max(0, event.clientX - (rect?.left ?? 0) - drag.offsetX);
              const nextY = Math.max(0, event.clientY - (rect?.top ?? 0) - drag.offsetY);
              setPanelPos(id, "float", { x: nextX, y: nextY });
            }}
            onPointerUp={() => setDrag(null)}
            onPointerLeave={() => setDrag(null)}
          >
            <PanelHeader
              id={id}
              title={label(PANEL_TITLE_KEYS[id].zh, PANEL_TITLE_KEYS[id].en)}
              float
              onStartDrag={(event) => {
                const target = event.currentTarget.getBoundingClientRect();
                setDrag({ id, offsetX: event.clientX - target.left, offsetY: event.clientY - target.top });
              }}
            />
            <PanelBody id={id} {...props} />
          </section>
        );
      })}
    </div>
  );
}

