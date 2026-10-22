import "./tests/workspaceEditApply/harness";
import { describe } from "vitest";
import { registerworkspaceEditApplyEditing1Cases } from "./tests/workspaceEditApply/editing1.cases";
import { registerworkspaceEditApplyEditing3Cases } from "./tests/workspaceEditApply/editing3.cases";
import { registerworkspaceEditApplyHistory2Cases } from "./tests/workspaceEditApply/history2.cases";

describe("applyWorkspaceEdit", () => {
  registerworkspaceEditApplyEditing1Cases();
  registerworkspaceEditApplyHistory2Cases();
  registerworkspaceEditApplyEditing3Cases();
});
