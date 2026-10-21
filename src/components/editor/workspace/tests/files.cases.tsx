import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";
import { registerfilesClipboard2Cases } from "./tests/files/clipboard2.cases";
import { registerfilesHistory1Cases } from "./tests/files/history1.cases";
import { registerfilesLifecycle3Cases } from "./tests/files/lifecycle3.cases";
import { registerfilesLifecycle4Cases } from "./tests/files/lifecycle4.cases";

export type registerFilesCasesFixture = Pick<WorkspaceTestFixture, "renderWorkspace" | "workspaceMocks" | "file" | "toolbarControl" | "entry" | "gitMocks" | "lspMocks" | "documentStatus" | "defaultCapabilities" | "clipboardMocks" | "writeAck" | "confirmWorkspaceUndo">;

export function registerFilesCases(workspaceTestHarness: registerFilesCasesFixture) {
  registerfilesHistory1Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerfilesClipboard2Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerfilesLifecycle3Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerfilesLifecycle4Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
}
