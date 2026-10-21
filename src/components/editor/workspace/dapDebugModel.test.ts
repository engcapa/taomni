import "./tests/dapDebugModel/harness";
import { describe } from "vitest";
import { registerdapDebugModelLayout1Cases } from "./tests/dapDebugModel/layout1.cases";
import { registerdapDebugModelNavigation2Cases } from "./tests/dapDebugModel/navigation2.cases";

describe("dapDebugModel", () => {
  registerdapDebugModelLayout1Cases();
  registerdapDebugModelNavigation2Cases();
});
