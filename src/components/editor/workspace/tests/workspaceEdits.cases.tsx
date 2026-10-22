import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";
import { registerCleanupCases } from "./cleanup.cases";
import { registerEditTransactionsCases } from "./editTransactions.cases";
import { registerExtractMethodCases } from "./extractMethod.cases";
import { registerRecoveryJournalCases } from "./recoveryJournal.cases";
import { registerworkspaceEditsHistory1Cases } from "./tests/workspaceEdits/history1.cases";
import { registerworkspaceEditsHistory2Cases } from "./tests/workspaceEdits/history2.cases";
import { registerworkspaceEditsHistory3Cases } from "./tests/workspaceEdits/history3.cases";
import { registerworkspaceEditsLifecycle4Cases } from "./tests/workspaceEdits/lifecycle4.cases";

export type registerWorkspaceEditsCasesFixture = Pick<WorkspaceTestFixture, "workspaceMocks" | "file" | "renderWorkspace" | "entry" | "writeAck" | "lspMocks" | "documentStatus" | "confirmWorkspaceUndo" | "runtimeState" | "dapMocks" | "csharpStatus" | "toolbarControl" | "defaultCapabilities">;

export function registerWorkspaceEditsCases(workspaceTestHarness: registerWorkspaceEditsCasesFixture) {
  registerworkspaceEditsHistory1Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerworkspaceEditsHistory2Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerworkspaceEditsHistory3Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerRecoveryJournalCases(workspaceTestHarness);
  registerCleanupCases(workspaceTestHarness);
  registerworkspaceEditsLifecycle4Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });

  registerEditTransactionsCases(workspaceTestHarness);

  registerExtractMethodCases(workspaceTestHarness);
}
