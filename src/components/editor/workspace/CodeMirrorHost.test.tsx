import "./tests/codeMirrorHost/harness";
import { cleanup } from "@testing-library/react";
import { afterEach, describe } from "vitest";
import { registerCodeMirrorHostClipboard5Cases } from "./tests/codeMirrorHost/clipboard5.cases";
import { registerCodeMirrorHostClipboard6Cases } from "./tests/codeMirrorHost/clipboard6.cases";
import { registerCodeMirrorHostClipboard7Cases } from "./tests/codeMirrorHost/clipboard7.cases";
import { registerCodeMirrorHostEditing2Cases } from "./tests/codeMirrorHost/editing2.cases";
import { registerCodeMirrorHostHistory3Cases } from "./tests/codeMirrorHost/history3.cases";
import { registerCodeMirrorHostHistory8Cases } from "./tests/codeMirrorHost/history8.cases";
import { registerCodeMirrorHostLifecycle1Cases } from "./tests/codeMirrorHost/lifecycle1.cases";
import { registerCodeMirrorHostRendering4Cases } from "./tests/codeMirrorHost/rendering4.cases";

registerCodeMirrorHostLifecycle1Cases();

describe("CodeMirrorHost search", () => {
  afterEach(() => cleanup());
  registerCodeMirrorHostClipboard7Cases();
  registerCodeMirrorHostHistory8Cases();
});

registerCodeMirrorHostEditing2Cases();

registerCodeMirrorHostHistory3Cases();

registerCodeMirrorHostRendering4Cases();

registerCodeMirrorHostClipboard5Cases();

registerCodeMirrorHostClipboard6Cases();
