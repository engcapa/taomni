import type { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

interface QaTerminalRendering {
  term: Terminal;
  getAddon: () => WebglAddon | null;
}

type QaGlobal = typeof globalThis & {
  __TAOMNI_QA_TERMINALS__?: Map<HTMLElement, QaTerminalRendering>;
};

/**
 * Isolated QA/dev only. The caller's compile-time guard removes this seam from
 * production. Tests need real renderer references to distinguish intact buffer
 * text from damaged glyph pixels; the normal terminal registry stays unchanged.
 * No input is sent to the backend and no observer runs on the output hot path.
 */
export function registerQaTerminalRendering(
  host: HTMLElement,
  term: Terminal,
  getAddon: () => WebglAddon | null,
): () => void {
  const scope = globalThis as QaGlobal;
  const entries = scope.__TAOMNI_QA_TERMINALS__ ??= new Map();
  const entry = { term, getAddon };
  entries.set(host, entry);
  return () => {
    if (entries.get(host) === entry) entries.delete(host);
    if (entries.size === 0 && scope.__TAOMNI_QA_TERMINALS__ === entries) {
      delete scope.__TAOMNI_QA_TERMINALS__;
    }
  };
}
