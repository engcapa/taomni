import { NOTEPAD_COMMAND_BY_ID } from "../commands/catalog";
import type { RecordedMacroStep } from "../commands/types";
import {
  notepadMacrosAccept,
  notepadMacrosLoad,
  notepadMacrosSave,
  notepadMacrosValidate,
} from "../ipc";

export interface SavedMacroEntry {
  name: string;
  shortcut?: string;
  steps: RecordedMacroStep[];
}

export interface MacroPlaybackHost {
  executeCommand: (commandId: string, args?: Record<string, unknown>) => Promise<void>;
  insertText: (text: string) => void;
  getCursorAndLength: () => { pos: number; length: number };
}

export const MAX_EOF_MACRO_ITERATIONS = 10000;

export function normalizeMacroSteps(
  steps: Array<
    | RecordedMacroStep
    | { type?: "command" | "insertText"; commandId?: string; args?: Record<string, unknown>; text?: string }
  >,
): RecordedMacroStep[] {
  const out: RecordedMacroStep[] = [];
  for (const step of steps) {
    const kind = step.type ?? (typeof step.text === "string" && step.text.length > 0 ? "insertText" : "command");
    if (kind === "insertText" && typeof step.text === "string" && step.text.length > 0) {
      out.push({ type: "insertText", text: step.text });
    } else if (kind === "command" && step.commandId) {
      out.push({ type: "command", commandId: step.commandId, args: step.args });
    }
  }
  return out;
}

export function filterRecordableSteps(
  steps: Array<
    | RecordedMacroStep
    | { type?: "command" | "insertText"; commandId?: string; args?: Record<string, unknown>; text?: string }
  >,
): RecordedMacroStep[] {
  return normalizeMacroSteps(steps).filter((step) => {
    if (step.type === "insertText") return typeof step.text === "string" && step.text.length > 0;
    if (step.type === "command" && step.commandId) {
      return NOTEPAD_COMMAND_BY_ID.get(step.commandId)?.recordable === true;
    }
    return false;
  });
}

export async function runMacroOnce(
  steps: RecordedMacroStep[],
  host: MacroPlaybackHost,
): Promise<void> {
  for (const step of filterRecordableSteps(steps)) {
    if (step.type === "insertText" && step.text) {
      host.insertText(step.text);
    } else if (step.type === "command" && step.commandId) {
      await host.executeCommand(step.commandId, step.args);
    }
  }
}

export async function runMacroMultipleTimes(
  steps: RecordedMacroStep[],
  count: number,
  host: MacroPlaybackHost,
): Promise<{ iterations: number; stoppedReason: "completed" | "eof" | "safety_limit" }> {
  const capped = Math.max(1, Math.min(MAX_EOF_MACRO_ITERATIONS, Math.trunc(count)));
  for (let i = 0; i < capped; i += 1) {
    await runMacroOnce(steps, host);
  }
  return { iterations: capped, stoppedReason: "completed" };
}

export async function runMacroUntilEndOfFile(
  steps: RecordedMacroStep[],
  host: MacroPlaybackHost,
): Promise<{ iterations: number; stoppedReason: "eof" | "no_progress" | "safety_limit" }> {
  const clean = filterRecordableSteps(steps);
  if (clean.length === 0) return { iterations: 0, stoppedReason: "no_progress" };

  let iterations = 0;
  let stalledCount = 0;
  while (iterations < MAX_EOF_MACRO_ITERATIONS) {
    const before = host.getCursorAndLength();
    if (before.pos >= before.length && iterations > 0) {
      return { iterations, stoppedReason: "eof" };
    }
    await runMacroOnce(clean, host);
    iterations += 1;
    const after = host.getCursorAndLength();
    if (after.pos >= after.length) {
      return { iterations, stoppedReason: "eof" };
    }
    if (after.pos === before.pos && after.length === before.length) {
      stalledCount += 1;
      if (stalledCount >= 2) return { iterations, stoppedReason: "no_progress" };
    } else {
      stalledCount = 0;
    }
  }
  return { iterations, stoppedReason: "safety_limit" };
}

export async function loadValidatedMacros(): Promise<{
  macros: SavedMacroEntry[];
  tampered: boolean;
  expectedHash: string;
  actualHash: string;
}> {
  const res = await notepadMacrosLoad();
  const parsed = JSON.parse(res.json) as SavedMacroEntry[];
  return {
    macros: Array.isArray(parsed) ? parsed : [],
    tampered: res.tampered,
    expectedHash: res.expectedHash,
    actualHash: res.actualHash,
  };
}

export async function validateStoredMacros() {
  return notepadMacrosValidate();
}

export async function acceptTamperedMacros() {
  return notepadMacrosAccept();
}

export async function saveMacrosList(macros: SavedMacroEntry[]) {
  return notepadMacrosSave(JSON.stringify(macros, null, 2));
}
