import "./tests/sessionImportExport/harness";
import { describe } from "vitest";
import { registersessionImportExportBehavior4Cases } from "./tests/sessionImportExport/behavior4.cases";
import { registersessionImportExportLifecycle1Cases } from "./tests/sessionImportExport/lifecycle1.cases";
import { registersessionImportExportLifecycle2Cases } from "./tests/sessionImportExport/lifecycle2.cases";
import { registersessionImportExportLifecycle3Cases } from "./tests/sessionImportExport/lifecycle3.cases";
import { registersessionImportExportLifecycle5Cases } from "./tests/sessionImportExport/lifecycle5.cases";
import { registersessionImportExportLifecycle6Cases } from "./tests/sessionImportExport/lifecycle6.cases";

registersessionImportExportLifecycle1Cases();

registersessionImportExportLifecycle2Cases();

registersessionImportExportLifecycle3Cases();

describe("third-party session import parsers", () => {
  registersessionImportExportLifecycle5Cases();
  registersessionImportExportLifecycle6Cases();
});

registersessionImportExportBehavior4Cases();
