import { Terminal } from "@xterm/headless";
import { afterEach, expect, it } from "vitest";
import { observeTerminalInput, type TerminalInputSource } from "./terminalInputSource";

let term: Terminal | undefined;
afterEach(() => term?.dispose());

it("tags cursor/device/status replies from the actual parser, while escape keys and pasted reply-shaped bytes stay user input", async () => {
  term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const received: { data: string; source: TerminalInputSource }[] = [];
  const dispose = observeTerminalInput(term, (data, source) => received.push({ data, source }));
  await new Promise<void>(resolve => term!.write("\x1b[6n\x1b[c\x1b[5n\x1bP$qm\x1b\\", resolve));
  expect(received).toEqual([
    { data: "\x1b[1;1R", source: "terminal-response" },
    { data: "\x1b[?1;2c", source: "terminal-response" },
    { data: "\x1b[0n", source: "terminal-response" },
    { data: "\x1bP1$r0m\x1b\\", source: "terminal-response" },
  ]);
  received.length = 0;
  for (const data of ["\x1b[A", "\x1b", "\x1b[1;2R", "\x1b[200~pasted\x1b[201~", "中文"]) term.input(data, true);
  expect(received.every(value => value.source === "user")).toBe(true);
  expect(received).toHaveLength(5);
  dispose();
  term.input("ignored", true);
  expect(received).toHaveLength(5);
});

it("keeps parsing split queries and disposes the query markers with their input subscription", async () => {
  term = new Terminal({ allowProposedApi: true });
  const received: string[] = [];
  const dispose = observeTerminalInput(term, (_data, source) => received.push(source));
  await new Promise<void>(resolve => term!.write("\x1b[", resolve));
  term.input("key", true);
  await new Promise<void>(resolve => term!.write("6n", resolve));
  expect(received).toEqual(["user", "terminal-response"]);
  dispose();
  await new Promise<void>(resolve => term!.write("\x1b[6n", resolve));
  expect(received).toHaveLength(2);
});
