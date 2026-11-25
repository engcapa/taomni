import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
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

function makeView(text: string, selection: { from: number; to: number } | EditorSelection) {
  const dispatches: TransactionSpec[] = [];
  const view = {
    state: EditorState.create({
      doc: text,
      selection: selection instanceof EditorSelection ? selection : { anchor: selection.from, head: selection.to },
      extensions: EditorState.allowMultipleSelections.of(true),
    }),
    dispatch(spec: TransactionSpec) {
      this.state = this.state.update(spec).state;
      dispatches.push(spec);
    },
  };
  return { view, dispatches, content: () => view.state.doc.toString() };
}

function makeContext(view: ReturnType<typeof makeView>["view"] | null, overrides: Partial<NotepadActionContext> = {}): { ctx: NotepadActionContext; errors: string[] } {
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

  it.each(["\r\n", "\n", "\r"])("places the caret after multiline clipboard text at EOF (%j)", async (eol) => {
    const { view, content } = makeView("replace", { from: 0, to: 7 });
    clipboardMocks.readPasteText.mockResolvedValue(["甲", "🙂", ""].join(eol));
    await execute(makeContext(view).ctx, "edit.paste");
    expect(content()).toBe("甲\n🙂\n");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("replaces every active selection in the same paste transaction", async () => {
    const selections = EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(4, 5)]);
    const { view, content, dispatches } = makeView("x---y", selections);
    clipboardMocks.readPasteText.mockResolvedValue("A\r\nB");
    await execute(makeContext(view).ctx, "edit.paste");
    expect(content()).toBe("A\nB---A\nB");
    expect(view.state.selection.ranges.map((range) => range.head)).toEqual([3, 9]);
    expect(dispatches).toHaveLength(1);
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
