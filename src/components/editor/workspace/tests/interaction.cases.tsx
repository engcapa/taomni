import type { WorkspaceTestFixture } from "../../tests/codeWorkspaceTab/harness";
import { registerCompareCases } from "./compare.cases";
import { registerExecutionCases } from "./execution.cases";
import { registerNavigationCases } from "./navigation.cases";
import { registerinteractionBehavior6Cases } from "./tests/interaction/behavior6.cases";
import { registerinteractionEditing3Cases } from "./tests/interaction/editing3.cases";
import { registerinteractionEditing4Cases } from "./tests/interaction/editing4.cases";
import { registerinteractionEditing5Cases } from "./tests/interaction/editing5.cases";
import { registerinteractionLifecycle1Cases } from "./tests/interaction/lifecycle1.cases";
import { registerinteractionNavigation2Cases } from "./tests/interaction/navigation2.cases";

export type registerInteractionCasesFixture = Pick<WorkspaceTestFixture, "projectFactsMock" | "descriptorDiscoveryMock" | "renderWorkspace" | "clipboardMocks" | "workspaceMocks" | "entry" | "file" | "gitMocks" | "toolbarControl" | "documentStatus" | "lspMocks" | "defaultCapabilities" | "writeAck" | "runtimeState" | "dapMocks" | "ipcMocks" | "localHistoryMocks" | "confirmWorkspaceUndo">;

export function registerInteractionCases(workspaceTestHarness: registerInteractionCasesFixture) {
  registerinteractionLifecycle1Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerNavigationCases(workspaceTestHarness);
  registerinteractionNavigation2Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerinteractionEditing3Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerinteractionEditing4Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
  registerExecutionCases(workspaceTestHarness);
  registerinteractionEditing5Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });

  registerCompareCases(workspaceTestHarness);
  registerinteractionBehavior6Cases({
    get workspaceTestHarness() { return workspaceTestHarness; },
  });
}
