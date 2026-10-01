import { StateField, type Extension, type Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  hoverTooltip,
  keymap,
  WidgetType,
  type Tooltip,
} from "@codemirror/view";
import { hoverExpressionAt, inlineValueLabel, type DebugStepAction } from "./dapDebugModel";
import { variableValueText } from "./debugBreakpointProperties";

/**
 * Debug editor chrome (M9 D3): a breakpoint gutter (click a line to toggle), a
 * "current execution line" highlight when the adapter is stopped, IDEA-style
 * inline variable values, hover evaluation, and the debugger keymap. Rendered as
 * a reconfigurable extension so the host swaps it via a compartment, mirroring
 * the Git gutter pattern. Everything here is language-agnostic — it renders DAP
 * state, never Java specifics.
 */

/** A breakpoint marker for the gutter; `conditional` styles it distinctly (D5). */
export interface DebugBreakpointMarker {
  line: number; // 1-based
  conditional: boolean;
  /** Logpoint (logs instead of breaking) — IDEA's non-suspending breakpoint. */
  logpoint?: boolean;
  /** False when the adapter could not bind the line (IDEA's invalid breakpoint). */
  verified?: boolean;
  /** False for a breakpoint the user disabled or muted (hollow, not armed). */
  enabled?: boolean;
  /** IDEA "Suspend" unchecked: rendered as the amber non-suspending dot. */
  suspend?: boolean;
  /** IDEA "Mute Breakpoints": greyed while muted. */
  muted?: boolean;
  /** Waits for another breakpoint (IDEA dependent breakpoint). */
  dependent?: boolean;
  /** Remove once hit. */
  temporary?: boolean;
  /** Bound by a live session (IDEA's check mark). */
  bound?: boolean;
  /** Multi-line IDEA tooltip; a generic title is used when absent. */
  tooltip?: string;
}

/** Screen point a breakpoint popup is anchored at (the clicked gutter row). */
export interface DebugGutterAnchor {
  x: number;
  y: number;
}

/**
 * Debugger actions the editor keymap and gutter drive. The session-dependent
 * ones return whether they handled the key, so the binding stays transparent
 * when no session is running.
 */
export interface DebugEditorActions {
  toggleBreakpoint: (line: number) => void;
  editBreakpoint: (line: number, anchor?: DebugGutterAnchor) => void;
  /** IDEA middle-click: enable/disable without removing. */
  toggleBreakpointEnabled?: (line: number) => void;
  /** IDEA Alt+click (temporary) and Shift+click (non-suspending logging). */
  addBreakpoint?: (line: number, kind: "temporary" | "logging", anchor?: DebugGutterAnchor) => void;
  /** Right-click on a line without a breakpoint: IDEA's Add Breakpoint menu. */
  openGutterMenu?: (line: number, anchor: DebugGutterAnchor) => void;
  step?: (action: DebugStepAction) => boolean;
  runToCursor?: (line: number) => boolean;
  stop?: () => boolean;
}

export interface DebugEditorChromeOptions {
  markers: DebugBreakpointMarker[];
  /** 1-based line to highlight as the current execution point, or null. */
  currentLine: number | null;
  actions: DebugEditorActions;
  /** Selected-frame locals as `name → value`; drives inline values. */
  inlineValues?: Record<string, string>;
  /**
   * Evaluate an expression for a hover tooltip. Present only while stopped in
   * this file; resolves to null when the expression has no value.
   */
  evaluate?: ((expression: string) => Promise<{ value: string; type: string | null } | null>) | null;
}

function markerState(marker: DebugBreakpointMarker): "enabled" | "disabled" | "muted" | "invalid" {
  if (marker.enabled === false && !marker.muted) return "disabled";
  if (marker.muted) return "muted";
  if (marker.verified === false) return "invalid";
  return "enabled";
}

function markerTitle(marker: DebugBreakpointMarker): string {
  if (marker.tooltip) return marker.tooltip;
  const state = markerState(marker);
  if (state === "disabled") return "Breakpoint disabled";
  if (state === "muted") return "Breakpoints muted";
  if (state === "invalid") return "Breakpoint not bound (line not executable or class not loaded yet)";
  if (marker.logpoint || marker.suspend === false) return "Logpoint (non-suspending breakpoint)";
  return marker.conditional ? "Conditional breakpoint" : "Breakpoint";
}

class BreakpointGutterMarker extends GutterMarker {
  constructor(
    private readonly marker: DebugBreakpointMarker | null,
    private readonly executionPoint = false,
    /** 1-based line; 0 for the width spacer. */
    private readonly line = 0,
  ) {
    super();
  }

