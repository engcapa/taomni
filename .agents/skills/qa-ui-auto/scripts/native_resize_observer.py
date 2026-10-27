"""Opt-in, passive ResizeObserver provenance for native WebView failures.

No extra layout reads, scheduling changes, DOM writes or exception suppression.
The document owns the wrapper and bounded, DOM-reference-free observations.
"""

RESIZE_OBSERVER_HOOK_SCRIPT = r"""
(() => {
  let enabled = false;
  try { enabled = localStorage.getItem('taomni.qa.resizeTrace.v1') === '1'; } catch (_) {}
  if (!enabled || window.__QA_UI_AUTO_RESIZE_TRACE__ || typeof ResizeObserver !== 'function') return;
  const NativeObserver = window.ResizeObserver;
  const trace = { created: 0, samples: [] };
  window.__QA_UI_AUTO_RESIZE_TRACE__ = trace;
  const describe = element => {
    const path = [];
    for (let current = element; current && path.length < 6; current = current.parentElement) {
      path.push({
        tag: current.tagName,
        id: current.id || null,
        testid: current.getAttribute('data-testid'),
        class: current.getAttribute('class')?.slice(0, 300) ?? null
      });
    }
    return path;
  };
  window.ResizeObserver = class extends NativeObserver {
    constructor(callback) {
      if (typeof callback !== 'function') {
        super(callback);
        return;
      }
      const id = ++trace.created;
      const stack = new Error('ResizeObserver creation').stack?.slice(0, 4000) ?? '';
      super(function(entries, observer) {
        try {
          trace.samples.push({
            id, stack, time: performance.now(),
            entries: entries.slice(0, 12).map(entry => ({
              width: entry.contentRect.width, height: entry.contentRect.height,
              target: describe(entry.target)
            }))
          });
          if (trace.samples.length > 64) trace.samples.shift();
        } catch (_) {} // Diagnostics must not change callback delivery.
        return callback.call(this, entries, observer);
      });
    }
  };
})();
"""
