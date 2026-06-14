import { useEffect, useRef } from "react";

export interface UseModalDraggableAndResizableOptions {
  minWidth?: number;
  minHeight?: number;
}

export function useModalDraggableAndResizable(options: UseModalDraggableAndResizableOptions = {}) {
  const { minWidth = 400, minHeight = 300 } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const container = containerRef.current;
    const dragHandle = handleRef.current;
    if (!container) return;

    // 1. Draggable Logic (via dragHandle)
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragInitialX = 0;
    let dragInitialY = 0;

    const onDragPointerDown = (e: PointerEvent) => {
      if (!dragHandle) return;
      if (e.button !== 0) return;

      const target = e.target as HTMLElement;
      if (
        target.closest("button") ||
        target.closest("input") ||
        target.closest("select") ||
        target.closest("a") ||
        target.closest("textarea")
      ) {
        return;
      }

      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragInitialX = offsetRef.current.x;
      dragInitialY = offsetRef.current.y;

      try {
        dragHandle.setPointerCapture(e.pointerId);
      } catch (err) {}

      dragHandle.addEventListener("pointermove", onDragPointerMove);
      dragHandle.addEventListener("pointerup", onDragPointerUp);
      dragHandle.addEventListener("pointercancel", onDragPointerUp);
    };

    const onDragPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      const newX = dragInitialX + dx;
      const newY = dragInitialY + dy;

      offsetRef.current = { x: newX, y: newY };
      container.style.transform = `translate(${newX}px, ${newY}px)`;
    };

    const onDragPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;

      try {
        dragHandle?.releasePointerCapture(e.pointerId);
      } catch (err) {}

      dragHandle?.removeEventListener("pointermove", onDragPointerMove);
      dragHandle?.removeEventListener("pointerup", onDragPointerUp);
      dragHandle?.removeEventListener("pointercancel", onDragPointerUp);
    };

    if (dragHandle) {
      dragHandle.addEventListener("pointerdown", onDragPointerDown);
      dragHandle.style.cursor = "move";
    }

    // 2. Resizable Logic
    const handles: { el: HTMLDivElement; direction: string }[] = [];

    const createHandle = (direction: string, cursor: string, styles: Partial<CSSStyleDeclaration>) => {
      const el = document.createElement("div");
      el.className = `modal-resize-handle modal-resize-handle-${direction.toLowerCase()}`;
      Object.assign(el.style, {
        position: "absolute",
        cursor: cursor,
        zIndex: "100",
        userSelect: "none",
        background: "transparent",
        ...styles,
      });
      container.appendChild(el);
      handles.push({ el, direction });
      return el;
    };

    // Setup 8 handles
    const edgeSize = "6px";
    const cornerSize = "12px";

    createHandle("N", "ns-resize", { top: "0", left: "0", right: "0", height: edgeSize });
    createHandle("S", "ns-resize", { bottom: "0", left: "0", right: "0", height: edgeSize });
    createHandle("E", "ew-resize", { right: "0", top: "0", bottom: "0", width: edgeSize });
    createHandle("W", "ew-resize", { left: "0", top: "0", bottom: "0", width: edgeSize });

    createHandle("NW", "nwse-resize", { top: "0", left: "0", width: cornerSize, height: cornerSize });
    createHandle("NE", "nesw-resize", { top: "0", right: "0", width: cornerSize, height: cornerSize });
    createHandle("SW", "nesw-resize", { bottom: "0", left: "0", width: cornerSize, height: cornerSize });
    createHandle("SE", "nwse-resize", { bottom: "0", right: "0", width: cornerSize, height: cornerSize });

    // Handle drag-resize interaction
    handles.forEach(({ el, direction }) => {
      let isResizing = false;
      let resizeStartX = 0;
      let resizeStartY = 0;
      let resizeInitialW = 0;
      let resizeInitialH = 0;
      let resizeInitialX = 0;
      let resizeInitialY = 0;

      const onResizePointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        isResizing = true;
        resizeStartX = e.clientX;
        resizeStartY = e.clientY;

        const rect = container.getBoundingClientRect();
        resizeInitialW = rect.width;
        resizeInitialH = rect.height;
        resizeInitialX = offsetRef.current.x;
        resizeInitialY = offsetRef.current.y;

        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {}

        el.addEventListener("pointermove", onResizePointerMove);
        el.addEventListener("pointerup", onResizePointerUp);
        el.addEventListener("pointercancel", onResizePointerUp);
      };

      const onResizePointerMove = (e: PointerEvent) => {
        if (!isResizing) return;
        const dx = e.clientX - resizeStartX;
        const dy = e.clientY - resizeStartY;

        let newWidth = resizeInitialW;
        let newHeight = resizeInitialH;
        let newX = resizeInitialX;
        let newY = resizeInitialY;

        if (direction.includes("E")) {
          newWidth = resizeInitialW + dx;
        }
        if (direction.includes("W")) {
          newWidth = resizeInitialW - dx;
          if (newWidth >= minWidth) {
            newX = resizeInitialX + dx;
          } else {
            newWidth = minWidth;
            newX = resizeInitialX + (resizeInitialW - minWidth);
          }
        }
        if (direction.includes("S")) {
          newHeight = resizeInitialH + dy;
        }
        if (direction.includes("N")) {
          newHeight = resizeInitialH - dy;
          if (newHeight >= minHeight) {
            newY = resizeInitialY + dy;
          } else {
            newHeight = minHeight;
            newY = resizeInitialY + (resizeInitialH - minHeight);
          }
        }

        if (newWidth < minWidth) newWidth = minWidth;
        if (newHeight < minHeight) newHeight = minHeight;

        container.style.width = `${newWidth}px`;
        container.style.height = `${newHeight}px`;
        offsetRef.current = { x: newX, y: newY };
        container.style.transform = `translate(${newX}px, ${newY}px)`;
      };

      const onResizePointerUp = (e: PointerEvent) => {
        if (!isResizing) return;
        isResizing = false;

        try {
          el.releasePointerCapture(e.pointerId);
        } catch (err) {}

        el.removeEventListener("pointermove", onResizePointerMove);
        el.removeEventListener("pointerup", onResizePointerUp);
        el.removeEventListener("pointercancel", onResizePointerUp);
      };

      el.addEventListener("pointerdown", onResizePointerDown);
    });

    return () => {
      // Cleanup drag
      if (dragHandle) {
        dragHandle.removeEventListener("pointerdown", onDragPointerDown);
      }
      // Cleanup resize handles and remove them from DOM
      handles.forEach(({ el }) => {
        try {
          container.removeChild(el);
        } catch (err) {}
      });
    };
  }, [minWidth, minHeight]);

  return { containerRef, handleRef };
}
