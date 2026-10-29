import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceObservationBoundary } from "./WorkspaceObservationBoundary";
import { WorkspaceObservationBridge } from "./workspaceObservationBridge";
import { acquireClipboardStore } from "./workspaceClipboardSession";

afterEach(cleanup);

describe("WorkspaceObservationBoundary", () => {
  it("updates clipboard lifecycle/history attributes without rendering editor children", () => {
    const handle = acquireClipboardStore("clipboard-boundary");
    const bridge = new WorkspaceObservationBridge("clipboard-boundary");
    const renderEditor = vi.fn();
    function Editor() { renderEditor(); return <div>Editor</div>; }
    const mounted = render(<WorkspaceObservationBoundary bridge={bridge} clipboardHandle={handle} data-testid="workspace">
      <Editor />
    </WorkspaceObservationBoundary>);
    renderEditor.mockClear();
    const root = screen.getByTestId("workspace");
    let lease!: ReturnType<typeof handle.attachConsumer>;
    act(() => { lease = handle.attachConsumer("editor-a"); });
    expect(root).toHaveAttribute("data-clipboard-consumer-count", "1");
    act(() => { handle.write({ plainText: "public text", sourceViewId: "editor-a", rectangular: false, sourceEol: "lf" }); });
    expect(root).toHaveAttribute("data-clipboard-revision", "1");
    expect(root).toHaveAttribute("data-clipboard-history-revision", "1");
    act(() => { lease.detach(); });
    expect(root).toHaveAttribute("data-clipboard-consumer-count", "0");
    expect(renderEditor).not.toHaveBeenCalled();
    mounted.unmount();
    expect(() => handle.setPermission("denied")).not.toThrow();
    handle.release();
  });

  it("publishes live typing receipts without rendering workspace children", () => {
    const bridge = new WorkspaceObservationBridge("typing");
    const renderEditor = vi.fn();
    function Editor() {
      renderEditor();
      return <div>Editor</div>;
    }
    const mounted = render(
      <StrictMode>
        <WorkspaceObservationBoundary bridge={bridge} data-testid="workspace">
          <Editor />
        </WorkspaceObservationBoundary>
      </StrictMode>,
    );
    renderEditor.mockClear();
    for (let revision = 1; revision <= 10; revision += 1) {
      act(() => {
        bridge.observeDocumentRevision("Example.java", revision);
        bridge.observeHistoryReceipt(`Example.java:${revision}`);
      });
    }
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-observation-revision", "20");
    expect(screen.getByTestId("code-workspace-observation")).toHaveAttribute("data-history-receipt-count", "10");
    expect(renderEditor).not.toHaveBeenCalled();
    mounted.unmount();
    expect(() => bridge.observeDocumentRevision("Example.java", 11)).not.toThrow();
  });
});
