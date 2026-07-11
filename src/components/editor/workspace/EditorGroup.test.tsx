import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { EditorGroup } from "./EditorGroup";
import type { OpenFileViewModel } from "./editorGroupTypes";

vi.mock("./CodeMirrorHost", () => ({
  CodeMirrorHost: () => <div data-testid="mock-code-mirror" />,
}));

afterEach(cleanup);

function file(key: string): OpenFileViewModel {
  return {
    key,
    ref: { kind: "root", rootId: "root", path: `${key}.ts` },
    path: `${key}.ts`,
    title: `${key}.ts`,
    subtitle: `repo / ${key}.ts`,
    languagePath: `${key}.ts`,
    text: key,
    savedText: key,
    size: 1,
    mtime: 1,
    hash: key,
    loading: false,
    saving: false,
    dirty: false,
    error: null,
  };
}

function props(overrides: Partial<ComponentProps<typeof EditorGroup>> = {}): ComponentProps<typeof EditorGroup> {
  const a = file("a");
  const b = file("b");
  return {
    groupId: "primary",
    workspaceInstanceId: "ws",
    visible: true,
    openOrder: ["a", "b"],
    openFiles: { a, b },
    activeKey: "b",
    previewKey: "b",
    pinnedKeys: ["a"],
    activeFile: b,
    activeMarkdownMode: "edit",
    activeDiagnostics: [],
    activeCapabilities: null,
    activeLspSyncing: false,
    lspStatusPill: null,
    breadcrumbs: null,
    revealTarget: null,
    editorPaneRef: { current: null },
    editorPaneStyle: {},
    onActivate: vi.fn(),
    onActivateGroup: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
    onPromotePreview: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseRight: vi.fn(),
    onCloseUnmodified: vi.fn(),
    onCloseAll: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onMarkdownModeChange: vi.fn(),
    onChangeText: vi.fn(),
    onSave: vi.fn(),
    onHover: vi.fn(async () => null),
    onDefinition: vi.fn(async () => false),
    onReferences: vi.fn(async () => {}),
    onComplete: vi.fn(async () => null),
    onCompleteResolve: vi.fn(async () => null),
    onSignatureHelp: vi.fn(async () => null),
    onSelectionChange: vi.fn(),
    onLightbulb: vi.fn(),
    onOpenMarkdownHref: vi.fn(() => false),
    formatBytes: vi.fn(() => "1 B"),
    formatMtime: vi.fn(() => ""),
    isMarkdownPath: vi.fn(() => false),
    renderMarkdownPreview: vi.fn(() => null),
    ...overrides,
  };
}

describe("EditorGroup tabs", () => {
  it("renders pinned tabs first, marks previews, promotes on double click, and middle-closes", () => {
    const onPromotePreview = vi.fn();
    const onClose = vi.fn();
    render(<EditorGroup {...props({ onPromotePreview, onClose })} />);

    const aButton = screen.getByTitle("repo / a.ts");
    const bButton = screen.getByTitle("repo / b.ts");
    expect(aButton.parentElement).toHaveAttribute("data-pinned", "true");
    expect(bButton.parentElement).toHaveAttribute("data-preview", "true");
    expect(screen.getByText("b.ts")).toHaveClass("italic");

    fireEvent.doubleClick(bButton);
    expect(onPromotePreview).toHaveBeenCalledWith("b");
    fireEvent(bButton, new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    expect(onClose).toHaveBeenCalledWith("b");
  });

  it("exposes pin and close actions from the tab context menu", () => {
    const onPin = vi.fn();
    const onCloseOthers = vi.fn();
    render(<EditorGroup {...props({ onPin, onCloseOthers })} />);

    fireEvent.contextMenu(screen.getByTitle("repo / b.ts"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Pin Tab" }));
    expect(onPin).toHaveBeenCalledWith("b", true);

    fireEvent.contextMenu(screen.getByTitle("repo / b.ts"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Close Others" }));
    expect(onCloseOthers).toHaveBeenCalledWith("b");
  });
});
