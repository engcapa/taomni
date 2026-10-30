() => {
  if (window.__QA_WORKSPACE_STAGE_TRACE__) throw new Error("Workspace stage trace already installed");
  const events = [], restores = [];
  const record = (label, start, stack) => {
    const durationMs = performance.now() - start;
    if (durationMs >= 2) events.push({ label, startMs: start, epochMs: performance.timeOrigin + start, durationMs, stack });
  };
  function wrap(owner, name) {
    const original = owner[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      const start = performance.now();
      try { return Reflect.apply(original, this, args); }
      finally { record(name, start, new Error().stack); }
    };
    owner[name] = wrapped;
    restores.push(() => { if (owner[name] === wrapped) owner[name] = original; });
  }
  for (const name of ["requestAnimationFrame", "setTimeout"]) {
    const original = window[name];
    const wrapped = function (callback, ...args) {
      if (typeof callback !== "function") return Reflect.apply(original, this, [callback, ...args]);
      const stack = new Error().stack;
      return Reflect.apply(original, this, [function (...values) {
        const start = performance.now();
        try { return Reflect.apply(callback, this, values); }
        finally { record(name, start, stack); }
      }, ...args]);
    };
    window[name] = wrapped;
    restores.push(() => { if (window[name] === wrapped) window[name] = original; });
  }
  for (const [owner, names] of [
    [HTMLElement.prototype, ["focus"]],
    [Element.prototype, ["getBoundingClientRect", "getClientRects"]],
    [window, ["getComputedStyle"]],
  ]) for (const name of names) wrap(owner, name);
  for (const [owner, names] of [
    [Element.prototype, ["scrollTop", "scrollLeft", "scrollWidth", "scrollHeight", "clientWidth", "clientHeight"]],
    [HTMLElement.prototype, ["offsetWidth", "offsetHeight"]],
  ]) for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (!descriptor?.configurable) continue;
    const wrapped = { ...descriptor };
    for (const operation of ["get", "set"]) if (descriptor[operation]) {
      wrapped[operation] = function (...args) {
        const start = performance.now();
        try { return Reflect.apply(descriptor[operation], this, args); }
        finally { record(name + ":" + operation, start, new Error().stack); }
      };
    }
    Object.defineProperty(owner, name, wrapped);
    restores.push(() => Object.defineProperty(owner, name, descriptor));
  }
  const view = document.querySelector('[data-testid="workspace-file-editor"] .cm-content')?.cmTile?.root?.view;
  if (view) {
    for (const name of ["setState", "update", "measure", "dispatch"]) wrap(Object.getPrototypeOf(view), name);
    wrap(view.state.constructor, "create");
  }
  window.__QA_WORKSPACE_STAGE_TRACE__ = { finish: () => {
    restores.reverse().forEach(restore => restore());
    delete window.__QA_WORKSPACE_STAGE_TRACE__;
    return events;
  } };
  return true;
}
