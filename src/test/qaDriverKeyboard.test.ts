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
});
