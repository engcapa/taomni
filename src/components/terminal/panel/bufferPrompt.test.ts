import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { terminalAtIdlePrompt } from "./buffer";

const terminals: Terminal[] = [];
const cols = 112;

async function render(output: string) {
  const term = new Terminal({ cols, rows: 16 });
  terminals.push(term);
  await new Promise<void>((resolve) => term.write(output, resolve));
  return term;
}

function prompt(length: number) {
  const prefix = "qa@host:/";
  return `${prefix}${"p".repeat(length - prefix.length - 2)}$ `;
}

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});

describe("idle terminal prompt", () => {
  it.each([cols - 1, cols, cols + 1, cols * 2])(
    "recognizes a %i-cell prompt, including readline's explicit newline at the margin",
    async (length) => {
      // Real Bash/readline emits CR LF CR when the prompt exactly fills the
      // final row, leaving a non-wrapped empty row below the printed space.
      const margin = length % cols === 0;
      const term = await render(`\x1b[?2004h${prompt(length)}${margin ? "\r\n\r" : ""}`);
      if (margin) {
        expect(term.buffer.active.cursorX).toBe(0);
        expect(term.buffer.active.getLine(term.buffer.active.cursorY)?.isWrapped).toBe(false);
      }
      expect(terminalAtIdlePrompt(term)).toBe(true);
    },
  );

  it.each([
    ["blank startup", ""],
    ["a short prompt above a new blank row", "\x1b[?2004hqa@host:~$ \r\n"],
    ["a full output row outside readline", `${prompt(cols)}\r\n\r`],
    ["an extra blank output row", `\x1b[?2004h${prompt(cols)}\r\n\r\n`],
    ["a newline after an unfilled row", `\x1b[?2004h${prompt(cols - 1)}\r\n`],
    ["a typed command on the next row", `\x1b[?2004h${prompt(cols)}\r\n\recho pending`],
    ["a typed command ending in a prompt character", `\x1b[?2004hqa$ ${"x".repeat(cols - 6)}$ \r\n\r`],
    ["the alternate screen", `\x1b[?1049h\x1b[?2004h${prompt(cols)}\r\n\r`],
  ])("does not treat %s as an idle prompt", async (_name, output) => {
    expect(terminalAtIdlePrompt(await render(output))).toBe(false);
  });

  it("requires the margin space to have been printed, rather than padded by the buffer", async () => {
    const term = await render(`\x1b[?2004h${prompt(cols).trimEnd()}\r\n`);
    expect(terminalAtIdlePrompt(term)).toBe(false);
  });
});
