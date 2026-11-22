import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompareOverlay, MAX_COMPARE_BYTES } from "./CompareOverlay";
import { EditToolDialogs } from "./EditToolDialogs";
import { MacroDialogs } from "./MacroDialogs";
import { PrintDialog } from "./PrintDialog";
import { ToolboxDialogs } from "./ToolboxDialogs";
import { FindReplaceBar } from "../FindReplaceBar";
import { defaultFindState } from "../../../stores/notepadStore";
import { resetNotepadPreferences, setNotepadPreferences } from "../../../stores/notepadPreferences";

afterEach(() => {
  cleanup();
  resetNotepadPreferences();
});

describe("Notepad dialogs & FindReplaceBar regressions", () => {
  it("CompareOverlay computes real @codemirror/merge hunks on inserted top line and guards > 5 MB", () => {
    const view = render(
      <CompareOverlay
        compare={{
          open: true,
          leftTitle: "Left",
          leftContent: "a\nb\nc\nd\ne",
          rightTitle: "Right",
          rightContent: "header\na\nb\nc\nd\ne",
          ignoreWhitespace: false,
          ignoreCase: false,
        }}
        onPatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // LCS diff treats prepending 1 line as 1 hunk, not 5 changed rows.
    expect(screen.getByTestId("notepad-compare-dialog").textContent).toMatch(/\(1\s/);
    expect(screen.getByTestId("notepad-compare-merge-view")).toBeInTheDocument();

    view.rerender(
      <CompareOverlay
        compare={{
          open: true,
          leftTitle: "Left",
          leftContent: "x".repeat(MAX_COMPARE_BYTES + 16),
          rightTitle: "Right",
          rightContent: "small",
          ignoreWhitespace: false,
          ignoreCase: false,
        }}
        onPatch={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("notepad-compare-too-large")).toBeInTheDocument();
  });

  it("refreshes ToolboxDialogs text on reopen and EditToolDialogs accepts offset 0", () => {
    const toolbox = render(
      <ToolboxDialogs
        kind="mime"
        documentText="first"
        selectionText=""
        filePath={null}
        onClose={vi.fn()}
        onApplyText={vi.fn()}
      />,
    );
    expect(screen.getByTestId("notepad-mime-textarea")).toHaveValue("first");
    toolbox.rerender(
      <ToolboxDialogs
        kind={null}
        documentText="first"
        selectionText=""
        filePath={null}
        onClose={vi.fn()}
        onApplyText={vi.fn()}
      />,
    );
    toolbox.rerender(
      <ToolboxDialogs
        kind="mime"
        documentText="second"
        selectionText=""
        filePath={null}
        onClose={vi.fn()}
        onApplyText={vi.fn()}
      />,
    );
    expect(screen.getByTestId("notepad-mime-textarea")).toHaveValue("second");

    const onGoTo = vi.fn();
    render(
      <EditToolDialogs
        kind="goto"
        currentLine={3}
        totalLines={5}
        currentOffset={10}
        totalLength={40}
        onClose={vi.fn()}
        onGoTo={onGoTo}
        onApplyColumn={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("radio")[1]);
    fireEvent.change(screen.getByTestId("notepad-goto-input"), { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("notepad-goto-confirm"));
    expect(onGoTo).toHaveBeenCalledWith("offset", 0);
  });

  it("resets MacroDialogs input between opens and clamps PrintDialog range when selection is empty", () => {
    const macroView = render(
      <MacroDialogs
        kind="save"
        macros={[]}
        tamperInfo={null}
        onClose={vi.fn()}
        onSaveNamed={vi.fn(async () => undefined)}
        onRunMulti={vi.fn(async () => undefined)}
        onDeleteMacro={vi.fn(async () => undefined)}
        onRenameMacro={vi.fn(async () => undefined)}
        onRunSavedMacro={vi.fn(async () => undefined)}
        onAcceptTampered={vi.fn(async () => undefined)}
        onResetMacros={vi.fn(async () => undefined)}
      />,
    );
    fireEvent.change(screen.getByTestId("notepad-macro-name-input"), { target: { value: "old-name" } });
    macroView.rerender(
      <MacroDialogs
        kind={null}
        macros={[]}
        tamperInfo={null}
        onClose={vi.fn()}
        onSaveNamed={vi.fn(async () => undefined)}
        onRunMulti={vi.fn(async () => undefined)}
        onDeleteMacro={vi.fn(async () => undefined)}
        onRenameMacro={vi.fn(async () => undefined)}
        onRunSavedMacro={vi.fn(async () => undefined)}
        onAcceptTampered={vi.fn(async () => undefined)}
        onResetMacros={vi.fn(async () => undefined)}
      />,
    );
    macroView.rerender(
      <MacroDialogs
        kind="save"
        macros={[]}
        tamperInfo={null}
        onClose={vi.fn()}
        onSaveNamed={vi.fn(async () => undefined)}
        onRunMulti={vi.fn(async () => undefined)}
        onDeleteMacro={vi.fn(async () => undefined)}
        onRenameMacro={vi.fn(async () => undefined)}
        onRunSavedMacro={vi.fn(async () => undefined)}
        onAcceptTampered={vi.fn(async () => undefined)}
        onResetMacros={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByTestId("notepad-macro-name-input")).toHaveValue("");

    setNotepadPreferences({
      printDefaults: { range: "selection", lineNumbers: true, marginMm: 12, header: "", footer: "", colorMode: "wysiwyg" },
    });
    render(<PrintDialog open title="doc.txt" content="abc" selection="" onClose={vi.fn()} />);
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("all");
  });

  it("FindReplaceBar surfaces ReDoS rejection error, triggers Copy Marked, and toggles purgePrev", () => {
    const onCopyMarked = vi.fn();
    const onMarkAll = vi.fn();
    const onIncrementalSearch = vi.fn();
    render(
      <FindReplaceBar
        find={{ ...defaultFindState(), open: true, tab: "mark", mode: "re", query: "(a+)+b", incremental: true }}
        statusText={null}
        searchingFiles={false}
        onPatch={vi.fn()}
        onFindNext={vi.fn()}
        onFindPrev={vi.fn()}
        onIncrementalSearch={onIncrementalSearch}
        onCount={vi.fn()}
        onFindAllCurrent={vi.fn()}
        onFindAllOpen={vi.fn()}
        onReplaceOne={vi.fn()}
        onReplaceAll={vi.fn()}
        onReplaceAllOpen={vi.fn()}
        onFindInFiles={vi.fn()}
        onCancelFindInFiles={vi.fn()}
        onReplaceInFiles={vi.fn()}
        onMarkAll={onMarkAll}
        onClearMarks={vi.fn()}
        onCopyMarked={onCopyMarked}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("notepad-find-status").textContent).toContain("catastrophic backtracking");
    fireEvent.click(screen.getByTestId("np-find-copy-marked"));
    expect(onCopyMarked).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("notepad-mark-purge"));
    fireEvent.click(screen.getByTestId("np-find-mark-all"));
    expect(onMarkAll).toHaveBeenCalledWith(false, false);
    fireEvent.change(screen.getByTestId("np-find-input"), { target: { value: "abc" } });
    expect(onIncrementalSearch).toHaveBeenCalledWith("abc");
  });
});