  override eq(other: BreakpointGutterMarker): boolean {
    return other.executionPoint === this.executionPoint
      && other.line === this.line
      && JSON.stringify(other.marker) === JSON.stringify(this.marker);
  }

  override toDOM(): Node {
    const cell = document.createElement("span");
    cell.className = "taomni-bp-cell";
    // Every visible line gets a cell: IDEA previews a translucent breakpoint
    // under the pointer, and the line number keeps rows addressable.
    if (this.line > 0) cell.dataset.bpGutterLine = String(this.line);
    const marker = this.marker;
    if (!marker && !this.executionPoint && this.line > 0) cell.classList.add("taomni-bp-promoter");
    if (marker) {
      const dot = document.createElement("span");
      const kind = marker.logpoint || marker.suspend === false ? "no-suspend" : "suspend";
      const state = markerState(marker);
      dot.className = "taomni-bp";
      dot.dataset.bpKind = kind;
      dot.dataset.bpState = state;
      if (marker.conditional) dot.dataset.bpConditional = "true";
      if (marker.dependent) dot.dataset.bpDependent = "true";
      if (marker.temporary) dot.dataset.bpTemporary = "true";
      if (marker.bound && state === "enabled") dot.dataset.bpBound = "true";
      dot.title = markerTitle(marker);
      if (marker.conditional) dot.textContent = "?";
      else if (state === "invalid") dot.textContent = "\u00d7";
      else if (marker.bound && state === "enabled") dot.textContent = "\u2713";
      cell.append(dot);
    }
    if (this.executionPoint) {
      const arrow = document.createElement("span");
      arrow.className = "taomni-debug-exec-arrow";
      arrow.title = "Execution point";
      arrow.textContent = "\u279c";
      cell.append(arrow);
    }
    return cell;
  }
}

function gutterAnchor(event: Event): DebugGutterAnchor {
  const target = event.target instanceof Element ? event.target.closest(".cm-gutterElement") : null;
  const rect = target?.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) return { x: rect.left, y: rect.bottom };
  const mouse = event as MouseEvent;
  return { x: mouse.clientX ?? 0, y: mouse.clientY ?? 0 };
}

/**
 * Build the debug chrome extension for the current session state. Optional
 * pieces (inline values, hover evaluation) are only installed when the caller
 * supplies the data, so a file with no live session pays for nothing but the
 * gutter.
 */
export function createDebugEditorChrome(options: DebugEditorChromeOptions): Extension {
  const { markers, currentLine, actions } = options;
  const byLine = new Map(markers.map((m) => [m.line, m]));
  const extensions: Extension[] = [
    gutter({
      class: "taomni-debug-gutter",
      lineMarker: (view, lineBlock) => {
        const line = view.state.doc.lineAt(lineBlock.from).number;
        const marker = byLine.get(line) ?? null;
        return new BreakpointGutterMarker(marker, currentLine === line, line);
      },
      initialSpacer: () => new BreakpointGutterMarker(null),
      domEventHandlers: {
        mousedown: (view, lineBlock, event) => {
          const line = view.state.doc.lineAt(lineBlock.from).number;
          const mouse = event as MouseEvent;
          const marker = byLine.get(line);
          // IDEA gutter mouse model: middle-click disables, right-click edits
          // (handled by `contextmenu`, which also covers macOS Ctrl+click),
          // Alt+click adds a temporary breakpoint, Shift+click a logging one.
          if (mouse.button === 1) {
            mouse.preventDefault();
            if (marker) actions.toggleBreakpointEnabled?.(line);
            return true;
          }
          if (mouse.button !== 0 || mouse.ctrlKey || mouse.metaKey) return true;
          if (mouse.altKey && !marker && actions.addBreakpoint) {
            actions.addBreakpoint(line, "temporary");
          } else if (mouse.shiftKey && marker) {
            actions.editBreakpoint(line, gutterAnchor(event));
          } else if (mouse.shiftKey && actions.addBreakpoint) {
            actions.addBreakpoint(line, "logging", gutterAnchor(event));
          } else {
            actions.toggleBreakpoint(line);
          }
          return true;
        },
        contextmenu: (view, lineBlock, event) => {
          event.preventDefault();
          const line = view.state.doc.lineAt(lineBlock.from).number;
          const anchor = gutterAnchor(event);
          if (!byLine.has(line) && actions.openGutterMenu) actions.openGutterMenu(line, anchor);
          else actions.editBreakpoint(line, anchor);
          return true;
        },
        auxclick: (_view, _lineBlock, event) => {
          // Keep the X11 middle-click paste out of the editor.
          if ((event as MouseEvent).button === 1) event.preventDefault();
          return true;
        },
      },
    }),
    debuggerKeymap(actions),
    breakpointChromeTheme,
  ];
  const breakpointLines = markers
    .filter((marker) => markerState(marker) === "enabled" && marker.line !== currentLine)
    .map((marker) => marker.line);
  if (breakpointLines.length > 0) extensions.push(breakpointLineHighlight(breakpointLines));
  if (currentLine != null) {
    extensions.push(currentLineHighlight(currentLine));
  }
  if (options.inlineValues && Object.keys(options.inlineValues).length > 0 && currentLine != null) {
    extensions.push(inlineValueChrome(options.inlineValues, currentLine));
  }
  if (options.evaluate) {
    extensions.push(debugHoverEvaluation(options.evaluate));
  }
  return extensions;
}

