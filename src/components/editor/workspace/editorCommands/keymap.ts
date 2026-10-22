import { copyLineDown, deleteLine, moveLineDown, moveLineUp, toggleBlockComment, toggleComment } from "@codemirror/commands";
import { gotoLine } from "@codemirror/search";
import type { KeyBinding } from "@codemirror/view";
import { expandSyntaxSelection, shrinkSyntaxSelection, unselectOccurrence } from "./selection";
import { completeCurrentStatement } from "./statements";
import { joinLines, toggleCase, tabJumpOut } from "./lines";

export const workspaceEditorKeymap: readonly KeyBinding[] = [
  { key: "Mod-/", run: toggleComment },
  { key: "Mod-Shift-/", run: toggleBlockComment },
  { key: "Mod-d", run: copyLineDown },
  { key: "Mod-y", run: deleteLine },
  { key: "Shift-Alt-ArrowUp", run: moveLineUp },
  { key: "Shift-Alt-ArrowDown", run: moveLineDown },
  { key: "Mod-w", run: expandSyntaxSelection },
  { key: "Mod-Shift-w", run: shrinkSyntaxSelection },
  { key: "Mod-g", run: gotoLine },
  { key: "Mod-Shift-Enter", run: completeCurrentStatement },
  { key: "Mod-Shift-j", run: joinLines },
  { key: "Ctrl-Shift-j", run: joinLines },
  { key: "Shift-Alt-j", run: unselectOccurrence },
  { key: "Mod-Shift-u", run: toggleCase },
  { key: "Ctrl-Shift-u", run: toggleCase },
  { key: "Tab", run: tabJumpOut },
];
