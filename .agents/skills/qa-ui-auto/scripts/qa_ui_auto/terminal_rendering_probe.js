// Controlled fixture for TC-TERM-RENDER-001, run only in the isolated QA page.
// `action` is supplied by terminal_rendering_probe.py; no backend input is sent.
const entries = [...(globalThis.__TAOMNI_QA_TERMINALS__?.values() ?? [])];
if (entries.length !== 3) throw Error(`Expected three real terminals, got ${entries.length}`);
const atlas = entry => entry.getAddon()?._renderer?._charAtlas;
const header = "REF-0123456789 中文字形 ┌─┐";
const state = globalThis.__QA_ATLAS_PROBE__;
const result = extra => ({
  headers: entries.slice(1).map(entry => entry.term.buffer.active.getLine(0)?.translateToString(true)),
  cells: entries.slice(1).map(entry => {
    const rect = entry.term.element.querySelector(".xterm-screen").getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width * 30 / entry.term.cols,
      height: rect.height / entry.term.rows };
  }),
  sessions: [...(globalThis.__taomni_terminal_registry__?.entries?.values() ?? [])].map(entry => entry.sessionId),
  shared: !!atlas(entries[0]) && entries.every(entry => atlas(entry) === atlas(entries[0])),
  ...extra,
});
const write = (entry, data) => {
  state.pending++;
  entry.term.write(data, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => state.pending--));
  });
};
const flood = (cells, offset) => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let data = "\x1b[2;1H";
  for (let i = 0; i < cells; i++) {
    data += `\x1b[38;5;${(offset + i) % 256}m\x1b[48;5;${(offset + i * 7) % 256}m${letters[(offset + i) % letters.length]}`;
    if ((i + 1) % 30 === 0) data += "\x1b[0m\r\n";
  }
  return data + "\x1b[0m";
};
if (action === "prepare") {
  if (state) throw Error("Atlas probe already installed");
  if (!result().shared) throw Error("Three terminals must share a real WebGL atlas");
  const shared = atlas(entries[0]);
  globalThis.__QA_ATLAS_PROBE__ = {
    pending: 0, terms: entries.map(entry => entry.term), shared,
    maxPages: shared.constructor.maxAtlasPages, maxSize: shared.constructor.maxTextureSize,
    textureSize: shared._textureSize, removals: 0,
    removalListener: shared.onRemoveTextureAtlasCanvas(() => globalThis.__QA_ATLAS_PROBE__.removals++),
  };
  // Entering/leaving the alternate buffer preserves the real shell's history.
  for (const [index, entry] of entries.entries()) {
    const data = "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H" + (index ? header : "ATLAS-WRITER");
    globalThis.__QA_ATLAS_PROBE__.pending++;
    entry.term.write(data, () => requestAnimationFrame(() => requestAnimationFrame(() => {
      globalThis.__QA_ATLAS_PROBE__.pending--;
    })));
  }
  return result({ pending: 3 });
}
if (!state) throw Error("Atlas probe is not installed");
if (action === "observe") return result({ pending: state.pending,
  sameTerms: entries.every((entry, index) => entry.term === state.terms[index]),
  pages: state.shared.pages.map(page => page.canvas.width), removals: state.removals,
});
if (action === "clear") {
  entries[0].getAddon().clearTextureAtlas();
  write(entries[0], flood(300, 71));
  return result({ pending: state.pending });
}
if (action === "repaint-siblings") {
  // Change the last row only. Full refreshes/resizes would hide stale vertices.
  for (const entry of entries.slice(1)) write(entry, `\x1b[${entry.term.rows};1Hx`);
  return result({ pending: state.pending });
}
if (action === "merge") {
  state.shared.constructor.maxAtlasPages = 4;
  state.shared.constructor.maxTextureSize = 2048;
  // Bound the fixture workload, not product limits: new pages are small enough
  // to merge in a hosted software WebGL context within a few hundred glyphs.
  state.shared._textureSize = 128;
  write(entries[0], flood(300, iteration * 300));
  return result({ pending: state.pending });
}
if (action === "cleanup") {
  state.shared.constructor.maxAtlasPages = state.maxPages;
  state.shared.constructor.maxTextureSize = state.maxSize;
  state.shared._textureSize = state.textureSize;
  state.removalListener.dispose();
  for (const entry of entries) entry.term.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  delete globalThis.__QA_ATLAS_PROBE__;
  return true;
}
throw Error(`Unknown atlas probe action: ${action}`);
