import { beforeEach, describe, expect, it, vi } from "vitest";
import keyboardScript from "../../src-tauri/src/qa_driver_keyboard.js?raw";

type Modifiers = { Control: boolean; Shift: boolean; Alt: boolean; Meta: boolean };
const plain: Modifiers = { Control: false, Shift: false, Alt: false, Meta: false };

// Exercise the exact default-action helper embedded in the macOS QA binary.
const applyDefault = new Function("el", "key", "event", "modifiers",
  `${keyboardScript}\nreturn dispatchQaKeyDefault(el, key, event, modifiers);`,
) as (el: HTMLElement, key: string, event: KeyboardEvent, modifiers: Modifiers) => void;

function press(el: HTMLElement, key: string, modifiers = plain) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  applyDefault(el, key, event, modifiers);
}

function formFixture(markup = '<input name="username"><input name="password" type="password"><button type="submit">OK</button>') {
  document.body.innerHTML = `<form>${markup}</form>`;
  const form = document.querySelector("form")!;
  const input = form.querySelector("input")!;
  const submit = vi.fn((event: Event) => event.preventDefault());
  form.addEventListener("submit", submit);
  return { form, input, submit };
}

describe("macOS QA WebView keyboard defaults", () => {
  beforeEach(() => document.body.replaceChildren());

  it("submits a credential form once without changing the password", () => {
    const { form, submit } = formFixture();
    const password = form.querySelector<HTMLInputElement>('[type="password"]')!;
    const input = vi.fn();
    password.value = "qa-secret";
    password.addEventListener("input", input);
    press(password, "Enter");
    expect(submit).toHaveBeenCalledTimes(1);
    expect((submit.mock.calls[0][0] as SubmitEvent).submitter).toBe(form.querySelector("button"));
    expect(password.value).toBe("qa-secret");
    expect(input).not.toHaveBeenCalled();
  });

  it("respects canceled keydown and shortcuts", () => {
    const { input, submit } = formFixture();
    press(input, "Enter", { ...plain, Control: true });
    press(input, "Enter", { ...plain, Meta: true });
    input.addEventListener("keydown", (event) => event.preventDefault());
    press(input, "Enter");
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not bypass a disabled default submit button", () => {
    const { input, submit } = formFixture('<input><button disabled>First</button><button>Second</button>');
    press(input, "Enter");
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("keeps native constraint validation on implicit submission", () => {
    const { input, submit } = formFixture('<input required><button>OK</button>');
    press(input, "Enter");
    expect(submit).not.toHaveBeenCalled();
    input.value = "ready";
    press(input, "Enter");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("uses an externally associated submit button", () => {
    const { form, input, submit } = formFixture('<input>');
    form.id = "qa-form";
    const button = document.createElement("button");
    button.setAttribute("form", "qa-form");
    document.body.append(button);
    const click = vi.fn();
    button.addEventListener("click", click);
    press(input, "Enter");
    expect(click).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("submits a lone input without a button but leaves multiple inputs alone", () => {
    const single = formFixture('<input>');
    press(single.input, "Enter");
    expect(single.submit).toHaveBeenCalledTimes(1);
    const multiple = formFixture('<input><input type="password">');
    press(multiple.input, "Enter");
    expect(multiple.submit).not.toHaveBeenCalled();
    expect(multiple.input.value).toBe("");
  });

  it("inserts a real line break in a textarea and keeps printable editing", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.value = "ab";
    textarea.setSelectionRange(1, 2);
    const input = vi.fn();
    textarea.addEventListener("input", input);
    press(textarea, "Enter");
    press(textarea, "c");
    expect(textarea.value).toBe("a\nc");
    expect(input).toHaveBeenCalledTimes(2);
  });

  it("leaves a standalone single-line input and read-only text unchanged", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.value = "ab";
    press(input, "Enter");
    input.readOnly = true;
    press(input, "c");
    expect(input.value).toBe("ab");
  });

  it("does not submit a form from Enter on a checkbox", () => {
    const { input, submit } = formFixture('<input type="checkbox"><button>OK</button>');
    press(input, "Enter");
    expect(input.checked).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("moves an input caret before inserting without appending to the end", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.value = "Caret 中文 https://example.com/title";
    press(input, "ArrowLeft");
    press(input, "!");
    expect(input.value).toBe("Caret 中文 https://example.com/titl!e");
  });

  it("moves to the textarea document boundary and edits the selected position", () => {
    const input = document.createElement("textarea");
    document.body.append(input);
    input.value = "第一行\n第三行 XYZ";
    input.setSelectionRange(0, 0);
    press(input, "End", { ...plain, Meta: true });
    press(input, "ArrowLeft");
    press(input, "ArrowLeft");
    press(input, "ArrowLeft");
    press(input, "!");
    expect(input.value).toBe("第一行\n第三行 !XYZ");
    press(input, "Home", { ...plain, Control: true });
    expect(input.selectionStart).toBe(0);
  });

  it("collapses ranges toward the arrow and extends a selection in either direction", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.value = "abcd";
    input.setSelectionRange(1, 3);
    press(input, "ArrowRight");
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3]);
    input.setSelectionRange(1, 3);
    press(input, "ArrowLeft");
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
    press(input, "ArrowLeft", { ...plain, Shift: true });
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([0, 1, "backward"]);
    press(input, "ArrowRight", { ...plain, Shift: true });
    press(input, "ArrowRight", { ...plain, Shift: true });
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([1, 2, "forward"]);
  });

  it("keeps surrogate pairs intact and does not emit input events for navigation", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.value = "中😀";
    const changed = vi.fn();
    input.addEventListener("input", changed);
    press(input, "ArrowLeft");
    expect(input.selectionStart).toBe(1);
    press(input, "ArrowRight");
    expect(input.selectionStart).toBe(3);
    expect(changed).not.toHaveBeenCalled();
  });

  it("respects canceled navigation, disabled fields and unsupported modified arrows", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.value = "abc";
    input.disabled = true;
    press(input, "ArrowLeft");
    input.disabled = false;
    press(input, "ArrowLeft", { ...plain, Alt: true });
    input.addEventListener("keydown", (event) => event.preventDefault());
    press(input, "Home");
    expect(input.selectionStart).toBe(3);
    expect(input.value).toBe("abc");
  });
});
