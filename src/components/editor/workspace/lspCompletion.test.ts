import "./tests/lspCompletion/harness";
import { describe } from "vitest";
import { registerlspCompletionBehavior3Cases } from "./tests/lspCompletion/behavior3.cases";
import { registerlspCompletionBehavior5Cases } from "./tests/lspCompletion/behavior5.cases";
import { registerlspCompletionCompletion1Cases } from "./tests/lspCompletion/completion1.cases";
import { registerlspCompletionCompletion2Cases } from "./tests/lspCompletion/completion2.cases";
import { registerlspCompletionCompletion4Cases } from "./tests/lspCompletion/completion4.cases";
import { registerlspCompletionCompletion6Cases } from "./tests/lspCompletion/completion6.cases";
import { registerlspCompletionLifecycle7Cases } from "./tests/lspCompletion/lifecycle7.cases";

registerlspCompletionCompletion1Cases();

describe("createLspCompletionSource", () => {
  registerlspCompletionCompletion4Cases();
  registerlspCompletionBehavior5Cases();
});

registerlspCompletionCompletion2Cases();

describe("§8.21.3 V2-E BasicCompletionPolicyV2", () => {
  registerlspCompletionCompletion6Cases();
  registerlspCompletionLifecycle7Cases();
});

registerlspCompletionBehavior3Cases();
