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
  const nodes = new WeakMap();
  let nextNode = 0;
  let probe = null;
  const node = value => {
    if (!value) return null;
    if (!nodes.has(value)) nodes.set(value, ++nextNode);
    return {
      id: nodes.get(value), type: value.nodeType, name: value.nodeName,
      class: value.nodeType === 1 ? value.getAttribute('class') : null,
      connected: value.isConnected, parent: value.parentNode ? value.parentNode.nodeName : null
    };
  };
  const domSelection = view => {
    const range = view.root?.getSelection?.() ?? document.getSelection();
    return range ? {
      anchor: node(range.anchorNode), anchorOffset: range.anchorOffset,
      focus: node(range.focusNode), focusOffset: range.focusOffset,
      collapsed: range.isCollapsed, selectedChars: range.toString().length
    } : null;
  };
  const selection = view => {
    const main = view.state.selection.main;
    return {anchor: main.anchor, head: main.head, documentChars: view.state.doc.length};
  };
  window.__QA_UI_AUTO_WATCH_SELECTION__ = (editor, observation) => {
    const view = editor?.cmTile?.root?.view;
    if (!view || typeof view.update !== 'function') return;
    observation.transactions = [];
    observation.domChanges = [];
    probe = {view, observation};
    if (watched.has(view)) return;
    watched.add(view);
    // A separate observer never consumes records from CodeMirror's observer.
    // No geometry reads, writes, flushes or input scheduling changes.
    const mutations = new MutationObserver(records => {
      const current = probe?.view === view ? probe.observation : null;
      if (!current || current.domChanges.length >= 24 || current.followingInput.length >= 3) return;
      try {
        current.domChanges.push({
          time: performance.now(), selection: domSelection(view),
          records: records.slice(0, 16).map(record => ({
            type: record.type, target: node(record.target), attribute: record.attributeName,
            added: Array.from(record.addedNodes).slice(0, 6).map(node),
            removed: Array.from(record.removedNodes).slice(0, 6).map(node)
          }))
        });
      } catch (_) {}
    });
    mutations.observe(editor, {subtree: true, childList: true, characterData: true, attributes: true});
    const destroy = view.destroy;
    view.destroy = function() {
      mutations.disconnect();
      if (probe?.view === this) probe = null;
      return destroy.apply(this, arguments);
    };
    const original = view.update;
    view.update = function(transactions) {
      const current = probe?.view === this ? probe.observation : null;
      let sample = null;
      try {
        if (current && current.transactions.length < 24 && current.followingInput.length < 3) {
          sample = {
            time: performance.now(), before: selection(this), domBefore: domSelection(this),
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
            sample.domAfter = domSelection(this);
            current.transactions.push(sample);
          } catch (_) {}
        }
      }
    };
  };
})();
"""
