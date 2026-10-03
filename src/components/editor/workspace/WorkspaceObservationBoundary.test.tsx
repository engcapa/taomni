import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceObservationBoundary } from "./WorkspaceObservationBoundary";
import { WorkspaceObservationBridge } from "./workspaceObservationBridge";

afterEach(cleanup);

describe("WorkspaceObservationBoundary", () => {
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
