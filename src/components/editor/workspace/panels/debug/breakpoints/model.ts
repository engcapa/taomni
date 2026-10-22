import { type DebugBreakpointMode } from "../../../dapDebugModel";
import type { CodeDebugSession } from "../../../useCodeDebugSession";

export interface BreakpointsViewProps {
  debug: CodeDebugSession;
  editing: { path: string; line: number; } | null;
  setEditing: (target: { path: string; line: number; } | null) => void;
  onOpenBreakpoint?: (path: string, line: number) => void;
  dataBreakpointModes: DebugBreakpointMode[];
  dataBreakpointMode: string | undefined;
  onDataBreakpointModeChange: (mode: string) => void;
  /** Whether to show child views (Function, Instruction, Data) - true by default */
  includeChildViews?: boolean;
}
