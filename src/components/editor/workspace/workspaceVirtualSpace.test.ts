import "./tests/workspaceVirtualSpace/harness";
import { describe } from "vitest";
import { registerworkspaceVirtualSpaceBehavior1Cases } from "./tests/workspaceVirtualSpace/behavior1.cases";
import { registerworkspaceVirtualSpaceClipboard3Cases } from "./tests/workspaceVirtualSpace/clipboard3.cases";
import { registerworkspaceVirtualSpaceHistory2Cases } from "./tests/workspaceVirtualSpace/history2.cases";
import { registerworkspaceVirtualSpaceNavigation5Cases } from "./tests/workspaceVirtualSpace/navigation5.cases";
import { registerworkspaceVirtualSpaceRendering4Cases } from "./tests/workspaceVirtualSpace/rendering4.cases";

registerworkspaceVirtualSpaceBehavior1Cases();

describe("§8.19.5 virtual caret lifecycle", () => {
  registerworkspaceVirtualSpaceClipboard3Cases();
  registerworkspaceVirtualSpaceRendering4Cases();
  registerworkspaceVirtualSpaceNavigation5Cases();
});

registerworkspaceVirtualSpaceHistory2Cases();
