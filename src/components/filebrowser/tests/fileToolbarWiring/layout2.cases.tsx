import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../../lib/i18n";
import { NATIVE_FILE_DROP_EVENT } from "../../../../lib/osFileDrop";
import type { FileEntry } from "../../../../lib/sftp";
import { saveSftpPreferences } from "../../../../lib/sftpPreferences";
import { useSftpStore } from "../../../../stores/sftpStore";
import { FileBrowser } from "../../FileBrowser";
import { SESSION_ID, controllerMocks, seedSession, setSelection, sftpMocks } from "./harness";

export function registerFileToolbarWiringLayout2Cases() {

  describe("FileBrowser → FilePanel toolbar wiring", () => {
    function renderBrowser() {
      return render(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
        />,
      );
    }

    it("wires the remote-pane Download toolbar button to controller.download", async () => {
      const user = userEvent.setup();
      seedSession();
      renderBrowser();

      // Both panes render the same fixture; pick the REMOTE pane's row.
      // FilePanel renders one row per entry per pane, so notes.txt appears
      // twice. Scope to the remote pane via its REMOTE badge container.
      const remoteBadge = screen.getByText("REMOTE");
      const remotePanel = remoteBadge.closest("div.h-full") as HTMLElement;
      expect(remotePanel).toBeTruthy();

      const remoteRow = within(remotePanel).getByText("notes.txt");
      await user.click(remoteRow);

      const downloadBtn = within(remotePanel).getByTitle(/Download 1 selected to local/i);
      expect(downloadBtn).toBeEnabled();
      await user.click(downloadBtn);

      expect(controllerMocks.download).toHaveBeenCalledTimes(1);
      const downloadArgs = controllerMocks.download.mock.calls[0] as unknown as unknown[];
      expect(downloadArgs[0]).toMatchObject({
        path: "/work/notes.txt",
      });
    });

    it("wires the remote-pane context Download action to the full multi-selection", async () => {
      const user = userEvent.setup();
      seedSession();
      renderBrowser();

      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      setSelection("remote", ["/work/subdir", "/work/notes.txt"]);

      fireEvent.contextMenu(within(remotePanel).getByText("notes.txt"), {
        clientX: 20,
        clientY: 20,
      });
      await user.click(await screen.findByTestId("context-menu-item-download-2-selected-to-local"));

      expect(controllerMocks.download).toHaveBeenCalledTimes(2);
      const downloadCalls = controllerMocks.download.mock.calls as unknown as Array<[FileEntry]>;
      expect(downloadCalls.map(([entry]) => entry.path)).toEqual([
        "/work/subdir",
        "/work/notes.txt",
      ]);
    });

    it("wires the remote-pane Open-terminal-here toolbar button to the FileBrowser onOpenTerminalHere prop", async () => {
      const user = userEvent.setup();
      seedSession();
      const onOpenTerminalHere = vi.fn();
      render(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
          onOpenTerminalHere={onOpenTerminalHere}
        />,
      );

      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      const terminalBtn = within(remotePanel).getByTitle(/Open terminal at this path/i);
      await user.click(terminalBtn);

      expect(onOpenTerminalHere).toHaveBeenCalledWith("/work");
    });

    it.each([
      ["/C:/Users/qa", "/C:/work/it's a folder", "C:/work/it's a folder"],
      ["/C:/Users/qa", "/D:/projects/example", "D:/projects/example"],
      ["/C:/Users/qa", "/C:", "C:/"],
      ["/C:/Users/qa", "C:/projects/example", "C:/projects/example"],
      ["/home/qa", "/C:/projects/example", "/C:/projects/example"],
    ])("opens SFTP directory %s / %s in the associated shell as %s", async (homeDir, path, expected) => {
      const user = userEvent.setup();
      seedSession({ path });
      useSftpStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [SESSION_ID]: { ...state.sessions[SESSION_ID], homeDir },
        },
      }));
      const onOpenTerminalHere = vi.fn();
      render(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
          onOpenTerminalHere={onOpenTerminalHere}
        />,
      );
      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      await user.click(within(remotePanel).getByTestId("sftp-remote-open-terminal-here"));
      expect(onOpenTerminalHere).toHaveBeenCalledWith(expected);
    });

    it("does not auto-sync the remote pane from a terminal cwd hint on open", () => {
      seedSession();
      render(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
          cwdHint="/terminal"
          cwdHintVersion={1}
        />,
      );

      expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/work");
    });

    it("requests terminal cwd and syncs only after a fresh cwd response", async () => {
      const user = userEvent.setup();
      seedSession();
      const onRequestTerminalCwd = vi.fn(() => true);
      const { rerender } = render(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
          cwdHint={null}
          cwdHintVersion={0}
          onRequestTerminalCwd={onRequestTerminalCwd}
        />,
      );

      await user.click(screen.getByTitle(/Query the terminal cwd/i));
      expect(onRequestTerminalCwd).toHaveBeenCalledTimes(1);
      expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/work");

      rerender(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
          cwdHint="/terminal"
          cwdHintVersion={1}
          onRequestTerminalCwd={onRequestTerminalCwd}
        />,
      );

      await waitFor(() => {
        expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/terminal");
      });
    });

    it("maps a Git Bash cwd to the Windows SFTP namespace only for Windows servers", async () => {
      const user = userEvent.setup();
      seedSession();
      useSftpStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [SESSION_ID]: {
            ...state.sessions[SESSION_ID],
            homeDir: "/C:/Users/test",
            remote: { ...state.sessions[SESSION_ID].remote, path: "/C:/Users/test" },
          },
        },
      }));
      const onRequestTerminalCwd = vi.fn(() => true);
      const { rerender } = render(
        <FileBrowser
          sessionId={SESSION_ID} host="example.com" port={22} username="user"
          authMethod="password" authData={null} cwdHint="/c/old" cwdHintVersion={0}
          onRequestTerminalCwd={onRequestTerminalCwd}
        />,
      );

      await user.click(screen.getByTitle(/Query the terminal cwd/i));
      rerender(
        <FileBrowser
          sessionId={SESSION_ID} host="example.com" port={22} username="user"
          authMethod="password" authData={null} cwdHint="/c/qa-temp/project" cwdHintVersion={1}
          onRequestTerminalCwd={onRequestTerminalCwd}
        />,
      );
      await waitFor(() => {
        expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/C:/qa-temp/project");
      });
    });

    it("consumes a pending terminal upload request through the SFTP browser", async () => {
      seedSession();
      const onHandled = vi.fn();
      render(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
          pendingUploadRequest={{
            id: 7,
            paths: ["/home/me/drop.png"],
            remoteDir: "/srv/app",
          }}
          onPendingUploadRequestHandled={onHandled}
        />,
      );

      await waitFor(() => {
        expect(sftpMocks.sftpStat).toHaveBeenCalledWith(SESSION_ID, "/home/me/drop.png", "local");
        expect(controllerMocks.upload).toHaveBeenCalledWith(
          expect.objectContaining({ path: "/home/me/drop.png", name: "drop.png" }),
          "/srv/app",
        );
        expect(onHandled).toHaveBeenCalledWith(7);
      });
      expect(useSftpStore.getState().sessions[SESSION_ID].remote.path).toBe("/srv/app");
      expect(useSftpStore.getState().sessions[SESSION_ID].local.path).toBe("/home/me");
    });

    it("discards a consumed terminal upload request when the SFTP browser closes", async () => {
      seedSession();
      let finishUpload: (() => void) | undefined;
      controllerMocks.upload.mockImplementationOnce(
        () => new Promise<undefined>((resolve) => {
          finishUpload = () => resolve(undefined);
        }),
      );
      const onHandled = vi.fn();
      const { unmount } = render(
        <FileBrowser
          sessionId={SESSION_ID}
          host="example.com"
          port={22}
          username="user"
          authMethod="password"
          authData={null}
          pendingUploadRequest={{
            id: 8,
            paths: ["/home/me/drop.png"],
            remoteDir: "/work",
          }}
          onPendingUploadRequestHandled={onHandled}
        />,
      );

      await waitFor(() => {
        expect(controllerMocks.upload).toHaveBeenCalledTimes(1);
      });
      expect(onHandled).not.toHaveBeenCalled();

      unmount();

      expect(onHandled).toHaveBeenCalledTimes(1);
      expect(onHandled).toHaveBeenCalledWith(8);

      await act(async () => {
        finishUpload?.();
      });
      expect(onHandled).toHaveBeenCalledTimes(1);
    });

    it("wires the local-pane Upload toolbar button to controller.upload", async () => {
      const user = userEvent.setup();
      seedSession();
      renderBrowser();

      const localBadge = screen.getByText("LOCAL");
      const localPanel = localBadge.closest("div.h-full") as HTMLElement;
      expect(localPanel).toBeTruthy();

      // Sanity: local pane never gets the remote-only buttons even when wired
      // through the real FileBrowser.
      expect(within(localPanel).queryByTitle(/Download selected to local/i)).not.toBeInTheDocument();
      expect(within(localPanel).queryByTitle(/Open terminal at this path/i)).not.toBeInTheDocument();

      await user.click(within(localPanel).getByText("notes.txt"));

      const uploadBtn = within(localPanel).getByTitle(/Upload 1 selected to remote/i);
      expect(uploadBtn).toBeEnabled();
      await user.click(uploadBtn);

      expect(controllerMocks.upload).toHaveBeenCalledTimes(1);
      const uploadArgs = controllerMocks.upload.mock.calls[0] as unknown as unknown[];
      expect(uploadArgs[0]).toMatchObject({
        path: "/work/notes.txt",
      });
    });

    it("double-clicks a local file to open it by default", async () => {
      seedSession();
      renderBrowser();

      const localPanel = screen.getByText("LOCAL").closest("div.h-full") as HTMLElement;
      fireEvent.doubleClick(within(localPanel).getByText("notes.txt"));

      await waitFor(() => {
        expect(sftpMocks.sftpOpenPath).toHaveBeenCalledWith("/work/notes.txt");
      });
      expect(controllerMocks.upload).not.toHaveBeenCalled();
    });

    it("double-clicks a local file to upload when the preference is upload", async () => {
      saveSftpPreferences({ localDoubleClickAction: "upload" });
      seedSession();
      renderBrowser();

      const localPanel = screen.getByText("LOCAL").closest("div.h-full") as HTMLElement;
      fireEvent.doubleClick(within(localPanel).getByText("notes.txt"));

      await waitFor(() => {
        expect(controllerMocks.upload).toHaveBeenCalledWith(
          expect.objectContaining({ path: "/work/notes.txt", name: "notes.txt" }),
          "/work",
        );
      });
      expect(sftpMocks.sftpOpenPath).not.toHaveBeenCalled();
    });

    it("uploads OS-dropped files to the current remote directory", async () => {
      seedSession();
      renderBrowser();

      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      const remoteList = within(remotePanel).getByTestId("sftp-remote-list");
      const image = new File(["image"], "drop.png", { type: "image/png" });
      const dataTransfer = {
        types: ["Files"],
        files: [image],
        dropEffect: "none",
        getData: () => "",
      };

      fireEvent.dragOver(remoteList, { dataTransfer });
      fireEvent.drop(remoteList, { dataTransfer });

      await waitFor(() => {
        expect(controllerMocks.uploadBlob).toHaveBeenCalledWith("/work", image);
      });
      expect(dataTransfer.dropEffect).toBe("copy");
    });

    it("uploads native Tauri dropped file paths to the current remote directory", async () => {
      seedSession();
      renderBrowser();

      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      const remoteList = within(remotePanel).getByTestId("sftp-remote-list");
      const originalElementFromPoint = document.elementFromPoint;
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: vi.fn(() => remoteList),
      });

      try {
        window.dispatchEvent(
          new CustomEvent(NATIVE_FILE_DROP_EVENT, {
            detail: {
              paths: ["/home/me/drop.png"],
              clientX: 10,
              clientY: 10,
            },
          }),
        );

        await waitFor(() => {
          expect(sftpMocks.sftpStat).toHaveBeenCalledWith(SESSION_ID, "/home/me/drop.png", "local");
          expect(controllerMocks.upload).toHaveBeenCalledWith(
            expect.objectContaining({ path: "/home/me/drop.png", name: "drop.png" }),
            "/work",
          );
        });
      } finally {
        Object.defineProperty(document, "elementFromPoint", {
          configurable: true,
          value: originalElementFromPoint,
        });
      }
    });

    it("opens an in-app text dialog for remote New file and creates after confirmation", async () => {
      const user = userEvent.setup();
      const promptSpy = vi.spyOn(window, "prompt").mockImplementation(() => {
        throw new Error("native prompt should not be used");
      });
      seedSession();
      renderBrowser();

      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      await user.click(within(remotePanel).getByTestId("sftp-remote-new-file"));

      expect(screen.getByTestId("text-input-dialog")).toBeInTheDocument();
      const input = screen.getByTestId("text-input-dialog-input");
      await user.clear(input);
      await user.type(input, "remote-created.txt");
      await user.click(screen.getByTestId("text-input-dialog-confirm"));

      expect(controllerMocks.createFile).toHaveBeenCalledWith(
        "/work",
        "remote-created.txt",
        "remote",
      );
      expect(promptSpy).not.toHaveBeenCalled();
      promptSpy.mockRestore();
    });

    it("opens an in-app confirm dialog for remote Delete and removes only after confirmation", async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => {
        throw new Error("native confirm should not be used");
      });
      seedSession();
      renderBrowser();

      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      await user.click(within(remotePanel).getByText("notes.txt"));
      await user.click(within(remotePanel).getByTestId("sftp-remote-delete"));

      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("Delete remote: notes.txt?");
      expect(controllerMocks.remove).not.toHaveBeenCalled();

      await user.click(screen.getByTestId("confirm-dialog-confirm"));

      expect(controllerMocks.remove).toHaveBeenCalledWith("/work/notes.txt", "remote", true);
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("opens remote New folder from the toolbar in Chinese without relying on English menu text", async () => {
      const user = userEvent.setup();
      setLocale("zh-CN");
      seedSession();
      renderBrowser();

      const remotePanel = screen.getByText("REMOTE").closest("div.h-full") as HTMLElement;
      await user.click(within(remotePanel).getByTestId("sftp-remote-new-folder"));

      expect(screen.getByTestId("text-input-dialog")).toBeInTheDocument();
      const input = screen.getByTestId("text-input-dialog-input");
      await user.clear(input);
      await user.type(input, "remote-dir");
      await user.click(screen.getByTestId("text-input-dialog-confirm"));

      expect(controllerMocks.mkdir).toHaveBeenCalledWith("/work", "remote-dir", "remote");
    });

    it("wires the local-pane context Upload action to the full multi-selection", async () => {
      const user = userEvent.setup();
      seedSession();
      renderBrowser();

      const localPanel = screen.getByText("LOCAL").closest("div.h-full") as HTMLElement;
      setSelection("local", ["/work/subdir", "/work/notes.txt"]);

      fireEvent.contextMenu(within(localPanel).getByText("subdir"), {
        clientX: 20,
        clientY: 20,
      });
      await user.click(await screen.findByTestId("context-menu-item-upload-2-selected-to-remote"));

      expect(controllerMocks.upload).toHaveBeenCalledTimes(2);
      const uploadCalls = controllerMocks.upload.mock.calls as unknown as Array<[FileEntry]>;
      expect(uploadCalls.map(([entry]) => entry.path)).toEqual([
        "/work/subdir",
        "/work/notes.txt",
      ]);
    });
  });
}
