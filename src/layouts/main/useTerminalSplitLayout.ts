import { useRef, useCallback, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Tab } from "../../types";
import { axisWeights, positiveWeight, resizeAdjacentWeights, sumWeights, weightsToGridTemplate } from "./splitLayout";


export interface UseTerminalSplitLayoutContext {
  terminalTabs: Tab[];
  terminalSplitVisible: boolean;
  terminalSplitLayout: import("../../stores/appStore").TerminalSplitLayout;
}

export function useTerminalSplitLayout(context: UseTerminalSplitLayoutContext) {
  const { terminalTabs, terminalSplitVisible, terminalSplitLayout } = context;

  const [splitPaneWeights, setSplitPaneWeights] = useState<Record<string, number>>({});
  const [splitGridColumnWeights, setSplitGridColumnWeights] = useState<number[]>([]);
  const [splitGridRowWeights, setSplitGridRowWeights] = useState<number[]>([]);
  const splitPanesRef = useRef<HTMLDivElement>(null);

  const splitGridColumns = Math.max(1, Math.ceil(Math.sqrt(terminalTabs.length)));
  const splitGridRows = Math.max(1, Math.ceil(terminalTabs.length / splitGridColumns));
  const splitPaneWeightsForTabs = useMemo(
    () => terminalTabs.map((tab) => positiveWeight(splitPaneWeights[tab.id])),
    [splitPaneWeights, terminalTabs],
  );
  const splitGridColumnWeightsForLayout = useMemo(
    () => axisWeights(splitGridColumnWeights, splitGridColumns),
    [splitGridColumnWeights, splitGridColumns],
  );
  const splitGridRowWeightsForLayout = useMemo(
    () => axisWeights(splitGridRowWeights, splitGridRows),
    [splitGridRowWeights, splitGridRows],
  );
  const splitGridColumnTemplate = weightsToGridTemplate(splitGridColumnWeightsForLayout);
  const splitGridRowTemplate = weightsToGridTemplate(splitGridRowWeightsForLayout);
  const terminalPanesClass = terminalSplitVisible
    ? terminalSplitLayout === "horizontal"
      ? "flex-1 min-h-0 flex flex-row relative"
      : terminalSplitLayout === "vertical"
        ? "flex-1 min-h-0 flex flex-col relative"
        : "flex-1 min-h-0 grid relative"
    : "contents";

  const startLinearSplitResize = useCallback((
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!terminalSplitVisible || terminalSplitLayout === "grid") return;
    const container = splitPanesRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const horizontal = terminalSplitLayout === "horizontal";
    const dimension = horizontal ? rect.width : rect.height;
    if (dimension <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const ids = terminalTabs.map((tab) => tab.id);
    const initialWeights = ids.map((id) => positiveWeight(splitPaneWeights[id]));
    const totalWeight = sumWeights(initialWeights);
    const startCoord = horizontal ? event.clientX : event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentCoord = horizontal ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = ((currentCoord - startCoord) / dimension) * totalWeight;
      const nextWeights = resizeAdjacentWeights(initialWeights, index, deltaWeight);
      setSplitPaneWeights((prev) => {
        const next = { ...prev };
        ids.forEach((id, weightIndex) => {
          next[id] = nextWeights[weightIndex];
        });
        return next;
      });
    };

    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [splitPaneWeights, terminalSplitLayout, terminalSplitVisible, terminalTabs]);

  const startGridSplitResize = useCallback((
    axis: "column" | "row",
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!terminalSplitVisible || terminalSplitLayout !== "grid") return;
    const container = splitPanesRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const dimension = axis === "column" ? rect.width : rect.height;
    if (dimension <= 0) return;

    event.preventDefault();
    event.stopPropagation();

    const initialWeights = axis === "column"
      ? splitGridColumnWeightsForLayout
      : splitGridRowWeightsForLayout;
    const totalWeight = sumWeights(initialWeights);
    const startCoord = axis === "column" ? event.clientX : event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const currentCoord = axis === "column" ? moveEvent.clientX : moveEvent.clientY;
      const deltaWeight = ((currentCoord - startCoord) / dimension) * totalWeight;
      const nextWeights = resizeAdjacentWeights(initialWeights, index, deltaWeight);
      if (axis === "column") {
        setSplitGridColumnWeights(nextWeights);
      } else {
        setSplitGridRowWeights(nextWeights);
      }
    };

    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [
    splitGridColumnWeightsForLayout,
    splitGridRowWeightsForLayout,
    terminalSplitLayout,
    terminalSplitVisible,
  ]);
  return { terminalPanesClass, splitGridColumnTemplate, splitGridRowTemplate, splitGridColumns, splitPaneWeightsForTabs, startLinearSplitResize, splitGridColumnWeightsForLayout, startGridSplitResize, splitGridRowWeightsForLayout, splitPaneWeights, setSplitPaneWeights, splitGridColumnWeights, setSplitGridColumnWeights, splitGridRowWeights, setSplitGridRowWeights, splitPanesRef };
}
