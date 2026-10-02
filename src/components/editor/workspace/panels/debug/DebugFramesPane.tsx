import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronDown, Funnel, RotateCcw } from "lucide-react";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import type { DebugStackFrame } from "../../dapDebugModel";
import {
  frameLabelText,
  frameListEntries,
  stackLineText,
  threadLabelText,
} from "../../debugBreakpointProperties";
import { useContextMenu, type MenuItem } from "../../../../ContextMenu";
import { Empty } from "./debugPanelShared";

export interface DebugFramesPaneProps {
  debug: CodeDebugSession;
  activeRunning: boolean;
  stopped: boolean;
  onOpenFrame: (frame: DebugStackFrame) => void;
}

const HIDE_LIBRARY_FRAMES_KEY = "taomni.codeWorkspace.debugHideLibraryFrames.v1";

function readHideLibraryFrames(): boolean {
  try {
    return window.localStorage.getItem(HIDE_LIBRARY_FRAMES_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * IDEA's Frames view (Threads & Variables tab): a thread combo, the frames of
 * the shown thread as `method:line, Class (package)`, library frames greyed
 * or folded by "Hide Frames from Libraries", keyboard selection, and deep
 * stacks loaded page by page.
 */
export function DebugFramesPane({
  debug,
  activeRunning,
  stopped,
  onOpenFrame,
}: DebugFramesPaneProps) {
  const { state } = debug;
  const canRestartFrame = debug.capabilities.supportsRestartFrame === true;
  const frameMenu = useContextMenu();
  const [hideLibrary, setHideLibrary] = useState(readHideLibraryFrames);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const threadComboRef = useRef<HTMLDivElement>(null);

  const frames = state?.frames ?? [];
  const threads = state?.threads ?? [];
  const shownThreadId = state?.selectedThreadId ?? state?.stoppedThreadId ?? null;
  const shownThread = threads.find((thread) => thread.id === shownThreadId) ?? null;
  const isSuspended = (threadId: number) => stopped && (!!state?.allThreadsStopped || threadId === state?.stoppedThreadId);
  const entries = frameListEntries(frames, hideLibrary);
  const selectedFrameId = state?.selectedFrameId ?? frames[0]?.id ?? null;
  const moreFrames = stopped && state?.framesTotal != null && state.framesTotal > frames.length;

  useEffect(() => {
    if (!threadMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !threadComboRef.current?.contains(event.target)) setThreadMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [threadMenuOpen]);

  const toggleHideLibrary = () => {
    setHideLibrary((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(HIDE_LIBRARY_FRAMES_KEY, String(next));
      } catch {
        // Storage is a convenience; the toggle still applies to this view.
      }
      return next;
    });
  };

  const emptyFramesText = stopped
    ? shownThreadId != null && !isSuspended(shownThreadId)
      ? "Frames not available for unsuspended thread"
      : "No frames"
    : state && state.status !== "terminated"
      ? "Running…"
      : "Frames are not available";

  const selectFrame = useCallback((frame: DebugStackFrame, reveal: boolean) => {
    debug.selectFrame(frame.id);
    if (reveal && (frame.path || frame.sourceReference > 0)) onOpenFrame(frame);
  }, [debug, onOpenFrame]);

  const handleFrameContextMenu = useCallback(
    (e: MouseEvent, frame: DebugStackFrame) => {
      e.preventDefault();
      debug.selectFrame(frame.id);
      const items: MenuItem[] = [];
      if (canRestartFrame && stopped) {
        items.push({
          label: "Reset Frame",
          testId: "debug-frame-menu-restart-frame",
          icon: <RotateCcw className="w-3.5 h-3.5" />,
          onClick: () => debug.restartFrame(frame.id),
        });
      }
      items.push({
        label: "Copy Stack",
        testId: "debug-frame-menu-copy-stack",
        onClick: () => {
          const text = frames.map((f) => `\tat ${stackLineText(f)}`).join("\n");
          void navigator.clipboard.writeText(text || frame.name);
        },
      });
      if (frame.path || frame.sourceReference > 0) {
        items.push({ separator: true, label: "" });
        items.push({
          label: "Jump to Source",
          testId: "debug-frame-menu-jump-source",
          shortcut: "F4",
          onClick: () => onOpenFrame(frame),
        });
      }
      frameMenu.show(e, items);
    },
    [canRestartFrame, stopped, onOpenFrame, debug, frames, frameMenu],
  );

  const visibleFrames = entries.flatMap((entry) => (entry.kind === "frame" ? [entry.frame] : []));
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (visibleFrames.length === 0) return;
    const index = Math.max(0, visibleFrames.findIndex((frame) => frame.id === selectedFrameId));
    let next: DebugStackFrame | undefined;
    if (event.key === "ArrowDown") next = visibleFrames[Math.min(visibleFrames.length - 1, index + 1)];
    else if (event.key === "ArrowUp") next = visibleFrames[Math.max(0, index - 1)];
    else if (event.key === "Home") next = visibleFrames[0];
    else if (event.key === "End") next = visibleFrames[visibleFrames.length - 1];
    else if (event.key === "Enter" || event.key === "F4") {
      event.preventDefault();
      const current = visibleFrames[index];
      if (current) selectFrame(current, true);
      return;
    }
    if (!next) return;
    event.preventDefault();
    // IDEA follows the selected frame in the editor while arrowing.
    selectFrame(next, true);
    listRef.current?.querySelector(`[data-frame-id="${next.id}"]`)?.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <div
      data-testid="debug-frames-pane"
      className="h-full min-h-0 min-w-0 flex flex-col bg-[var(--taomni-code-bg)] text-[11px]"
    >
      {/* Multi-session selector */}
      {debug.sessions.length > 1 && (
        <div className="h-7 shrink-0 flex items-center gap-1.5 border-b border-[var(--taomni-code-border)] bg-[var(--taomni-code-gutter-bg)]/30 px-2">
          <span className="shrink-0 text-[10px] text-[var(--taomni-text-muted)]">Session:</span>
          <select
            data-testid="debug-active-session"
            aria-label="Debug session"
            title="Select compound debug session"
            value={debug.activeSessionId ?? debug.sessions[0].id}
            onChange={(event) => debug.selectSession(event.target.value)}
            className="h-5 min-w-0 flex-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1 text-[10px]"
          >
            {debug.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.label} [{session.status}
                {session.stoppedReason ? `: ${session.stoppedReason}` : ""}]
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Thread combo + frames toolbar */}
      <div className="h-7 shrink-0 flex items-center gap-1 border-b border-[var(--taomni-code-border)] px-1.5">
        <div ref={threadComboRef} className="relative min-w-0 flex-1">
          <button
            type="button"
            data-testid="debug-thread-select"
            aria-haspopup="listbox"
            aria-expanded={threadMenuOpen}
            disabled={threads.length === 0}
            className="flex h-5 w-full min-w-0 items-center gap-1 rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] px-1.5 text-left text-[10px] disabled:opacity-50"
            onClick={() => setThreadMenuOpen((open) => !open)}
          >
            <span className="min-w-0 flex-1 truncate">
              {shownThread
                ? threadLabelText(shownThread, isSuspended(shownThread.id))
                : activeRunning ? "Threads are listed while suspended" : "No threads"}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 text-[var(--taomni-text-muted)]" />
          </button>
          {threadMenuOpen && threads.length > 0 && (
            <div
              role="listbox"
              aria-label="Threads"
              data-testid="debug-thread-list"
              className="absolute left-0 right-0 top-full z-30 mt-0.5 max-h-60 overflow-auto rounded border border-[var(--taomni-code-border)] bg-[var(--taomni-code-bg)] py-0.5 shadow-lg"
            >
              {threads.map((thread) => (
                <div
                  key={thread.id}
                  role="option"
                  aria-selected={thread.id === shownThreadId}
                  data-testid={`debug-thread-${thread.id}`}
                  className={`cursor-default truncate px-2 py-0.5 text-[10px] hover:bg-[var(--taomni-hover-bg)] ${
                    thread.id === shownThreadId ? "bg-[var(--taomni-accent)]/15 font-medium" : ""
                  }`}
                  onClick={() => {
                    setThreadMenuOpen(false);
                    debug.selectThread(thread.id);
                  }}
                >
                  {threadLabelText(thread, isSuspended(thread.id))}
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          data-testid="debug-frames-hide-library"
          aria-pressed={hideLibrary}
          aria-label="Hide Frames from Libraries"
          title="Hide Frames from Libraries"
          className="h-5 w-5 shrink-0 inline-flex items-center justify-center rounded hover:bg-[var(--taomni-hover-bg)] aria-pressed:bg-[var(--taomni-accent)]/20"
          onClick={toggleHideLibrary}
        >
          <Funnel className="h-3 w-3 text-[var(--taomni-text-muted)]" />
        </button>
      </div>

      {/* Exception banner */}
      {state?.exceptionInfo && (
        <div
          data-testid="debug-exception-info"
          className="border-b border-[var(--taomni-code-border)] bg-rose-500/10 px-2.5 py-1.5 shrink-0"
        >
          <div className="font-medium text-rose-600 dark:text-rose-400">
            {state.exceptionInfo.exceptionId}
          </div>
          {state.exceptionInfo.description && (
            <div className="text-[10px] text-rose-600/90 dark:text-rose-400/90">
              {state.exceptionInfo.description}
            </div>
          )}
          {state.exceptionInfo.details && (
            <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap font-mono text-[9px] text-[var(--taomni-text-muted)]">
              {state.exceptionInfo.details}
            </pre>
          )}
        </div>
      )}

      {/* Frames list */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="Frames"
        tabIndex={0}
        data-testid="debug-frames-list"
        className="flex-1 min-h-0 overflow-auto py-0.5 outline-none focus-visible:ring-1 focus-visible:ring-[var(--taomni-accent)]/40"
        onKeyDown={onListKeyDown}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (moreFrames && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) void debug.loadMoreFrames();
        }}
      >
        {frames.length === 0 ? (
          <Empty text={emptyFramesText} />
        ) : (
          entries.map((entry) => {
            if (entry.kind === "folded") {
              return (
                <div
                  key={`folded-${entry.firstId}`}
                  data-testid={`debug-frames-folded-${entry.firstId}`}
                  className="cursor-default select-none px-2 py-0.5 text-[10px] italic text-[var(--taomni-text-muted)] hover:bg-[var(--taomni-hover-bg)]"
                  title="Show frames from libraries"
                  onClick={toggleHideLibrary}
                >
                  {entry.count} hidden {entry.count === 1 ? "frame" : "frames"}
                </div>
              );
            }
            const { frame, library } = entry;
            const selected = frame.id === selectedFrameId;
            return (
              <div
                key={frame.id}
                role="option"
                aria-selected={selected}
                data-testid={`debug-frame-${frame.id}`}
                data-frame-id={frame.id}
                data-library-frame={library ? "true" : undefined}
                className={`flex cursor-default select-none items-center gap-1.5 px-2 py-0.5 ${
                  selected ? "bg-[var(--taomni-accent)]/20" : "hover:bg-[var(--taomni-hover-bg)]"
                }`}
                onClick={() => selectFrame(frame, true)}
                onContextMenu={(e) => handleFrameContextMenu(e, frame)}
                title={stackLineText(frame)}
              >
                <span className={`truncate ${library ? "text-[var(--taomni-text-muted)]" : "text-[var(--taomni-text)]"}`}>
                  {frameLabelText(frame)}
                </span>
              </div>
            );
          })
        )}
        {moreFrames && (
          <button
            type="button"
            data-testid="debug-frames-load-more"
            className="w-full px-2 py-0.5 text-left text-[10px] text-[var(--taomni-accent)] hover:underline"
            onClick={() => void debug.loadMoreFrames()}
          >
            Load more frames…
          </button>
        )}
      </div>

      {frameMenu.render}
    </div>
  );
}
