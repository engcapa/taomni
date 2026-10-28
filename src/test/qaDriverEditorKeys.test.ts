import { EditorSelection, EditorState } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import keyboardScript from "../../src-tauri/src/qa_driver_keyboard.js?raw";

const normalize = new Function(`${keyboardScript}\nreturn normalizeQaWebDriverKey;`)() as (value: string) => string;
let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
});

function editor(text: string, anchor: number, head = anchor) {
  const parent = document.createElement("div");
  document.body.append(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      selection: EditorSelection.single(anchor, head),
      extensions: [keymap.of(defaultKeymap)],
    }),
  });
  view.focus();
  return view;
}

function press(view: EditorView, value: string, keyCode: number) {
  const event = new KeyboardEvent("keydown", {
    key: normalize(value), bubbles: true, cancelable: true,
  });
  Object.defineProperty(event, "keyCode", { value: keyCode });
  Object.defineProperty(event, "which", { value: keyCode });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe("macOS QA WebDriver editing key translation", () => {
  it("clears a selected real CodeMirror document with W3C Backspace", () => {
    const current = editor("public class Main {}", 0, 20);
    const event = press(current, "\uE003", 8);
    expect(event.key).toBe("Backspace");
    expect(event.defaultPrevented).toBe(true);
    expect(current.state.doc.toString()).toBe("");
    expect(current.contentDOM.textContent).toBe("");
  });

  it("deletes one preceding character and preserves named Delete", () => {
    const current = editor("abc", 2);
    press(current, "\uE003", 8);
    expect(current.state.doc.toString()).toBe("ac");
    press(current, "\uE017", 46);
    expect(current.state.doc.toString()).toBe("a");
    expect(current.contentDOM.textContent).not.toContain("\uE003");
  });

  it("preserves printable characters and other existing WebDriver key names", () => {
    expect(["x", " ", "\uE007", "\uE012", "\uE03D", "\uE031"].map(normalize))
      .toEqual(["x", " ", "Enter", "ArrowLeft", "Meta", "F1"]);
  });
});
