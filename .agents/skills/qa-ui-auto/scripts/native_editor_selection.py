"""Opt-in, bounded transaction observations around a native select-all chord.

Observe the existing EditorView.update call without dispatching transactions,
flushing DOM changes, focusing, changing selection, or delaying input.
"""

EDITOR_SELECTION_HOOK_SCRIPT = r"""
(() => {
  let enabled = false;
  try { enabled = localStorage.getItem('taomni.qa.resizeTrace.v1') === '1'; } catch (_) {}
  if (!enabled || window.__QA_UI_AUTO_WATCH_SELECTION__) return;
  const watched = new WeakSet();
  let probe = null;
  const selection = view => {
    const main = view.state.selection.main;
    return {anchor: main.anchor, head: main.head, documentChars: view.state.doc.length};
  };
  window.__QA_UI_AUTO_WATCH_SELECTION__ = (editor, observation) => {
    const view = editor?.cmTile?.root?.view;
    if (!view || typeof view.update !== 'function') return;
    observation.transactions = [];
    probe = {view, observation};
    if (watched.has(view)) return;
    watched.add(view);
    const original = view.update;
    view.update = function(transactions) {
      const current = probe?.view === this ? probe.observation : null;
      let sample = null;
      try {
        if (current && current.transactions.length < 24 && current.followingInput.length < 3) {
          sample = {
            time: performance.now(), before: selection(this),
            stack: new Error('Editor selection transaction').stack?.slice(0, 5000) ?? '',
            transactions: transactions.map(transaction => ({
              selection: transaction.selection ? {
                anchor: transaction.selection.main.anchor, head: transaction.selection.main.head
              } : null,
              docChanged: transaction.docChanged,
              userEvents: ['select', 'select.pointer', 'input', 'input.type', 'delete', 'undo', 'redo']
                .filter(event => transaction.isUserEvent(event))
            }))
          };
        }
      } catch (_) {} // Diagnostic failures must not change the real update.
      try {
        return original.apply(this, arguments);
      } finally {
        if (sample) {
          try {
            sample.after = selection(this);
            current.transactions.push(sample);
          } catch (_) {}
        }
      }
    };
  };
})();
"""
