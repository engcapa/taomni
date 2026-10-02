// Embedded by the opt-in macOS QA bridge. It dispatches WebView events, not OS input.
function dispatchQaActions(sources, emitKey, modifiers, resolveOrigin, targetAtPoint) {
  const states = sources.map(() => ({ x: 0, y: 0, buttons: 0, down: null, dragged: false, clicks: 0, suppressMouse: false }));
  const ticks = Math.max(0, ...sources.map((source) => (source.actions || []).length));
  for (let tick = 0; tick < ticks; tick++) {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const action = source.actions?.[tick];
      if (!action) continue;
      if (source.type === "key") {
        if (action.type === "keyDown" || action.type === "keyUp") emitKey(action.type, action.value);
        continue;
      }
      if (source.type !== "pointer") continue;
      const state = states[index];
      const button = action.button || 0;
      const mask = [1, 4, 2][button] || 0;
      if (action.type === "pointerMove") {
        [state.x, state.y] = resolveOrigin(action.origin, Number(action.x) || 0, Number(action.y) || 0);
        if (state.down && (state.x !== state.down.x || state.y !== state.down.y)) state.dragged = true;
      } else if (action.type === "pointerDown") {
        state.buttons |= mask;
        state.down = { x: state.x, y: state.y };
        state.dragged = false;
      } else if (action.type === "pointerUp") {
        state.buttons &= ~mask;
      } else {
        continue;
      }
      const target = targetAtPoint(state.x, state.y);
      const init = {
        bubbles: true, cancelable: true, clientX: state.x, clientY: state.y,
        button, buttons: state.buttons, detail: action.type === "pointerMove" ? 0 : state.clicks + 1,
        pointerId: index + 1, pointerType: "mouse", isPrimary: true,
        ctrlKey: modifiers.Control, shiftKey: modifiers.Shift, altKey: modifiers.Alt, metaKey: modifiers.Meta,
      };
      if (action.type === "pointerMove") {
        target.dispatchEvent(new PointerEvent("pointermove", init));
        target.dispatchEvent(new MouseEvent("mouseover", init));
        if (!state.suppressMouse) target.dispatchEvent(new MouseEvent("mousemove", init));
      } else if (action.type === "pointerDown") {
        const event = new PointerEvent("pointerdown", init);
        target.dispatchEvent(event);
        state.suppressMouse = event.defaultPrevented;
        if (!state.suppressMouse) target.dispatchEvent(new MouseEvent("mousedown", init));
      } else {
        target.dispatchEvent(new PointerEvent("pointerup", init));
        if (!state.suppressMouse) target.dispatchEvent(new MouseEvent("mouseup", init));
        if (button === 2) {
          target.dispatchEvent(new MouseEvent("contextmenu", init));
        } else if (button === 1 && state.down && !state.dragged) {
          target.dispatchEvent(new MouseEvent("auxclick", init));
        } else if (state.down && !state.dragged) {
          target.dispatchEvent(new MouseEvent("click", init));
          state.clicks++;
          if (state.clicks === 2) target.dispatchEvent(new MouseEvent("dblclick", init));
        }
        state.down = null;
        state.suppressMouse = false;
      }
    }
  }
}
