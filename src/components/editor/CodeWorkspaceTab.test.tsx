import "./tests/codeWorkspaceTab/harness";
import { registerCodeWorkspaceTabBehavior2Cases } from "./tests/codeWorkspaceTab/behavior2.cases";
import { registerCodeWorkspaceTabCompletion1Cases } from "./tests/codeWorkspaceTab/completion1.cases";

registerCodeWorkspaceTabCompletion1Cases();

registerCodeWorkspaceTabBehavior2Cases();

export { type SaveRaceGateForTest, type WorkspaceTestFixture } from "./tests/codeWorkspaceTab/harness";
