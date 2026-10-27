"""Document-owned native console, focus and editor input observations.

Installed idempotently after navigation; the document owns listeners and releases
them on reload. Keep diagnostics independent from product code and UI state.
"""

from native_resize_observer import RESIZE_OBSERVER_HOOK_SCRIPT

CONSOLE_HOOK_SCRIPT = RESIZE_OBSERVER_HOOK_SCRIPT + r"""
if (!window.__QA_UI_AUTO_CONSOLE__) {
  window.__QA_UI_AUTO_CONSOLE__ = [];
  // Keep focus transitions without recording typed text or values.
  window.__QA_UI_AUTO_FOCUS__ = [];
  const describeFocus = el => ({
    tag: el?.tagName ?? null,
    testid: el?.getAttribute?.('data-testid') ?? null,
    role: el?.getAttribute?.('role') ?? null
  });
  for (const type of ['focusin', 'focusout', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'contextmenu']) {
    document.addEventListener(type, event => {
      window.__QA_UI_AUTO_FOCUS__.push({
        type, time: performance.now(), trusted: event.isTrusted,
        button: event.button ?? null,
        x: event.clientX ?? null, y: event.clientY ?? null,
        target: describeFocus(event.target),
        related: describeFocus(event.relatedTarget),
        active: describeFocus(document.activeElement),
        document_has_focus: document.hasFocus()
      });
      if (window.__QA_UI_AUTO_FOCUS__.length > 64) window.__QA_UI_AUTO_FOCUS__.shift();
    }, true);
  }
  // Observe shortcut delivery at the window before surface input handlers.
  // Keep physical codes and modifier state, never ordinary typed characters
  // or control values. Consumed chords may stop before this listener, while
  // their modifier transitions still distinguish lost native input/focus.
  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, event => {
      const modifier = /^(Control|Shift|Alt|Meta)$/.test(event.key);
      if (!modifier && !event.ctrlKey && !event.metaKey && !event.altKey) return;
      window.__QA_UI_AUTO_FOCUS__.push({
        type, time: performance.now(), trusted: event.isTrusted,
        code: event.code, ctrl: event.ctrlKey, shift: event.shiftKey,
        alt: event.altKey, meta: event.metaKey, repeat: event.repeat,
        composing: event.isComposing, prevented: event.defaultPrevented,
        target: describeFocus(event.target),
        active: describeFocus(document.activeElement),
        document_has_focus: document.hasFocus()
      });
      if (window.__QA_UI_AUTO_FOCUS__.length > 64) window.__QA_UI_AUTO_FOCUS__.shift();
    }, true);
  }
  // Bounded editor-only input history distinguishes driver ordering
  // from caret changes during async editor updates. Never inspect form
  // controls (in particular password fields), or modify input/selection.
  window.__QA_UI_AUTO_EDITOR_INPUT__ = [];
  for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'selectionchange']) {
    document.addEventListener(type, event => {
      const editor = document.activeElement?.closest?.('.cm-content');
      if (!editor || (type !== 'selectionchange' && !editor.contains(event.target))) return;
      const selection = document.getSelection();
      const describeEndpoint = (node, offset) => {
        if (!node || !editor.contains(node)) return null;
        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return {
          offset, nodeText: node.textContent?.slice(0, 200) ?? null,
          lineText: element?.closest?.('.cm-line')?.textContent?.slice(0, 200) ?? null
        };
      };
      const events = window.__QA_UI_AUTO_EDITOR_INPUT__;
      events.push({
        type, time: performance.now(), trusted: event.isTrusted,
        key: event.key ?? null, data: event.data ?? null,
        inputType: event.inputType ?? null,
        anchor: describeEndpoint(selection?.anchorNode, selection?.anchorOffset),
        focus: describeEndpoint(selection?.focusNode, selection?.focusOffset)
      });
      if (events.length > 128) events.shift();
    }, true);
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level] ? console[level].bind(console) : console.log.bind(console);
    console[level] = (...args) => {
      try {
        window.__QA_UI_AUTO_CONSOLE__.push({
          level,
          time: new Date().toISOString(),
          args: args.map((arg) => {
            try {
              if (arg instanceof Error) return arg.stack || arg.message;
              if (typeof arg === 'string') return arg;
              return JSON.stringify(arg);
            } catch (_) {
              return String(arg);
            }
          })
        });
      } catch (_) {}
      return original(...args);
    };
  }
  window.addEventListener('error', (event) => {
    window.__QA_UI_AUTO_CONSOLE__.push({
      kind: 'uncaught-error',
      level: 'error',
      time: new Date().toISOString(),
      args: [event.message, event.filename, event.lineno, event.colno],
      ...(/ResizeObserver/.test(event.message) && window.__QA_UI_AUTO_RESIZE_TRACE__ ? {
        resizeObservers: {
          created: window.__QA_UI_AUTO_RESIZE_TRACE__.created,
          samples: window.__QA_UI_AUTO_RESIZE_TRACE__.samples.slice()
        }
      } : {})
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__QA_UI_AUTO_CONSOLE__.push({
      kind: 'unhandled-rejection',
      level: 'error',
      time: new Date().toISOString(),
      args: ['unhandledrejection', String(event.reason)]
    });
  });
}
return true;
"""
