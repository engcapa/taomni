import "./tests/rearrangeCleanupWorkflow/harness";
import { registerrearrangeCleanupWorkflowBehavior5Cases } from "./tests/rearrangeCleanupWorkflow/behavior5.cases";
import { registerrearrangeCleanupWorkflowHistory4Cases } from "./tests/rearrangeCleanupWorkflow/history4.cases";
import { registerrearrangeCleanupWorkflowLifecycle1Cases } from "./tests/rearrangeCleanupWorkflow/lifecycle1.cases";
import { registerrearrangeCleanupWorkflowLifecycle2Cases } from "./tests/rearrangeCleanupWorkflow/lifecycle2.cases";
import { registerrearrangeCleanupWorkflowRendering3Cases } from "./tests/rearrangeCleanupWorkflow/rendering3.cases";

registerrearrangeCleanupWorkflowLifecycle1Cases();

registerrearrangeCleanupWorkflowLifecycle2Cases();

registerrearrangeCleanupWorkflowRendering3Cases();

registerrearrangeCleanupWorkflowHistory4Cases();

registerrearrangeCleanupWorkflowBehavior5Cases();
