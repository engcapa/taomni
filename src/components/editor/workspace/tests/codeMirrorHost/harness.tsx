import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { expect, vi } from "vitest";
import { CodeMirrorHost } from "../../CodeMirrorHost";

export function renderEditor(
  doc: string,
  onChange = vi.fn(),
  overrides: Partial<ComponentProps<typeof CodeMirrorHost>> = {},
) {
  const props: ComponentProps<typeof CodeMirrorHost> = {
    path: "src/example.ts",
    doc,
    visible: true,
    diagnostics: [],
    reveal: null,
    onChange,
    onSave: vi.fn(),
    onHover: vi.fn(async () => null),
    onDefinition: vi.fn(async () => false),
    onReferences: vi.fn(async () => undefined),
    ...overrides,
    getCompletionIdentity: overrides.getCompletionIdentity ?? (() => null),
    onCompletionDiagnostic: overrides.onCompletionDiagnostic ?? vi.fn(),
  };
  const result = render(<CodeMirrorHost {...props} />);
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  expect(content).not.toBeNull();
  return { ...result, content: content!, onChange, props };
}
