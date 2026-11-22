import { describe, expect, it } from "vitest";
import {
  filterRecordableSteps,
  normalizeMacroSteps,
  runMacroMultipleTimes,
  runMacroUntilEndOfFile,
  type MacroPlaybackHost,
} from "./macroManager";
import type { RecordedMacroStep } from "../commands/types";

function createMockHost(initialText: string) {
  let text = initialText;
  let pos = 0;
  const host: MacroPlaybackHost = {
    async executeCommand(commandId) {
      if (commandId === "edit.toUpper") {
        text = text.toUpperCase();
        pos = text.length;
      } else if (commandId === "edit.duplicateLine") {
        // Advance forward step by step to simulate cursor progress
        const nextNl = text.indexOf("\n", pos);
        pos = nextNl >= 0 ? nextNl + 1 : text.length;
      }
    },
    insertText(chunk) {
      text = text.slice(0, pos) + chunk + text.slice(pos);
      pos += chunk.length;
    },
    getCursorAndLength() {
      return { pos, length: text.length };
    },
  };
  return { host, getText: () => text, getPos: () => pos };
}

describe("notepad macro manager (V-34..V-36)", () => {
  it("filters out non-recordable commands per DEC-07 whitelist and replays multiple times", async () => {
    const mixed: RecordedMacroStep[] = [
      { type: "command", commandId: "file.save" },
      { type: "command", commandId: "file.openTerminalDir" },
      { type: "insertText", text: "!" },
    ];
    const clean = filterRecordableSteps(mixed);
    expect(clean).toEqual([{ type: "insertText", text: "!" }]);

    const { host, getText } = createMockHost("hi");
    const res = await runMacroMultipleTimes(mixed, 3, host);
    expect(res.iterations).toBe(3);
    expect(getText()).toBe("!!!hi");
  });

  it("stops run-until-EOF both upon reaching EOF and when a no-progress macro stalls", async () => {
    const stepping = createMockHost("line1\nline2\nline3");
    const eofRes = await runMacroUntilEndOfFile(
      [{ type: "command", commandId: "edit.duplicateLine" }],
      stepping.host,
    );
    expect(eofRes.stoppedReason).toBe("eof");
    expect(eofRes.iterations).toBe(3);

    const stalled = createMockHost("abc");
    const stallRes = await runMacroUntilEndOfFile(
      [{ type: "command", commandId: "edit.copy" }],
      stalled.host,
    );
    expect(stallRes.stoppedReason).toBe("no_progress");
    expect(stallRes.iterations).toBe(2);

    const normalized = normalizeMacroSteps([
      { commandId: "edit.toUpper" },
      { type: "insertText", text: "ok" },
    ]);
    expect(normalized).toEqual([
      { type: "command", commandId: "edit.toUpper", args: undefined },
      { type: "insertText", text: "ok" },
    ]);
  });
});
