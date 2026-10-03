import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebugEditorChrome, type DebugEditorActions } from "./debugEditorChrome";
import type { DebugStepAction } from "./dapDebugModel";

const DOC = [
  "class App {",
  "  void run() {",
  "    int sum = 0;",
  "    sum += 1;",
  "  }",
  "}",
].join("\n");

let view: EditorView | null = null;

function mount(
  options: Partial<Parameters<typeof createDebugEditorChrome>[0]> & { actions: DebugEditorActions },
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: DOC,
      extensions: [createDebugEditorChrome({ markers: [], currentLine: null, ...options })],
    }),
  });
  return view;
}

/** Drive a key through the editor's keymap the way the browser would. */
function press(target: EditorView, key: string, modifiers: Partial<KeyboardEvent> = {}): void {
  target.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true, ...modifiers,
  }));
}

function noopActions(overrides: Partial<DebugEditorActions> = {}): DebugEditorActions {
  return { toggleBreakpoint: vi.fn(), editBreakpoint: vi.fn(), ...overrides };
}

describe("debugEditorChrome", () => {
  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = "";
  });

  it("binds IDEA's stepping keys to the session", () => {
    const actions: DebugStepAction[] = [];
    const editor = mount({
      actions: noopActions({ step: (action) => { actions.push(action); return true; } }),
    });
    press(editor, "F9");
    press(editor, "F8");
    press(editor, "F7");
    press(editor, "F8", { shiftKey: true });
    expect(actions).toEqual(["continue", "stepOver", "stepIn", "stepOut"]);
  });

  it("toggles and edits a breakpoint on the caret line via the keyboard", () => {
    const toggleBreakpoint = vi.fn();
    const editBreakpoint = vi.fn();
    const editor = mount({ actions: noopActions({ toggleBreakpoint, editBreakpoint }) });
    // Put the caret on line 4 ("sum += 1;").
    editor.dispatch({ selection: { anchor: editor.state.doc.line(4).from } });
    press(editor, "F8", { ctrlKey: true });
    expect(toggleBreakpoint).toHaveBeenCalledWith(4);
    press(editor, "F8", { ctrlKey: true, shiftKey: true });
    // The second argument anchors the popup at the caret when layout exists.
    expect(editBreakpoint.mock.calls[0]?.[0]).toBe(4);
  });

  it("runs to the caret line and stops the session", () => {
    const runToCursor = vi.fn(() => true);
    const stop = vi.fn(() => true);
    const editor = mount({ actions: noopActions({ runToCursor, stop }) });
    editor.dispatch({ selection: { anchor: editor.state.doc.line(3).from } });
    press(editor, "F9", { altKey: true });
    expect(runToCursor).toHaveBeenCalledWith(3);
    press(editor, "F2", { ctrlKey: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves the stepping keys alone when no session is running", () => {
    // No `step`/`stop` action: the keys must not be swallowed by the debugger.
    const editor = mount({ actions: noopActions() });
    const event = new KeyboardEvent("keydown", { key: "F8", bubbles: true, cancelable: true });
    editor.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders breakpoint state in the gutter", () => {
    const editor = mount({
      markers: [
        { line: 2, conditional: false },
        { line: 3, conditional: true },
        { line: 4, conditional: false, logpoint: true },
        { line: 5, conditional: false, enabled: false },
        { line: 6, conditional: false, verified: false },
      ],
      currentLine: null,
      actions: noopActions(),
    });
    const dots = [...editor.dom.querySelectorAll<HTMLElement>(".taomni-debug-gutter .taomni-bp")]
      .map((el) => `${el.dataset.bpKind}:${el.dataset.bpState}:${el.textContent}`);
    // Red = suspending, amber = non-suspending, hollow = disabled, × = unbound.
    expect(dots).toEqual([
      "suspend:enabled:",
      "suspend:enabled:?",
      "no-suspend:enabled:",
      "suspend:disabled:",
      "suspend:invalid:\u00d7",
    ]);
    const disabled = [...editor.dom.querySelectorAll<HTMLElement>(".taomni-bp")]
      .find((el) => el.title === "Breakpoint disabled");
    expect(disabled).toBeTruthy();
    // IDEA paints armed breakpoint lines.
    expect(editor.dom.querySelectorAll(".taomni-debug-breakpoint-line")).toHaveLength(3);
  });

  it("follows IDEA's gutter mouse model", () => {
    const toggleBreakpoint = vi.fn();
    const editBreakpoint = vi.fn();
    const toggleBreakpointEnabled = vi.fn();
    const addBreakpoint = vi.fn();
    const openGutterMenu = vi.fn();
    const editor = mount({
      markers: [{ line: 2, conditional: false }],
      actions: noopActions({ toggleBreakpoint, editBreakpoint, toggleBreakpointEnabled, addBreakpoint, openGutterMenu }),
    });
    // CodeMirror resolves the gutter line from the pointer height, so the
    // events target the gutter at each line's (estimated) vertical centre.
    const gutterEl = editor.dom.querySelector<HTMLElement>(".taomni-debug-gutter")!;
    const lineHeight = editor.defaultLineHeight;
    const row = (line: number) => ({ line });
    const mouse = (target: { line: number }, type: string, init: MouseEventInit) => {
      gutterEl.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientY: (target.line - 1) * lineHeight + lineHeight / 2,
        ...init,
      }));
    };
    mouse(row(2), "mousedown", { button: 1 });
    expect(toggleBreakpointEnabled).toHaveBeenCalledWith(2);
    mouse(row(3), "mousedown", { button: 0, altKey: true });
    expect(addBreakpoint).toHaveBeenCalledWith(3, "temporary");
    mouse(row(4), "mousedown", { button: 0, shiftKey: true });
    expect(addBreakpoint).toHaveBeenCalledWith(4, "logging", expect.any(Object));
    mouse(row(2), "contextmenu", { button: 2 });
    expect(editBreakpoint).toHaveBeenCalledWith(2, expect.any(Object));
    mouse(row(5), "contextmenu", { button: 2 });
    expect(openGutterMenu).toHaveBeenCalledWith(5, expect.any(Object));
    mouse(row(2), "mousedown", { button: 0 });
    expect(toggleBreakpoint).toHaveBeenCalledWith(2);
  });

  it("marks the execution point with IDEA's arrow and blue line", () => {
    const editor = mount({ markers: [{ line: 3, conditional: false }], currentLine: 3, actions: noopActions() });
    expect(editor.dom.querySelectorAll(".taomni-debug-exec-arrow")).toHaveLength(1);
    expect(editor.dom.querySelectorAll(".taomni-debug-current-line")).toHaveLength(1);
    // The execution line color wins over the breakpoint line.
    expect(editor.dom.querySelectorAll(".taomni-debug-breakpoint-line")).toHaveLength(0);
  });

  it("shows inline values up to the stopped line only", () => {
    const editor = mount({
      markers: [],
      currentLine: 3,
      inlineValues: { sum: "0" },
      actions: noopActions(),
    });
    const labels = [...editor.dom.querySelectorAll(".taomni-debug-inline-value")]
      .map((el) => el.textContent?.trim());
    // Line 3 declares `sum`; line 4 also mentions it but has not executed yet.
    expect(labels).toEqual(["sum: 0"]);
  });

  it("adds no inline values without a stopped location", () => {
    const editor = mount({
      markers: [],
      currentLine: null,
      inlineValues: { sum: "0" },
      actions: noopActions(),
    });
    expect(editor.dom.querySelectorAll(".taomni-debug-inline-value")).toHaveLength(0);
  });
});
