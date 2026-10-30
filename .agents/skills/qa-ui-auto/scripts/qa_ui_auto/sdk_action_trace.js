(owner) => {
  if (window.__QA_SDK_ACTION_TRACE__) throw new Error("SDK action trace already installed");
  const state = { installedEpochMs: Date.now(), inputs: [], frames: [], documents: [], heartbeatFrames: [] };
  const cleanups = [];
  let pendingFrame = null;
  const inputFrames = new Set();
  let previous = null;
  let previousFrameMs = performance.now();
  let heartbeatFrame;
  function heartbeat() {
    const nowMs = performance.now();
    state.heartbeatFrames.push({ epochMs: Date.now(), nowMs, gapMs: nowMs - previousFrameMs });
    previousFrameMs = nowMs;
    heartbeatFrame = requestAnimationFrame(heartbeat);
  }
  heartbeatFrame = requestAnimationFrame(heartbeat);
  function snapshot() {
    const el = document.querySelector('[data-testid="workspace-file-editor"] .cm-content');
    const view = el?.cmTile?.root?.view;
    const text = view?.state.doc.toString() ?? el?.textContent ?? null;
    return { epochMs: Date.now(), nowMs: performance.now(), text, dom: el?.textContent ?? null,
      caret: view?.state.selection.main.head ?? null,
      language: el?.getAttribute("data-language") ?? null };
  }
  function recordDocument() {
    const next = snapshot();
    const signature = JSON.stringify([next.text, next.dom, next.caret, next.language]);
    if (signature !== previous) {
      previous = signature;
      state.documents.push(next);
    }
  }
  function schedule() {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      recordDocument();
    });
  }
  function input(event) {
    const el = event.target instanceof Element ? event.target.closest("[data-testid]") : null;
    state.inputs.push({ type: event.type, testid: el?.getAttribute("data-testid") ?? null,
      epochMs: Date.now(), nowMs: performance.now() });
    const started = performance.now();
    const handle = requestAnimationFrame(() => {
      inputFrames.delete(handle);
      state.frames.push({ type: event.type, elapsedMs: performance.now() - started, ...snapshot() });
    });
    inputFrames.add(handle);
  }
  for (const name of ["pointerdown", "pointerup", "click", "dblclick"]) {
    document.addEventListener(name, input, true);
    cleanups.push(() => document.removeEventListener(name, input, true));
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  cleanups.push(() => observer.disconnect());
  recordDocument();
  window.__QA_SDK_ACTION_TRACE__ = { owner, finish: () => {
    cancelAnimationFrame(heartbeatFrame);
    for (const cleanup of cleanups) cleanup();
    if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
    state.pendingInputFrames = inputFrames.size;
    for (const handle of inputFrames) cancelAnimationFrame(handle);
    recordDocument();
    delete window.__QA_SDK_ACTION_TRACE__;
    return state;
  }};
  return true;
}
