"""Forward same-origin iframe runtime errors into the native assertion log.

Listeners never consume events or inject code into message documents. Each
loaded document owns its listeners; a WeakSet permits later iframe navigation.
"""

FRAME_RUNTIME_ERROR_HOOK_SCRIPT = r"""
if (!window.__QA_UI_AUTO_FRAME_ERRORS__) {
  window.__QA_UI_AUTO_FRAME_ERRORS__ = true;
  const observed = new WeakSet();
  const attachFrameErrors = frame => {
    try {
      const doc = frame.contentDocument;
      const view = doc?.defaultView;
      if (!view || observed.has(doc)) return;
      observed.add(doc);
      view.addEventListener('error', event => {
        window.__QA_UI_AUTO_CONSOLE__.push({
          kind: 'uncaught-error', level: 'error', frame: true,
          time: new Date().toISOString(),
          args: [event.message, event.filename, event.lineno, event.colno]
        });
      });
      view.addEventListener('unhandledrejection', event => {
        window.__QA_UI_AUTO_CONSOLE__.push({
          kind: 'unhandled-rejection', level: 'error', frame: true,
          time: new Date().toISOString(),
          args: ['unhandledrejection', String(event.reason)]
        });
      });
    } catch (_) { /* Cross-origin frames are not readable. */ }
  };
  document.addEventListener('load', event => {
    if (event.target?.tagName === 'IFRAME') attachFrameErrors(event.target);
  }, true);
  for (const frame of document.querySelectorAll?.('iframe') ?? []) attachFrameErrors(frame);
}
"""
