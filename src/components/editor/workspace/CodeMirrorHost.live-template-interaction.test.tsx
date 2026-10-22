import "./tests/codeMirrorHost.live-template-interaction/harness";
import { cleanup } from "@testing-library/react";
import { afterEach, describe } from "vitest";
import type { LspCompletionItem } from "../../../lib/editor/lsp";
import { registerCodeMirrorHostlivetemplateinteractionCompletion3Cases } from "./tests/codeMirrorHost.live-template-interaction/completion3.cases";
import { registerCodeMirrorHostlivetemplateinteractionCompletion4Cases } from "./tests/codeMirrorHost.live-template-interaction/completion4.cases";
import { registerCodeMirrorHostlivetemplateinteractionEditing2Cases } from "./tests/codeMirrorHost.live-template-interaction/editing2.cases";
import { registerCodeMirrorHostlivetemplateinteractionHistory1Cases } from "./tests/codeMirrorHost.live-template-interaction/history1.cases";

describe("CodeMirrorHost Live Template Popup Interaction Regression (TASK-01 / AC-01..05)", () => {
  afterEach(cleanup);

  const createProviderSoutItem = (): LspCompletionItem => ({
    label: "sout",
    kind: 15,
    detail: "provider sout println",
    documentation: null,
    insertText: 'System.out.println("PROVIDER_SOUT");',
    insertTextFormat: 2,
    filterText: null,
    sortText: "0",
    textEdit: null,
    additionalTextEdits: [],
    raw: { label: "sout" },
  });

  const createProviderSoutmItem = (): LspCompletionItem => ({
    label: "soutm",
    kind: 15,
    detail: "provider soutm method",
    documentation: null,
    insertText: 'System.out.println("App.main()");',
    insertTextFormat: 2,
    filterText: null,
    sortText: "1",
    textEdit: null,
    additionalTextEdits: [],
    raw: { label: "soutm" },
  });
  registerCodeMirrorHostlivetemplateinteractionHistory1Cases({
    get createProviderSoutItem() { return createProviderSoutItem; },
    get createProviderSoutmItem() { return createProviderSoutmItem; },
  });
  registerCodeMirrorHostlivetemplateinteractionEditing2Cases({
    get createProviderSoutItem() { return createProviderSoutItem; },
    get createProviderSoutmItem() { return createProviderSoutmItem; },
  });
  registerCodeMirrorHostlivetemplateinteractionCompletion3Cases({
    get createProviderSoutItem() { return createProviderSoutItem; },
  });
  registerCodeMirrorHostlivetemplateinteractionCompletion4Cases();
});
