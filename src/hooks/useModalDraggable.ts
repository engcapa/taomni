import { useEffect, useRef } from "react";

export function useModalDraggable() {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handle = handleRef.current;
    const container = containerRef.current;
    if (!handle || !container) return;

    let startX = 0;
    let startY = 0;
    let initialX = 0;
    let initialY = 0;
    let isDragging = false;

    const onPointerDown = (e: PointerEvent) => {
      // Only drag with left click
      if (e.button !== 0) return;

      // Don't drag if clicking interactive elements inside the handle (like buttons, links, inputs, textarea)
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
      startX = e.clientX;
      startY = e.clientY;
      initialX = offsetRef.current.x;
      initialY = offsetRef.current.y;

      // Set pointer capture to ensure we receive pointer events even if the cursor leaves the handle/window
      try {
        handle.setPointerCapture(e.pointerId);
      } catch (err) {
        // Fallback if pointer capture is not supported
      }

      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerUp);
      handle.addEventListener("pointercancel", onPointerUp);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newX = initialX + dx;
      const newY = initialY + dy;

      offsetRef.current = { x: newX, y: newY };
      container.style.transform = `translate(${newX}px, ${newY}px)`;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!isDragging) return;
      isDragging = false;

      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (err) {
        // Fallback
      }

      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };

    handle.addEventListener("pointerdown", onPointerDown);
    handle.style.cursor = "move";

    return () => {
      handle.removeEventListener("pointerdown", onPointerDown);
      handle.removeEventListener("pointermove", onPointerMove);
      handle.removeEventListener("pointerup", onPointerUp);
      handle.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  return { containerRef, handleRef };
}
