import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LspWorkspaceEdit } from "../../../../../../lib/editor/lsp";
import type { WorkspaceSearchMatch } from "../../../../../../lib/editor/workspaceSearch";
import type { ReplaceFilePreimage, ReplacePreviewSnapshot } from "../../../replaceInFilesModel";
import { FindInFilesPanel } from "../../FindInFilesPanel";
import { doneEvent, roots, runSearch, searchMatch } from "./harness";

export function registerFindInFilesPanelLifecycle4Cases() {

  describe("ED-REPAIR-005: replace prepare request cancellation and identity isolation", () => {
    it("discards late P1 when P2 completes first and preserves P2 preview (ED-REPAIR-005-A1)", async () => {
      let resolveP1!: (value: readonly ReplaceFilePreimage[]) => void;
      let resolveP2!: (value: readonly ReplaceFilePreimage[]) => void;
      const p1 = new Promise<readonly ReplaceFilePreimage[]>((res) => { resolveP1 = res; });
      const p2 = new Promise<readonly ReplaceFilePreimage[]>((res) => { resolveP2 = res; });

      let callCount = 0;
      const onPrepareReplacePreimages = vi.fn(() => {
        callCount++;
        return callCount === 1 ? p1 : p2;
      });

      render(
        <FindInFilesPanel
          roots={roots}
          onOpenMatch={vi.fn()}
          onReplaceMatches={vi.fn()}
          onPrepareReplacePreimages={onPrepareReplacePreimages}
        />,
      );

      const emit = await runSearch();
      const match = searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 });
      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches: [match] });
        emit(doneEvent({ totalMatches: 1 }));
      });

      // P1: Replace text = "thread-1"
      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
      expect(onPrepareReplacePreimages).toHaveBeenCalledTimes(1);

      // P2: Replace text = "thread-2"
      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread-2" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
      expect(onPrepareReplacePreimages).toHaveBeenCalledTimes(2);

      const makePreimages = (val: string): readonly ReplaceFilePreimage[] => [
        {
          path: "/repo/app/notes.txt",
          uri: "file:///repo/app/notes.txt",
          textHash: `hash-${val}`,
          encoding: "UTF-8",
          bom: false,
          eol: "lf",
          bufferRevision: 1,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws",
        },
      ];

      // Resolve P2 first
      await act(async () => {
        resolveP2(makePreimages("thread-2"));
      });
      expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();
      expect(screen.getByTestId("code-workspace-replace-preview")).toHaveTextContent("thread-2");

      // Resolve P1 late
      await act(async () => {
        resolveP1(makePreimages("thread-1"));
      });
      // P1 must be discarded: preview must remain thread-2, NOT overwritten by thread-1!
      expect(screen.getByTestId("code-workspace-replace-preview")).toHaveTextContent("thread-2");
      expect(screen.getByTestId("code-workspace-replace-preview")).not.toHaveTextContent("thread-1");
    });

    it("deduplicates synchronous clicks in the same event loop (ED-REPAIR-005-A1)", async () => {
      const p = new Promise<readonly ReplaceFilePreimage[]>(() => { }); // pending
      const onPrepareReplacePreimages = vi.fn(() => p);

      render(
        <FindInFilesPanel
          roots={roots}
          onOpenMatch={vi.fn()}
          onReplaceMatches={vi.fn()}
          onPrepareReplacePreimages={onPrepareReplacePreimages}
        />,
      );

      const emit = await runSearch();
      const match = searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 });
      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches: [match] });
        emit(doneEvent({ totalMatches: 1 }));
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "thread" } });
      const button = screen.getByRole("button", { name: "Preview replace all matches" });
      // Synchronous double click in same event loop
      fireEvent.click(button);
      fireEvent.click(button);

      // Must be called exactly once
      expect(onPrepareReplacePreimages).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("code-workspace-replace-preparing")).toBeInTheDocument();
    });

    it("ignores late P1 error when P2 succeeds (ED-REPAIR-005-A1)", async () => {
      let rejectP1!: (err: Error) => void;
      let resolveP2!: (value: readonly ReplaceFilePreimage[]) => void;
      const p1 = new Promise<readonly ReplaceFilePreimage[]>((_, rej) => { rejectP1 = rej; });
      const p2 = new Promise<readonly ReplaceFilePreimage[]>((res) => { resolveP2 = res; });

      let callCount = 0;
      const onPrepareReplacePreimages = vi.fn(() => {
        callCount++;
        return callCount === 1 ? p1 : p2;
      });

      render(
        <FindInFilesPanel
          roots={roots}
          onOpenMatch={vi.fn()}
          onReplaceMatches={vi.fn()}
          onPrepareReplacePreimages={onPrepareReplacePreimages}
        />,
      );

      const emit = await runSearch();
      const match = searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 });
      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches: [match] });
        emit(doneEvent({ totalMatches: 1 }));
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "val-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "val-2" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      // Resolve P2 first
      await act(async () => {
        resolveP2([
          {
            path: "/repo/app/notes.txt",
            uri: "file:///repo/app/notes.txt",
            textHash: "hash-val-2",
            encoding: "UTF-8",
            bom: false,
            eol: "lf",
            bufferRevision: 1,
            dirty: false,
            readOnly: false,
            workspaceInstanceId: "ws",
          },
        ]);
      });
      expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();

      // Reject P1 late
      await act(async () => {
        rejectP1(new Error("P1 disk failed"));
      });

      // Preview remains open; error from P1 is NOT shown
      expect(screen.getByTestId("code-workspace-replace-preview")).toBeInTheDocument();
      expect(screen.queryByTestId("code-workspace-replace-error")).not.toBeInTheDocument();
    });

    it("cancels in-flight prepare and ignores late resolution (ED-REPAIR-005-A1)", async () => {
      let resolveP1!: (value: readonly ReplaceFilePreimage[]) => void;
      const p1 = new Promise<readonly ReplaceFilePreimage[]>((res) => { resolveP1 = res; });
      const onPrepareReplacePreimages = vi.fn(() => p1);

      render(
        <FindInFilesPanel
          roots={roots}
          onOpenMatch={vi.fn()}
          onReplaceMatches={vi.fn()}
          onPrepareReplacePreimages={onPrepareReplacePreimages}
        />,
      );

      const emit = await runSearch();
      const match = searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 });
      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches: [match] });
        emit(doneEvent({ totalMatches: 1 }));
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "val-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
      expect(screen.getByTestId("code-workspace-replace-preparing")).toBeInTheDocument();

      // Click cancel button
      fireEvent.click(screen.getByTestId("code-workspace-replace-prepare-cancel"));
      expect(screen.queryByTestId("code-workspace-replace-preparing")).not.toBeInTheDocument();

      // Resolve P1 late
      await act(async () => {
        resolveP1([
          {
            path: "/repo/app/notes.txt",
            uri: "file:///repo/app/notes.txt",
            textHash: "hash-val-1",
            encoding: "UTF-8",
            bom: false,
            eol: "lf",
            bufferRevision: 1,
            dirty: false,
            readOnly: false,
            workspaceInstanceId: "ws",
          },
        ]);
      });

      // Preview should NOT open
      expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument();
    });

    it("invalidates in-flight prepare when query changes (ED-REPAIR-005-A2)", async () => {
      let resolveP1!: (value: readonly ReplaceFilePreimage[]) => void;
      const p1 = new Promise<readonly ReplaceFilePreimage[]>((res) => { resolveP1 = res; });
      const onPrepareReplacePreimages = vi.fn(() => p1);

      render(
        <FindInFilesPanel
          roots={roots}
          onOpenMatch={vi.fn()}
          onReplaceMatches={vi.fn()}
          onPrepareReplacePreimages={onPrepareReplacePreimages}
        />,
      );

      const emit = await runSearch();
      const match = searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 });
      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches: [match] });
        emit(doneEvent({ totalMatches: 1 }));
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "val-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
      expect(screen.getByTestId("code-workspace-replace-preparing")).toBeInTheDocument();

      // Change search query while prepare is in flight
      fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "different-query" } });

      // Resolve P1 late
      await act(async () => {
        resolveP1([
          {
            path: "/repo/app/notes.txt",
            uri: "file:///repo/app/notes.txt",
            textHash: "hash-val-1",
            encoding: "UTF-8",
            bom: false,
            eol: "lf",
            bufferRevision: 1,
            dirty: false,
            readOnly: false,
            workspaceInstanceId: "ws",
          },
        ]);
      });

      // Preview should NOT open
      expect(screen.queryByTestId("code-workspace-replace-preview")).not.toBeInTheDocument();
    });

    it("includes requestIdentity in snapshot matching frozen inputs (ED-REPAIR-005-A3)", async () => {
      let capturedSnapshot: ReplacePreviewSnapshot | undefined;
      const onReplaceMatches = vi.fn(
        async (
          _matches: WorkspaceSearchMatch[],
          _replacement: string,
          _edit: LspWorkspaceEdit,
          snapshot?: ReplacePreviewSnapshot,
        ) => {
          capturedSnapshot = snapshot;
          return { ok: true as const };
        },
      );
      const onPrepareReplacePreimages = vi.fn(async (paths: readonly string[]) =>
        paths.map((path) => ({
          path,
          uri: `file://${path}`,
          textHash: `hash:${path}`,
          encoding: "UTF-8",
          bom: false,
          eol: "lf" as const,
          bufferRevision: 1,
          dirty: false,
          readOnly: false,
          workspaceInstanceId: "ws-test-123",
        })),
      );

      render(
        <FindInFilesPanel
          roots={roots}
          workspaceInstanceId="ws-test-123"
          onOpenMatch={vi.fn()}
          onReplaceMatches={onReplaceMatches}
          onPrepareReplacePreimages={onPrepareReplacePreimages}
        />,
      );

      const emit = await runSearch();
      const match = searchMatch({ lineNumber: 1, lineText: "needle one", matchStart: 0, matchEnd: 6, column: 1 });
      act(() => {
        emit({ ...doneEvent(), kind: "batch", matches: [match] });
        emit(doneEvent({ totalMatches: 1 }));
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "frozen-target" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));
      expect(await screen.findByTestId("code-workspace-replace-preview")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));
      await waitFor(() => expect(onReplaceMatches).toHaveBeenCalledTimes(1));

      expect(capturedSnapshot).toBeDefined();
      expect(capturedSnapshot?.requestIdentity).toBeDefined();
      expect(capturedSnapshot?.requestIdentity?.workspaceInstanceId).toBe("ws-test-123");
      expect(capturedSnapshot?.requestIdentity?.replacement).toBe("frozen-target");
      expect(capturedSnapshot?.requestIdentity?.token).toBeGreaterThan(0);
      expect(capturedSnapshot?.requestIdentity?.matchCount).toBe(1);
    });
  });
}
