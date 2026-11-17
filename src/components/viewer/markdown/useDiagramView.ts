import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { useElementResizeFrame } from "../../../hooks/useElementResizeFrame";
import { applyDiagramAction, type DiagramAction } from "./diagramActions";
import { DEFAULT_DIAGRAM_VIEW, diagramScale, zoomDiagram, type DiagramView } from "./diagramModel";

export function useDiagramView(image: { width: number; height: number }, initialAction: DiagramAction = "open") {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState<DiagramView>(() => applyDiagramAction({ ...DEFAULT_DIAGRAM_VIEW }, initialAction));
  const scale = diagramScale(view, image, size);
  const current = useRef({ view, scale });
  current.current = { view, scale };
  const drag = useRef<{ id: number; x: number; y: number; view: DiagramView } | null>(null);
  const measure = useCallback(() => {
    const bounds = stage.current?.getBoundingClientRect();
    if (bounds?.width && bounds.height) setSize((old) => old.width === bounds.width && old.height === bounds.height ? old : { width: bounds.width, height: bounds.height });
  }, []);
  useElementResizeFrame(stage, measure);
  const zoom = useCallback((factor: number, point?: { x: number; y: number }) => {
    const state = current.current;
    setView(zoomDiagram(state.view, state.scale, factor, point));
  }, []);
  const action = (id: DiagramAction) => {
    if (id === "zoom-in" || id === "zoom-out") zoom(id === "zoom-in" ? 1.25 : 0.8);
    else setView((old) => applyDiagramAction(old, id));
  };
  useEffect(() => {
    const element = stage.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const box = element!.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
      zoom(Math.exp(-Math.max(-800, Math.min(800, delta)) / 400), { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 });
    };
    element?.addEventListener("wheel", wheel, { passive: false });
    return () => element?.removeEventListener("wheel", wheel);
  }, [zoom]);
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { stage, view, scale, action,
    pan: (x: number, y: number) => setView((old) => ({ ...old, mode: "custom", scale, x: old.x + x, y: old.y + y })),
    pointer: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || drag.current) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...view, scale, mode: "custom" } };
        event.currentTarget.setPointerCapture?.(event.pointerId); event.currentTarget.focus(); event.preventDefault();
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (start?.id === event.pointerId) setView({ ...start.view, x: start.view.x + event.clientX - start.x, y: start.view.y + event.clientY - start.y });
      },
      onPointerUp: end, onPointerCancel: end,
      onLostPointerCapture: () => { drag.current = null; },
    },
  };
}