/** IDEA new-UI breakpoint icons, drawn with CSS so they follow the theme. */
const breakpointChromeTheme = EditorView.baseTheme({
  ".taomni-debug-gutter .cm-gutterElement": { cursor: "default" },
  ".taomni-bp-promoter:hover::after": {
    content: "''",
    width: "11px",
    height: "11px",
    borderRadius: "50%",
    backgroundColor: "rgba(229, 87, 101, 0.35)",
  },
  ".taomni-bp-cell": {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    verticalAlign: "middle",
  },
  ".taomni-bp": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "11px",
    height: "11px",
    borderRadius: "50%",
    boxSizing: "border-box",
    backgroundColor: "#e55765",
    border: "1.5px solid #e55765",
    color: "#ffffff",
    fontSize: "8px",
    fontWeight: "700",
    lineHeight: "1",
    fontFamily: "system-ui, sans-serif",
  },
  ".taomni-bp[data-bp-kind='no-suspend']": { backgroundColor: "#f2b93b", borderColor: "#f2b93b" },
  ".taomni-bp[data-bp-state='disabled']": { backgroundColor: "transparent", color: "#e55765" },
  ".taomni-bp[data-bp-kind='no-suspend'][data-bp-state='disabled']": { color: "#f2b93b" },
  ".taomni-bp[data-bp-state='muted']": { backgroundColor: "#a8adbd", borderColor: "#a8adbd" },
  ".taomni-bp[data-bp-state='invalid']": { backgroundColor: "transparent", color: "#e55765" },
  ".taomni-bp[data-bp-dependent='true']": { boxShadow: "0 0 0 1.5px rgba(229, 87, 101, 0.35)" },
  ".taomni-debug-exec-arrow": {
    position: "absolute",
    inset: "0",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#3574f0",
    fontSize: "12px",
    fontWeight: "700",
    textShadow: "0 0 2px var(--taomni-code-bg, #fff)",
  },
});

/**
 * IDEA's debugger keys. Bound at default precedence — CodeMirror's standard
 * keymaps claim none of these — and inert when no session is running, so the
 * same extension serves an idle editor.
 */
function debuggerKeymap(actions: DebugEditorActions): Extension {
  const stepWith = (action: DebugStepAction) => () => actions.step?.(action) ?? false;
  return keymap.of([
    { key: "F9", run: stepWith("continue") },
    { key: "F8", run: stepWith("stepOver") },
    { key: "F7", run: stepWith("stepIn") },
    { key: "Shift-F8", run: stepWith("stepOut") },
    {
      key: "Ctrl-F8",
      run: (view) => {
        actions.toggleBreakpoint(view.state.doc.lineAt(view.state.selection.main.head).number);
        return true;
      },
    },
    {
      key: "Ctrl-Shift-F8",
      run: (view) => {
        const head = view.state.selection.main.head;
        const coords = view.coordsAtPos(head);
        actions.editBreakpoint(
          view.state.doc.lineAt(head).number,
          coords ? { x: coords.left, y: coords.bottom } : undefined,
        );
        return true;
      },
    },
    {
      key: "Alt-F9",
      run: (view) => actions.runToCursor?.(
        view.state.doc.lineAt(view.state.selection.main.head).number,
      ) ?? false,
    },
    { key: "Ctrl-F2", run: () => actions.stop?.() ?? false },
  ]);
}

const currentLineDecoration = Decoration.line({ class: "taomni-debug-current-line" });

