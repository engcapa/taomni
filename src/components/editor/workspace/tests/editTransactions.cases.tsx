import { registereditTransactionsHistory1Cases } from "./tests/editTransactions/history1.cases";
import { registereditTransactionsLifecycle2Cases } from "./tests/editTransactions/lifecycle2.cases";
import { registereditTransactionsLifecycle3Cases } from "./tests/editTransactions/lifecycle3.cases";
import { type registerWorkspaceEditsCasesFixture } from "./workspaceEdits.cases";

export function registerEditTransactionsCases(workspaceTestHarness: registerWorkspaceEditsCasesFixture) {
  registereditTransactionsHistory1Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registereditTransactionsLifecycle2Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registereditTransactionsLifecycle3Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
}
