// Embedded by the opt-in macOS QA bridge. Untrusted key events do not run
// browser editing or implicit form submission, so mirror those defaults here.
function dispatchQaKeyDefault(el, key, event, modifiers) {
  if (event.defaultPrevented || modifiers.Control || modifiers.Meta || modifiers.Alt ||
      ["Control", "Shift", "Alt", "Meta"].includes(key)) return;
  if (el.isContentEditable) {
    if (key === "Enter") document.execCommand("insertParagraph", false, null);
    else if (key === "Backspace") document.execCommand("delete", false, null);
    else if (key === "Delete") document.execCommand("forwardDelete", false, null);
    else if (key.length === 1) document.execCommand("insertText", false, key);
    return;
  }
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  if (key === "Enter" && el instanceof HTMLInputElement) {
    const blockingTypes = ["text", "search", "tel", "url", "email", "password",
      "date", "month", "week", "time", "datetime-local", "number"];
    if (!blockingTypes.includes(el.type)) return;
    const form = el.form;
    if (!form) return;
    // The first associated submit button is the default, even if disabled.
    const submitter = Array.from(document.querySelectorAll("button, input")).find((control) =>
      control.form === form && (control.type === "submit" || control.type === "image"));
    if (submitter) {
      submitter.click();
    } else {
      const blockingInputs = Array.from(form.elements).filter((control) =>
        control instanceof HTMLInputElement && blockingTypes.includes(control.type));
      if (blockingInputs.length <= 1) form.requestSubmit();
    }
    return;
  }
  if (el.disabled || el.readOnly || (key.length !== 1 && key !== "Enter")) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const insert = key === "Enter" ? "\n" : key;
  el.setRangeText(insert, start, end, "end");
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: insert }));
}
