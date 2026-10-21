import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useSftpStore } from "../../../../stores/sftpStore";
import { FilePanel } from "../../FilePanel";
import { SESSION_ID, file, noopHandlers, renderLocal, renderRemote, seedSession, setSelection } from "./harness";

export function registerFileToolbarWiringLayout1Cases() {

  describe("FileToolbar wiring through FilePanel", () => {
    it("renders the REMOTE badge and remote-only buttons on the remote pane", () => {
      seedSession();
      renderRemote();

      expect(screen.getByText("REMOTE")).toBeInTheDocument();
      expect(screen.queryByText("LOCAL")).not.toBeInTheDocument();
      expect(screen.getByText("user@example.com")).toBeInTheDocument();

      expect(screen.getByTitle(/Download selected to local/i)).toBeInTheDocument();
      expect(screen.getByTitle(/Upload files from this computer/i)).toBeInTheDocument();
      expect(screen.getByTitle(/Open terminal at this path/i)).toBeInTheDocument();

      expect(screen.queryByTitle(/Upload .* selected to remote/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/^Upload selected to remote$/i)).not.toBeInTheDocument();
    });

    it("renders the LOCAL badge and local-only Upload button on the local pane", () => {
      seedSession();
      renderLocal();

      expect(screen.getByText("LOCAL")).toBeInTheDocument();
      expect(screen.queryByText("REMOTE")).not.toBeInTheDocument();

      expect(screen.getByTitle(/Upload selected to remote/i)).toBeInTheDocument();

      expect(screen.queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Upload files from this computer/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();
    });

    it("disables/hides selection-dependent buttons when nothing is selected", () => {
      seedSession();
      renderRemote();

      // Buttons whose enabled state depends only on selection count: rendered
      // but disabled.
      expect(screen.getByTitle(/Download selected to local/i)).toBeDisabled();
      expect(screen.getByTitle(/^Delete selected$/i)).toBeDisabled();
      // Chmod / Preview are wired through `firstSelected` in FilePanel, so the
      // handlers are undefined when nothing is selected and the buttons are not
      // rendered at all.
      expect(screen.queryByTitle(/Permissions \(chmod\)/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/View \/ preview text file/i)).not.toBeInTheDocument();

      expect(screen.getByTitle("Refresh")).toBeEnabled();
      expect(screen.getByTitle("New folder")).toBeEnabled();
    });

    it("enables download/delete/chmod/preview when one previewable file is selected (remote)", () => {
      seedSession();
      renderRemote();

      setSelection("remote", ["/work/notes.txt"]);

      expect(screen.getByTitle(/Download 1 selected to local/i)).toBeEnabled();
      expect(screen.getByTitle(/Delete 1 selected/i)).toBeEnabled();
      expect(screen.getByTitle(/Permissions \(chmod\)/i)).toBeEnabled();
      expect(screen.getByTitle(/View \/ preview text file/i)).toBeEnabled();
    });

    it("enables chmod for multi-select and disables preview when no previewable file selected", () => {
      seedSession();
      renderRemote();

      setSelection("remote", ["/work/notes.txt", "/work/image.png"]);

      expect(screen.getByTitle(/Download 2 selected to local/i)).toBeEnabled();
      expect(screen.getByTitle(/Delete 2 selected/i)).toBeEnabled();
      // chmod now supports multi-select and applies the same mode to all.
      expect(screen.getByTitle(/Permissions \(chmod\) for 2 selected/i)).toBeEnabled();
      // image.png is not a previewable text type.
      expect(screen.getByTitle(/View \/ preview text file/i)).toBeDisabled();
    });

    it("enables Upload-to-remote on the local pane when files are selected", () => {
      seedSession();
      renderLocal();

      const upload = screen.getByTitle(/Upload selected to remote/i);
      expect(upload).toBeDisabled();

      setSelection("local", ["/work/notes.txt"]);

      expect(screen.getByTitle(/Upload 1 selected to remote/i)).toBeEnabled();
    });

    it("toggles Show hidden files and reveals dotfiles", async () => {
      const user = userEvent.setup();
      seedSession();
      renderRemote();

      // Hidden file initially filtered out.
      expect(screen.queryByText(".hidden")).not.toBeInTheDocument();

      const toggle = screen.getByTestId("sftp-remote-toggle-hidden");
      await user.click(toggle);

      // Now visible, and the toggle's title flips to the inverse action.
      expect(screen.getByText(".hidden")).toBeInTheDocument();
      expect(screen.getByTitle(/Hide hidden files/i)).toBeInTheDocument();
      expect(useSftpStore.getState().sessions[SESSION_ID].remote.showHidden).toBe(true);
    });

    it("explains when an otherwise empty pane only contains hidden entries", async () => {
      const user = userEvent.setup();
      seedSession({ entries: [file(".env")] });
      renderLocal();

      expect(screen.getByText("Hidden items not shown: 1")).toBeInTheDocument();
      expect(screen.queryByText("Empty directory")).not.toBeInTheDocument();
      expect(screen.getByText("Hidden: 1")).toBeInTheDocument();

      await user.click(screen.getByTestId("sftp-local-show-hidden-filtered"));

      expect(screen.getByText(".env")).toBeInTheDocument();
    });

    it("shows filter counts and exposes a clear-filter action", async () => {
      const user = userEvent.setup();
      const onFilterTextChange = vi.fn();
      seedSession({ entries: [file("notes.txt"), file("image.png")] });
      renderLocal({ filterText: "missing", onFilterTextChange });

      expect(screen.getByText('0 of 2 match "missing"')).toBeInTheDocument();
      expect(screen.getByText('No items match "missing"')).toBeInTheDocument();
      expect(screen.queryByText("Empty directory")).not.toBeInTheDocument();

      await user.click(screen.getByTestId("sftp-local-clear-filter"));

      expect(onFilterTextChange).toHaveBeenCalledWith("");
    });

    it("shows partial-listing diagnostics instead of claiming the directory is empty", () => {
      seedSession({
        entries: [],
        skippedEntryCount: 2,
        entryDiagnostics: [{
          name: "private.txt",
          path: "/work/private.txt",
          error: "Permission denied",
        }],
      });
      renderLocal();

      expect(screen.getByText("Unreadable: 2")).toBeInTheDocument();
      expect(screen.getByText("No readable items")).toBeInTheDocument();
      expect(screen.queryByText("Empty directory")).not.toBeInTheDocument();
      expect(screen.getByTestId("sftp-local-access-warning")).toHaveAttribute(
        "title",
        expect.stringContaining("private.txt: Permission denied"),
      );
    });

    it("renders the LOCAL/REMOTE badges with side-specific styling", () => {
      seedSession();
      const { unmount } = renderRemote();
      const remoteBadge = screen.getByText("REMOTE");
      expect(remoteBadge).toHaveStyle({ background: "var(--taomni-accent)" });
      unmount();

      renderLocal();
      const localBadge = screen.getByText("LOCAL");
      expect(localBadge).toHaveStyle({ background: "var(--taomni-text-muted)" });
    });

    it("hides side-only buttons when their callbacks are not provided", () => {
      seedSession();
      // Remote pane without download/upload-from-disk/terminal handlers.
      render(
        <FilePanel
          sessionId={SESSION_ID}
          side="remote"
          onDeleteSelected={vi.fn()}
          {...noopHandlers}
        />,
      );

      expect(screen.queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Upload files from this computer/i)).not.toBeInTheDocument();
      expect(screen.queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();
      // Delete handler IS provided, so the delete button is rendered (disabled).
      expect(screen.getByTitle(/^Delete selected$/i)).toBeInTheDocument();
    });

    it("invokes the side-specific handlers when toolbar buttons are clicked", async () => {
      const user = userEvent.setup();
      seedSession();

      const onDownload = vi.fn();
      const onTerminal = vi.fn();
      render(
        <FilePanel
          sessionId={SESSION_ID}
          side="remote"
          onDownloadSelected={onDownload}
          onOpenTerminalHere={onTerminal}
          {...noopHandlers}
        />,
      );

      setSelection("remote", ["/work/notes.txt"]);

      await user.click(screen.getByTitle(/Download 1 selected to local/i));
      expect(onDownload).toHaveBeenCalledTimes(1);
      expect(onDownload.mock.calls[0][0]).toHaveLength(1);
      expect(onDownload.mock.calls[0][0][0]).toMatchObject({ path: "/work/notes.txt" });

      await user.click(screen.getByTitle(/Open terminal at this path/i));
      expect(onTerminal).toHaveBeenCalledWith("/work");
    });

    it("updates selection from a row click and enables Delete (no store mutation)", async () => {
      const user = userEvent.setup();
      seedSession();
      const onDelete = vi.fn();
      render(
        <FilePanel
          sessionId={SESSION_ID}
          side="remote"
          onDeleteSelected={onDelete}
          {...noopHandlers}
        />,
      );

      expect(screen.getByTitle(/^Delete selected$/i)).toBeDisabled();

      // Click the row for notes.txt (rendered by FilePanel) to drive selection
      // through the real onClick handler instead of mutating the store.
      await user.click(screen.getByText("notes.txt"));

      expect(screen.getByTitle(/Delete 1 selected/i)).toBeEnabled();
      expect(useSftpStore.getState().sessions[SESSION_ID].remote.selection).toEqual([
        "/work/notes.txt",
      ]);

      await user.click(screen.getByTitle(/Delete 1 selected/i));
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete.mock.calls[0][0][0]).toMatchObject({ path: "/work/notes.txt" });
    });

    it("scopes the toolbar to the LOCAL pane: no Download / no Open-terminal", () => {
      seedSession();
      // Even when (mistakenly) given the remote-only handlers, the local pane
      // must NOT render the remote-only buttons.
      render(
        <FilePanel
          sessionId={SESSION_ID}
          side="local"
          onDownloadSelected={vi.fn()}
          onOpenTerminalHere={vi.fn()}
          onUploadFromDisk={vi.fn()}
          onUploadSelected={vi.fn()}
          {...noopHandlers}
        />,
      );

      const toolbar = screen.getByText("LOCAL").closest("div")!.parentElement!;
      const utils = within(toolbar);
      expect(utils.queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
      expect(utils.queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();
      expect(utils.queryByTitle(/Upload files from this computer/i)).not.toBeInTheDocument();
      // Upload-to-remote IS the local-pane analog and must be present.
      expect(utils.getByTitle(/Upload selected to remote/i)).toBeInTheDocument();
    });
  });
}
