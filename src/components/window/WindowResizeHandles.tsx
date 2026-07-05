import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { isTauriRuntime } from "../../lib/runtime";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

interface ResizeHandle {
  direction: ResizeDirection;
  className: string;
  cursor: CSSProperties["cursor"];
}

const EDGE_SIZE = 6;
const CORNER_SIZE = 14;

interface WindowResizeHandlesProps {
  className?: string;
  edgeSize?: number;
  cornerSize?: number;
}

const HANDLES: ResizeHandle[] = [
  {
    direction: "North",
    className: "left-0 right-0 top-0",
    cursor: "ns-resize",
  },
  {
    direction: "South",
    className: "left-0 right-0 bottom-0",
    cursor: "ns-resize",
  },
  {
    direction: "West",
    className: "left-0 top-0 bottom-0",
    cursor: "ew-resize",
  },
  {
    direction: "East",
    className: "right-0 top-0 bottom-0",
    cursor: "ew-resize",
  },
  {
    direction: "NorthWest",
    className: "left-0 top-0",
    cursor: "nwse-resize",
  },
  {
    direction: "NorthEast",
    className: "right-0 top-0",
    cursor: "nesw-resize",
  },
  {
    direction: "SouthWest",
    className: "left-0 bottom-0",
    cursor: "nesw-resize",
  },
  {
    direction: "SouthEast",
    className: "right-0 bottom-0",
    cursor: "nwse-resize",
  },
];

export function WindowResizeHandles({
  className = "fixed inset-0 z-[10000]",
  edgeSize = EDGE_SIZE,
  cornerSize = CORNER_SIZE,
}: WindowResizeHandlesProps = {}) {
  if (!isTauriRuntime()) return null;

  const startResize = (direction: ResizeDirection) => (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    void getCurrentWindow().startResizeDragging(direction).catch(() => {});
  };

  return (
    <div className={`${className} pointer-events-none`} aria-hidden="true">
      {HANDLES.map((handle) => {
        const isCorner = handle.direction.length > 5;
        const style: CSSProperties = {
          cursor: handle.cursor,
          height: isCorner ? cornerSize : edgeSize,
          width: isCorner ? cornerSize : edgeSize,
          pointerEvents: "auto",
        };

        if (!isCorner && (handle.direction === "North" || handle.direction === "South")) {
          style.width = "auto";
        }
        if (!isCorner && (handle.direction === "East" || handle.direction === "West")) {
          style.height = "auto";
        }

        return (
          <div
            key={handle.direction}
            className={`absolute ${handle.className}`}
            style={style}
            onMouseDown={startResize(handle.direction)}
          />
        );
      })}
    </div>
  );
}
