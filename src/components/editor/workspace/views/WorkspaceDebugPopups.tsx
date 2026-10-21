import { DapAdapterGuideDialog } from "../DapAdapterGuideDialog";
import { useBreakpointControls } from "../hooks/useBreakpointControls";
import { BreakpointPopup, GutterBreakpointMenu } from "../panels/debug/BreakpointPopup";
import { BreakpointsDialog } from "../panels/debug/BreakpointsDialog";
import { EvaluateExpressionDialog } from "../panels/debug/EvaluateExpressionDialog";
import { useCodeDebugSession } from "../useCodeDebugSession";


export interface WorkspaceDebugPopupsProps {
  dapGuideOpen: boolean;
  setDapGuideOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  breakpointPopup: { path: string; line: number; anchor: { x: number; y: number; }; expanded: boolean; } | null;
  debug: ReturnType<typeof useCodeDebugSession>;
  breakpoints: ReturnType<typeof useBreakpointControls>;
  gutterMenu: { path: string; line: number; x: number; y: number; } | null;
  openDebugFrame: (frame: Pick<import("../dapDebugModel").DebugStackFrame, "path" | "line"> & Partial<Pick<import("../dapDebugModel").DebugStackFrame, "sourceReference" | "sourceName" | "name">> & { column?: number; }) => void;
}

export function WorkspaceDebugPopups(props: WorkspaceDebugPopupsProps) {
  const { dapGuideOpen, setDapGuideOpen, breakpointPopup, debug, breakpoints, gutterMenu, openDebugFrame } = props;
  return (<>{dapGuideOpen && (
    <DapAdapterGuideDialog
      open={true}
      onClose={() => setDapGuideOpen(false)}
    />
  )}
    {breakpointPopup && (() => {
      const target = debug.breakpoints[breakpointPopup.path]?.find((bp) => bp.line === breakpointPopup.line);
      if (!target) return null;
      return (
        <BreakpointPopup
          key={`${breakpointPopup.path}:${breakpointPopup.line}`}
          path={breakpointPopup.path}
          breakpoint={target}
          anchor={breakpointPopup.anchor}
          expanded={breakpointPopup.expanded}
          otherBreakpoints={Object.entries(debug.breakpoints).flatMap(([path, list]) => (
            list.map((bp) => ({ path, line: bp.line }))
          ))}
          onChange={(options) => debug.setBreakpointOptions(breakpointPopup.path, breakpointPopup.line, options)}
          onMore={() => {
            breakpoints.setBreakpointPopup(null);
            breakpoints.setBreakpointsDialog({ initial: { path: breakpointPopup.path, line: breakpointPopup.line } });
          }}
          onClose={() => breakpoints.setBreakpointPopup(null)}
        />
      );
    })()}
    {gutterMenu && (
      <GutterBreakpointMenu
        menu={gutterMenu}
        onClose={() => breakpoints.setGutterMenu(null)}
        onAdd={(kind) => {
          const { path, line, x, y } = gutterMenu;
          breakpoints.setGutterMenu(null);
          if (kind === "plain") {
            debug.addBreakpoint(path, line);
          } else if (kind === "conditional") {
            debug.addBreakpoint(path, line);
            breakpoints.openBreakpointPopup(path, line, { x, y });
          } else {
            debug.addBreakpoint(path, line, { suspend: false, logHitMessage: true });
            breakpoints.openBreakpointPopup(path, line, { x, y }, true);
          }
        }}
      />
    )}
    {breakpoints.breakpointsDialog && (
      <BreakpointsDialog
        debug={debug}
        initial={breakpoints.breakpointsDialog.initial}
        onOpenBreakpoint={(path, line) => openDebugFrame({ path, line })}
        onClose={() => breakpoints.setBreakpointsDialog(null)}
      />
    )}
    {breakpoints.evaluateDialog && (
      <EvaluateExpressionDialog
        debug={debug}
        initialExpression={breakpoints.evaluateDialog.expression}
        onClose={() => breakpoints.setEvaluateDialog(null)}
      />
    )}
  </>);
}
