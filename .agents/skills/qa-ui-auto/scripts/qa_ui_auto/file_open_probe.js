(config) => {
  if (window.__QA_FILE_OPEN_PROBE__) throw new Error("File-open probe already installed");
  const requireHighlight = config.require_highlight !== false;
  const state = { event: config.event, started: null, firstContentMs: null,
    firstHighlightMs: null, frames: [], storageWrites: [], finished: false, editorReused: null };
  let initialView = null;
  let handle = null;
  let lastFrame = null;
  function frame() {
    handle = null;
    const now = performance.now();
    const el = document.querySelector('[data-testid="workspace-file-editor"] .cm-content');
    const view = el?.cmTile?.root?.view;
    if (!view || view !== initialView) state.editorReused = false;
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
    if (typeof event.button === "number" && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target.closest(config.selector) : null;
    if (!target || state.started !== null) return;
    state.started = performance.now();
    state.triggerEvent = event.type;
    initialView = document.querySelector('[data-testid="workspace-file-editor"] .cm-content')?.cmTile?.root?.view ?? null;
    state.editorReused = initialView !== null;
    state.eventTrusted = event.isTrusted;
    lastFrame = state.started;
    handle = requestAnimationFrame(frame);
  }
  // Selection handlers run before dblclick. Include the initial pointer down
  // so a slow first click cannot disappear outside the observation window.
  const observedEvents = ["pointerdown", "mousedown", config.event];
  for (const event of observedEvents) document.addEventListener(event, input, true);
  const storage = window.Storage?.prototype;
  const originalSetItem = storage?.setItem;
  function timedSetItem(...args) {
    const begin = performance.now();
    try { return Reflect.apply(originalSetItem, this, args); }
    finally {
      if (state.started !== null) state.storageWrites.push({
        key: String(args[0]).slice(0, 128), valueChars: typeof args[1] === "string" ? args[1].length : null,
        elapsedMs: begin - state.started, durationMs: performance.now() - begin,
      });
    }
  }
  if (storage && originalSetItem) storage.setItem = timedSetItem;
  window.__QA_FILE_OPEN_PROBE__ = { state, finish: () => {
    for (const event of observedEvents) document.removeEventListener(event, input, true);
    if (storage?.setItem === timedSetItem) storage.setItem = originalSetItem;
    if (handle !== null) cancelAnimationFrame(handle);
    delete window.__QA_FILE_OPEN_PROBE__;
    return state;
  }};
  return true;
}
