import { beforeEach, describe, expect, it, vi } from "vitest";

const clipboardMocks = vi.hoisted(() => ({
  readPasteText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("../../../lib/clipboard", async (original) => ({
  ...(await original<typeof import("../../../lib/clipboard")>()),
  readPasteText: clipboardMocks.readPasteText,
  writeText: clipboardMocks.writeText,
}));

import { createCoreCommandMap } from "./coreCommands";
import type { NotepadActionContext } from "./context";
import { useNotepadStore } from "../../../stores/notepadStore";

interface FakeView {
  state: {
    doc: { length: number; lineAt: (pos: number) => { from: number; to: number; number: number; text: string }; toString: () => string; sliceDoc: (from: number, to: number) => string };
    selection: { main: { from: number; to: number; empty: boolean } };
    sliceDoc: (from: number, to: number) => string;
  };
  dispatch: (spec: { changes?: { from: number; to: number; insert: string }; selection?: { anchor: number } }) => void;
}

/** Minimal CodeMirror view surface used by the paste/copy/cut handlers. */
function makeView(text: string, selection: { from: number; to: number }): { view: FakeView; dispatches: unknown[]; content: () => string } {
  let content = text;
  const dispatches: unknown[] = [];
  const view: FakeView = {
    state: {
      doc: {
        get length() { return content.length; },
        lineAt: () => ({ from: 0, to: content.length, number: 1, text: content }),
        toString: () => content,
        sliceDoc: (from, to) => content.slice(from, to),
      },
      selection: { main: { ...selection, empty: selection.from === selection.to } },
      sliceDoc: (from, to) => content.slice(from, to),
    },
    dispatch: (spec) => {
      dispatches.push(spec);
      if (spec.changes) {
        content = content.slice(0, spec.changes.from) + spec.changes.insert + content.slice(spec.changes.to);
      }
    },
  };
  return { view, dispatches, content: () => content };
}

function makeContext(view: FakeView | null, overrides: Partial<NotepadActionContext> = {}): { ctx: NotepadActionContext; errors: string[] } {
  const errors: string[] = [];
  const ctx = {
    getActiveView: () => view,
    effectiveReadOnly: false,
    onError: (message: string) => errors.push(message),
    document: { path: "/tmp/demo.txt", content: "" },
    docKey: "/tmp/demo.txt",
    ...overrides,
  } as unknown as NotepadActionContext;
  return { ctx, errors };
}

async function execute(ctx: NotepadActionContext, commandId: string): Promise<void> {
  const handler = createCoreCommandMap(ctx)[commandId];
  expect(handler).toBeTypeOf("function");
  await handler(undefined);
}

beforeEach(() => {
  clipboardMocks.readPasteText.mockReset();
  clipboardMocks.writeText.mockReset().mockResolvedValue(undefined);
  useNotepadStore.setState({ clipboardHistory: [] });
});

describe("notepad clipboard commands", () => {
  it("inserts the clipboard text read through the shared webview/native fallback path", async () => {
    const { view, dispatches, content } = makeView("abc", { from: 3, to: 3 });
    clipboardMocks.readPasteText.mockResolvedValue("PASTED");
    const { ctx } = makeContext(view);

    await execute(ctx, "edit.paste");

    expect(clipboardMocks.readPasteText).toHaveBeenCalledTimes(1);
    expect(dispatches).toHaveLength(1);
    expect(content()).toBe("abcPASTED");
  });

  it("reports a read failure instead of silently doing nothing when no clipboard owner can supply text", async () => {
    const { view, dispatches } = makeView("abc", { from: 3, to: 3 });
    clipboardMocks.readPasteText.mockRejectedValue(new Error("clipboard read: denied"));
    const { ctx, errors } = makeContext(view);

    await execute(ctx, "edit.paste");

    expect(dispatches).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("clipboard read");
  });

  it("writes the selected text through the shared native-first clipboard writer on copy and records history", async () => {
    const { view } = makeView("hello world", { from: 0, to: 5 });
    const { ctx } = makeContext(view);

    await execute(ctx, "edit.copy");

    expect(clipboardMocks.writeText).toHaveBeenCalledWith("hello");
    expect(useNotepadStore.getState().clipboardHistory[0]).toBe("hello");
  });

  it("cuts by publishing the selection through the shared writer and removing it from the view", async () => {
    const { view, content } = makeView("hello world", { from: 0, to: 5 });
    const { ctx } = makeContext(view);

    await execute(ctx, "edit.cut");

    expect(clipboardMocks.writeText).toHaveBeenCalledWith("hello");
    expect(content()).toBe(" world");
    expect(useNotepadStore.getState().clipboardHistory[0]).toBe("hello");
  });

  it("does not write or cut when nothing is selected", async () => {
    const { view, dispatches } = makeView("abc", { from: 1, to: 1 });
    const { ctx } = makeContext(view);

    await execute(ctx, "edit.copy");
    await execute(ctx, "edit.cut");

    expect(clipboardMocks.writeText).not.toHaveBeenCalled();
    expect(dispatches).toHaveLength(0);
  });
});
