import { useState, type ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpFromLine,
  CircleOff,
  CirclePlay,
  EllipsisVertical,
  LayoutList,
  Pause,
  RotateCcw,
  Square,
} from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import type { DebugStepAction } from "../../dapDebugModel";
import { useContextMenu, type MenuItem } from "../../../../ContextMenu";
import { isHotReloadSupported } from "./debugActionService";

export interface DebugToolWindowToolbarProps {
  debug: CodeDebugSession;
  activeRunning: boolean;
  stopped: boolean;
  onShowExecutionPoint?: () => void;
  /** IDEA View Breakpoints… (Ctrl+Shift+F8). */
  onViewBreakpoints?: () => void;
  /** IDEA Evaluate Expression… (Alt+F8). */
  onEvaluateExpression?: () => void;
  /** Run to the active editor's caret line; null when there is no caret target. */
  onRunToCursor?: (() => void) | null;
}

const toolButton =
  "h-6 w-6 inline-flex items-center justify-center rounded transition-colors hover:bg-[var(--taomni-hover-bg)] disabled:opacity-30 disabled:pointer-events-none aria-pressed:bg-[var(--taomni-accent)]/20";

function Separator() {
  return <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-[var(--taomni-code-border)]" />;
}

function ToolButton({
  testId,
  title,
  disabled,
  pressed,
  onClick,
  children,
}: {
  testId: string;
  title: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className={toolButton}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={title}
      title={title}
    >
      {children}
    </button>
  );
}

/**
 * IDEA's Debug tool window toolbar (new UI, XDebugger.ToolWindow.TopToolbar3):
 * Rerun, Stop | Resume, Pause, Step Over, Step Into, Step Out | View
 * Breakpoints, Mute Breakpoints | More (Run to Cursor, Show Execution Point,
 * Evaluate Expression, Reset Frame, …). Capability-gated actions only appear
 * when the adapter supports them.
 */
export function DebugToolWindowToolbar({
  debug,
  activeRunning,
  stopped,
  onShowExecutionPoint,
  onViewBreakpoints,
  onEvaluateExpression,
  onRunToCursor,
}: DebugToolWindowToolbarProps) {
  const [isStepping, setIsStepping] = useState(false);
  const moreMenu = useContextMenu();
  const stepping = debug.isStepping || isStepping;
  const stepDisabled = !stopped || stepping;
  const supportsRestartFrame = debug.capabilities.supportsRestartFrame === true;
  const selectedFrameId = debug.state?.selectedFrameId ?? debug.state?.frames[0]?.id ?? null;

  const handleStep = async (action: DebugStepAction) => {
    if (stepping || !stopped) return;
    setIsStepping(true);
    try {
      await debug.step(action);
    } catch {
      // Step failed or interrupted; the session state reports it.
    } finally {
      setIsStepping(false);
    }
  };

  const moreItems = (): MenuItem[] => {
    const items: MenuItem[] = [];
    if (debug.capabilities.supportsStepBack === true) {
      items.push({
        label: "Step Back",
        testId: "debug-step-back",
        disabled: stepDisabled,
        onClick: () => void handleStep("stepBack"),
      });
    }
    items.push({
      label: "Run to Cursor",
      testId: "debug-run-to-cursor",
      shortcut: "Alt+F9",
      disabled: !stopped || !onRunToCursor,
      onClick: () => onRunToCursor?.(),
    });
    items.push({ separator: true, label: "" });
    items.push({
      label: "Show Execution Point",
      testId: "debug-show-execution-point",
      shortcut: "Alt+F10",
      disabled: !stopped || !onShowExecutionPoint,
      onClick: () => onShowExecutionPoint?.(),
    });
    items.push({ separator: true, label: "" });
    items.push({
      label: "Evaluate Expression…",
      testId: "debug-evaluate-expression",
      shortcut: "Alt+F8",
      disabled: !stopped || !onEvaluateExpression,
      onClick: () => onEvaluateExpression?.(),
    });
    if (supportsRestartFrame) {
      items.push({
        label: "Reset Frame",
        testId: "debug-reset-frame",
        disabled: !stopped || selectedFrameId == null,
        onClick: () => {
          if (selectedFrameId != null) debug.restartFrame(selectedFrameId);
        },
      });
    }
    if (isHotReloadSupported(debug.capabilities)) {
      items.push({ separator: true, label: "" });
      items.push({
        label: "Reload Changed Classes",
        testId: "debug-hot-reload",
        disabled: !activeRunning,
        onClick: () => debug.hotReload(),
      });
    }
    return items;
  };

  return (
    <div
      data-testid="debug-session-controls"
      role="toolbar"
      aria-label="Debug actions"
      className="flex shrink-0 items-center gap-0.5"
    >
      <ToolButton testId="debug-restart" title="Rerun (Ctrl+F5)" disabled={!debug.canRestart} onClick={() => debug.restart()}>
        <RotateCcw className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
      </ToolButton>
      <ToolButton testId="debug-stop" title="Stop (Ctrl+F2)" disabled={!activeRunning} onClick={() => debug.terminate()}>
        <Square className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />
      </ToolButton>
      <Separator />
      <ToolButton testId="debug-continue" title="Resume Program (F9)" disabled={!stopped} onClick={() => void debug.step("continue")}>
        <CirclePlay className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" />
      </ToolButton>
      <ToolButton
        testId="debug-pause"
        title="Pause Program"
        disabled={!activeRunning || stopped}
        onClick={() => void debug.step("pause")}
      >
        <Pause className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
      </ToolButton>
      <ToolButton testId="debug-step-over" title="Step Over (F8)" disabled={stepDisabled} onClick={() => void handleStep("stepOver")}>
        <ArrowRightToLine className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
      </ToolButton>
      <ToolButton testId="debug-step-in" title="Step Into (F7)" disabled={stepDisabled} onClick={() => void handleStep("stepIn")}>
        <ArrowDownToLine className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
      </ToolButton>
      <ToolButton testId="debug-step-out" title="Step Out (Shift+F8)" disabled={stepDisabled} onClick={() => void handleStep("stepOut")}>
        <ArrowUpFromLine className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
      </ToolButton>
      <Separator />
      <ToolButton
        testId="debug-view-breakpoints"
        title="View Breakpoints… (Ctrl+Shift+F8)"
        disabled={!onViewBreakpoints}
        onClick={() => onViewBreakpoints?.()}
      >
        <LayoutList className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />
      </ToolButton>
      <ToolButton
        testId="debug-toolbar-mute-breakpoints"
        title="Mute Breakpoints"
        pressed={debug.breakpointsMuted}
        onClick={() => debug.setBreakpointsMuted(!debug.breakpointsMuted)}
      >
        <CircleOff className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />
      </ToolButton>
      <Separator />
      <button
        type="button"
        data-testid="debug-toolbar-more"
        aria-label="More"
        title="More"
        aria-haspopup="menu"
        className={toolButton}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          moreMenu.showAt(rect.left, rect.bottom + 2, moreItems());
        }}
      >
        <EllipsisVertical className="h-3.5 w-3.5 text-[var(--taomni-text-muted)]" />
      </button>
      {moreMenu.render}
    </div>
  );
}