/** A static line-background highlight on the 1-based `line` (clamped to doc). */
function currentLineHighlight(line: number): Extension {
  const field = StateField.define({
    create: (state) => decorationFor(state.doc, line),
    update: (value, tr) => (tr.docChanged ? decorationFor(tr.state.doc, line) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    EditorView.baseTheme({
      // IDEA's execution point is a blue line (Default/Darcula schemes).
      "&light .taomni-debug-current-line": { backgroundColor: "rgba(53, 116, 240, 0.2)" },
      "&dark .taomni-debug-current-line": { backgroundColor: "rgba(53, 116, 240, 0.32)" },
    }),
  ];
}

function decorationFor(doc: Text, line: number) {
  if (line < 1 || line > doc.lines) return Decoration.none;
  const lineInfo = doc.line(line);
  return Decoration.set([currentLineDecoration.range(lineInfo.from)]);
}

const breakpointLineDecoration = Decoration.line({ class: "taomni-debug-breakpoint-line" });

/** IDEA's "Breakpoint line" background on every armed breakpoint line. */
function breakpointLineHighlight(lines: number[]): Extension {
  const build = (doc: Text) => Decoration.set(
    lines
      .filter((line) => line >= 1 && line <= doc.lines)
      .sort((a, b) => a - b)
      .map((line) => breakpointLineDecoration.range(doc.line(line).from)),
  );
  const field = StateField.define({
    create: (state) => build(state.doc),
    update: (value, tr) => (tr.docChanged ? build(tr.state.doc) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    EditorView.baseTheme({
      "&light .taomni-debug-breakpoint-line": { backgroundColor: "rgba(229, 87, 101, 0.12)" },
      "&dark .taomni-debug-breakpoint-line": { backgroundColor: "rgba(229, 87, 101, 0.18)" },
    }),
  ];
}

/** End-of-line widget showing `name: value` pairs (IDEA inline values). */
class InlineValueWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: InlineValueWidget): boolean {
    return other.label === this.label;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "taomni-debug-inline-value";
    span.textContent = `  ${this.label}`;
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Inline values for the stopped frame, rendered at the end of each line that
 * mentions a local. Only lines up to the current execution point get them —
 * code that has not run yet has no values to show, which is what IDEA does.
 */
function inlineValueChrome(variables: Record<string, string>, currentLine: number): Extension {
  const build = (doc: Text) => {
    const decorations = [];
    const last = Math.min(currentLine, doc.lines);
    // Bound the scan so a huge file cannot cost more than a screenful of work.
    const first = Math.max(1, last - 500);
    for (let line = first; line <= last; line += 1) {
      const info = doc.line(line);
      const label = inlineValueLabel(info.text, variables);
      if (!label) continue;
      decorations.push(
        Decoration.widget({ widget: new InlineValueWidget(label), side: 1 }).range(info.to),
      );
    }
    return Decoration.set(decorations);
  };
  const field = StateField.define({
    create: (state) => build(state.doc),
    update: (value, tr) => (tr.docChanged ? build(tr.state.doc) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  return [
    field,
    EditorView.baseTheme({
      ".taomni-debug-inline-value": {
        color: "#9ca3af",
        fontStyle: "italic",
        opacity: "0.9",
        pointerEvents: "none",
      },
    }),
  ];
}

/**
 * Hover a variable while stopped to see its value (IDEA's inspect-on-hover).
 * The expression under the pointer is extracted syntax-free so this works for
 * every language the DAP framework serves.
 */
function debugHoverEvaluation(
  evaluate: (expression: string) => Promise<{ value: string; type: string | null } | null>,
): Extension {
  return hoverTooltip((view, pos): Promise<Tooltip | null> => {
    const line = view.state.doc.lineAt(pos);
    const expression = hoverExpressionAt(line.text, pos - line.from);
    if (!expression) return Promise.resolve(null);
    return evaluate(expression).then((result) => {
      if (!result) return null;
      return {
        pos,
        above: true,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-lsp-hover taomni-debug-hover";
          const name = document.createElement("span");
          name.className = "taomni-debug-hover-expr";
          name.textContent = expression;
          const value = document.createElement("span");
          value.textContent = ` = ${variableValueText(result.value)}`;
          dom.append(name, value);
          if (result.type) {
            const type = document.createElement("div");
            type.className = "taomni-debug-hover-type";
            type.textContent = result.type;
            dom.append(type);
          }
          return { dom };
        },
      };
    });
  });
}
