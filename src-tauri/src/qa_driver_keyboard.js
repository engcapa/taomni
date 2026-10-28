// Embedded by the opt-in macOS QA bridge. Untrusted key events do not run
// browser editing or implicit form submission, so mirror those defaults here.
function normalizeQaWebDriverKey(value) {
  return ({
    '\uE003':'Backspace',
    '\uE004':'Tab','\uE007':'Enter','\uE008':'Shift','\uE009':'Control',
    '\uE00A':'Alt','\uE00B':'Pause','\uE00C':'Escape','\uE00D':' ',
    '\uE00E':'PageUp','\uE00F':'PageDown','\uE010':'End','\uE011':'Home',
    '\uE012':'ArrowLeft','\uE013':'ArrowUp','\uE014':'ArrowRight','\uE015':'ArrowDown',
    '\uE016':'Insert','\uE017':'Delete',
    '\uE031':'F1','\uE032':'F2','\uE033':'F3','\uE034':'F4','\uE035':'F5','\uE036':'F6',
    '\uE037':'F7','\uE038':'F8','\uE039':'F9','\uE03A':'F10','\uE03B':'F11','\uE03C':'F12',
    '\uE03D':'Meta'
  })[value] || value;
}

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

// Default button activation for constructed WKWebView keyboard events.
// These are WebView actions, not physical macOS keyboard input.
function createQaButtonKeyboard() {
  let spaceTarget = null;
  return (el, type, key, event, modifiers) => {
    const unmodified = !modifiers.Control && !modifiers.Meta && !modifiers.Alt;
    const enabled = el instanceof HTMLButtonElement && !el.disabled && document.activeElement === el;
    if (type === "keydown" && key === " ") {
      spaceTarget = enabled && unmodified && !event.defaultPrevented ? el : null;
    } else if (type === "keyup" && key === " ") {
      const target = spaceTarget;
      spaceTarget = null;
      if (target === el && enabled && unmodified && !event.defaultPrevented) el.click();
    } else if (type === "keydown" && key === "Enter" && enabled && unmodified && !event.defaultPrevented) {
      el.click();
    }
  };
}
