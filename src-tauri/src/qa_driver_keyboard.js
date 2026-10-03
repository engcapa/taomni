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
