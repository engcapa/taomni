import { useEffect, useMemo } from "react";
import { computeInlineGhost, getVisibleKeywordHighlights, getVisibleSearchHighlights, getVisibleTerminalBlockSelectionHighlights } from "./buffer";
import { useTerminalInteraction } from "./useTerminalInteraction";
import { useTerminalPanelState } from "./useTerminalPanelState";


export interface UseTerminalHighlightsContext {
  panel: ReturnType<typeof useTerminalPanelState>;
  interaction: ReturnType<typeof useTerminalInteraction>;
}

export function useTerminalHighlights(context: UseTerminalHighlightsContext) {
  const { panel, interaction } = context;

  const searchHighlights = useMemo(
    () => getVisibleSearchHighlights(
      panel.termRef.current,
      panel.panelRef.current,
      panel.containerRef.current,
      interaction.searchMatches,
      interaction.activeSearchIndex,
    ),
    [interaction.activeSearchIndex, panel.fontSize, panel.fullscreen, interaction.searchMatches, panel.showScrollbar, panel.viewportVersion],
  );

  const keywordHighlights = useMemo(
    () => getVisibleKeywordHighlights(
      panel.termRef.current,
      panel.panelRef.current,
      panel.containerRef.current,
      panel.syntaxMode,
    ),
    [panel.fontSize, panel.fullscreen, panel.showScrollbar, panel.syntaxMode, panel.viewportVersion],
  );

  const blockSelectionHighlights = useMemo(
    () => getVisibleTerminalBlockSelectionHighlights(
      panel.termRef.current,
      panel.panelRef.current,
      panel.containerRef.current,
      panel.blockSelection,
    ),
    [panel.blockSelection, panel.fontSize, panel.fullscreen, panel.showScrollbar, panel.viewportVersion],
  );

  const inlineGhost = useMemo(
    () => computeInlineGhost(
      panel.termRef.current,
      panel.panelRef.current,
      panel.containerRef.current,
      interaction.suggestionsActive,
      interaction.pendingRef.current,
      interaction.suggestionRef.current,
      interaction.invalidatedRef.current,
    ),
    // ghostTick bumps on pending/suggestion changes; viewportVersion on scroll/render.
    // fontSize/fullscreen/showScrollbar also force recompute on layout shifts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [interaction.ghostTick, panel.viewportVersion, interaction.suggestionsActive, panel.fontSize, panel.fullscreen, panel.showScrollbar],
  );

  useEffect(() => {
    interaction.ghostVisibleRef.current = inlineGhost !== null;
  }, [inlineGhost]);
  return { keywordHighlights, searchHighlights, blockSelectionHighlights, inlineGhost };
}
