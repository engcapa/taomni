import "./tests/codeActionProviderAdapter/harness";
import { describe } from "vitest";
import { registercodeActionProviderAdapterBehavior1Cases } from "./tests/codeActionProviderAdapter/behavior1.cases";
import { registercodeActionProviderAdapterBehavior2Cases } from "./tests/codeActionProviderAdapter/behavior2.cases";
import { registercodeActionProviderAdapterBehavior4Cases } from "./tests/codeActionProviderAdapter/behavior4.cases";
import { registercodeActionProviderAdapterEditing5Cases } from "./tests/codeActionProviderAdapter/editing5.cases";
import { registercodeActionProviderAdapterExecution3Cases } from "./tests/codeActionProviderAdapter/execution3.cases";
import { registercodeActionProviderAdapterHistory6Cases } from "./tests/codeActionProviderAdapter/history6.cases";

registercodeActionProviderAdapterBehavior1Cases();

describe("§8.21.4 V3 Intention session recovery and preconditions", () => {
  registercodeActionProviderAdapterExecution3Cases();
  registercodeActionProviderAdapterBehavior4Cases();
  registercodeActionProviderAdapterEditing5Cases();
  registercodeActionProviderAdapterHistory6Cases();
});

registercodeActionProviderAdapterBehavior2Cases();
