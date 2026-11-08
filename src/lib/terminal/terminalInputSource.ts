import type { Terminal } from "@xterm/xterm";

export type TerminalInputSource = "user" | "terminal-response";

/**
 * xterm's onData includes both input and automatic terminal replies. Observe
 * query parsing without replacing xterm's handlers: replies are emitted in the
 * same parser turn, before another keyboard/paste/touch event can run.
 *
 * Do not identify replies by their bytes. A cursor report can be identical to
 * a modified function key; that key must retain desktop takeover semantics.
 */
export function observeTerminalInput(
  term: Pick<Terminal, "parser" | "onData">,
  input: (data: string, source: TerminalInputSource) => void,
): () => void {
  let responding = false;
  const query = () => {
    responding = true;
    queueMicrotask(() => { responding = false; });
    return false;
  };
  const parser = term.parser;
  const disposables = [
    parser.registerCsiHandler({ final: "n" }, query),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, query),
    parser.registerCsiHandler({ final: "c" }, query),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, query),
    parser.registerCsiHandler({ intermediates: "$", final: "p" }, query),
    parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, query),
    parser.registerCsiHandler({ final: "t" }, query),
    parser.registerEscHandler({ final: "Z" }, query),
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, query),
    ...[4, 10, 11, 12].map(id => parser.registerOscHandler(id, query)),
    term.onData(data => input(data, responding ? "terminal-response" : "user")),
  ];
  return () => { disposables.forEach(disposable => disposable.dispose()); };
}
