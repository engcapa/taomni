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
  // Independent observer: records synchronous writes performed by each actual
  // RO callback without reading layout or consuming a product observer queue.
  let mutations = null;
  try {
    if (typeof MutationObserver === 'function' && document.documentElement) {
      mutations = new MutationObserver(() => {});
      mutations.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, attributeOldValue: true,
        attributeFilter: ['style', 'class', 'hidden', 'data-variant']
      });
    }
  } catch (_) {}
  window.ResizeObserver = class extends NativeObserver {
    constructor(callback) {
      if (typeof callback !== 'function') {
        super(callback);
        return;
      }
      const id = ++trace.created;
      const stack = new Error('ResizeObserver creation').stack?.slice(0, 4000) ?? '';
      super(function(entries, observer) {
        let sample = null;
        try {
          mutations?.takeRecords();
          sample = {
            id, stack, time: performance.now(),
            entries: entries.slice(0, 12).map(entry => ({
              width: entry.contentRect.width, height: entry.contentRect.height,
              target: describe(entry.target)
            }))
          };
          trace.samples.push(sample);
          if (trace.samples.length > 64) trace.samples.shift();
        } catch (_) {} // Diagnostics must not change callback delivery.
        try {
          return callback.call(this, entries, observer);
        } finally {
          try {
            const records = mutations?.takeRecords() ?? [];
            if (sample) {
              sample.end = performance.now();
              sample.writes = records.slice(0, 16).map(record => ({
                target: describe(record.target), type: record.type,
                attribute: record.attributeName,
                before: record.oldValue?.slice(0, 700) ?? null,
                after: record.attributeName ? record.target.getAttribute(record.attributeName)?.slice(0, 700) ?? null : null,
                added: record.addedNodes?.length ?? 0, removed: record.removedNodes?.length ?? 0
              }));
              sample.writeCount = records.length;
            }
          } catch (_) {}
        }
      });
    }
  };
})();
"""
