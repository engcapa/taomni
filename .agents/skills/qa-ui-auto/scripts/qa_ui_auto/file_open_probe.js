(config) => {
  if (window.__QA_FILE_OPEN_PROBE__) throw new Error("File-open probe already installed");
  const requireHighlight = config.require_highlight !== false;
  const state = { event: config.event, started: null, firstContentMs: null,
    firstHighlightMs: null, frames: [], finished: false };
  let handle = null;
  let lastFrame = null;
  function frame() {
    handle = null;
    const now = performance.now();
    const el = document.querySelector('[data-testid="workspace-file-editor"] .cm-content');
    const view = el?.cmTile?.root?.view;
    const text = view?.state.doc.toString();
    const visible = !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const matches = visible && text === config.expected;
    const highlighted = matches && !!el.querySelector(".cm-line span");
    const elapsedMs = now - state.started;
    state.frames.push({ elapsedMs, gapMs: now - lastFrame, matches, highlighted,
      documentChars: view?.state.doc.length ?? null, documentLines: view?.state.doc.lines ?? null });
    lastFrame = now;
    if (matches && state.firstContentMs === null) state.firstContentMs = elapsedMs;
    if (highlighted && state.firstHighlightMs === null) state.firstHighlightMs = elapsedMs;
    const readyMs = requireHighlight ? state.firstHighlightMs : state.firstContentMs;
    if (readyMs !== null && elapsedMs - readyMs >= 1000) {
      state.finished = true;
    } else {
      handle = requestAnimationFrame(frame);
    }
  }
  function input(event) {
    const target = event.target instanceof Element ? event.target.closest(config.selector) : null;
    if (!target || state.started !== null) return;
    state.started = performance.now();
    state.eventTrusted = event.isTrusted;
    lastFrame = state.started;
    handle = requestAnimationFrame(frame);
  }
  document.addEventListener(config.event, input, true);
  window.__QA_FILE_OPEN_PROBE__ = { state, finish: () => {
    document.removeEventListener(config.event, input, true);
    if (handle !== null) cancelAnimationFrame(handle);
    delete window.__QA_FILE_OPEN_PROBE__;
    return state;
  }};
  return true;
}
